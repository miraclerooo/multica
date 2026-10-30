package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
	"github.com/redis/go-redis/v9"
)

const directoryRequestLifetime = time.Minute
const directoryRequestRetention = 2 * time.Minute

type DirectoryBrowseRequest struct {
	ID          string                        `json:"id"`
	RuntimeID   string                        `json:"runtime_id"`
	DaemonID    string                        `json:"daemon_id"`
	WorkspaceID string                        `json:"workspace_id"`
	CreatorID   string                        `json:"creator_id"`
	Status      string                        `json:"status"`
	CreatedAt   time.Time                     `json:"created_at"`
	Input       protocol.DirectoryBrowseInput `json:"input"`
	protocol.DirectoryBrowseReport
}

// Redis is used in deployed servers; the memory implementation supports local
// single-node development and tests, matching the other runtime request stores.
type DirectoryBrowseStore struct {
	rdb      redis.UniversalClient
	mu       sync.Mutex
	requests map[string]*DirectoryBrowseRequest
}

func NewDirectoryBrowseStore(rdb redis.UniversalClient) *DirectoryBrowseStore {
	return &DirectoryBrowseStore{rdb: rdb, requests: make(map[string]*DirectoryBrowseRequest)}
}

func directoryRequestKey(id string) string {
	return "mul:" + runtimePendingRedisHashTag + ":directories:" + id
}

func validDirectoryRequestID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}
func directoryPendingKey(id string) string { return directoryRequestKey("pending:" + id) }

func (s *DirectoryBrowseStore) Create(ctx context.Context, request DirectoryBrowseRequest) (*DirectoryBrowseRequest, error) {
	request.ID, request.Status, request.CreatedAt = randomID(), "pending", time.Now()
	if s.rdb == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		for id, old := range s.requests {
			if time.Since(old.CreatedAt) > directoryRequestRetention {
				delete(s.requests, id)
			}
		}
		s.requests[request.ID] = &request
		return cloneDirectoryRequest(&request), nil
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, directoryRequestKey(request.ID), data, directoryRequestRetention)
	pipe.ZAdd(ctx, directoryPendingKey(request.RuntimeID), redis.Z{Score: float64(request.CreatedAt.UnixMilli()), Member: request.ID})
	pipe.Expire(ctx, directoryPendingKey(request.RuntimeID), directoryRequestRetention)
	if _, err := pipe.Exec(ctx); err != nil {
		_ = s.rdb.Del(ctx, directoryRequestKey(request.ID)).Err()
		_ = s.rdb.ZRem(ctx, directoryPendingKey(request.RuntimeID), request.ID).Err()
		return nil, err
	}
	return &request, nil
}

func cloneDirectoryRequest(request *DirectoryBrowseRequest) *DirectoryBrowseRequest {
	if request == nil {
		return nil
	}
	out := *request
	if request.Result != nil {
		result := *request.Result
		result.Entries = append([]protocol.DirectoryBrowseEntry(nil), result.Entries...)
		out.Result = &result
	}
	if (out.Status == "pending" || out.Status == "running") && time.Since(out.CreatedAt) > directoryRequestLifetime {
		out.Status, out.Error = "timeout", "directory request timed out"
	}
	return &out
}

func (s *DirectoryBrowseStore) Get(ctx context.Context, id string) (*DirectoryBrowseRequest, error) {
	if s.rdb == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return cloneDirectoryRequest(s.requests[id]), nil
	}
	data, err := s.rdb.Get(ctx, directoryRequestKey(id)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var request DirectoryBrowseRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return nil, err
	}
	return cloneDirectoryRequest(&request), nil
}

func (s *DirectoryBrowseStore) HasPending(ctx context.Context, runtimeID string) (bool, error) {
	if s.rdb == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, request := range s.requests {
			if request.RuntimeID == runtimeID && cloneDirectoryRequest(request).Status == "pending" {
				return true, nil
			}
		}
		return false, nil
	}
	count, err := s.rdb.ZCard(ctx, directoryPendingKey(runtimeID)).Result()
	return count > 0, err
}

func (s *DirectoryBrowseStore) PopPending(ctx context.Context, runtimeID string) (*DirectoryBrowseRequest, error) {
	if s.rdb == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		var oldest *DirectoryBrowseRequest
		for _, request := range s.requests {
			if request.RuntimeID == runtimeID && cloneDirectoryRequest(request).Status == "pending" && (oldest == nil || request.CreatedAt.Before(oldest.CreatedAt)) {
				oldest = request
			}
		}
		if oldest == nil {
			return nil, nil
		}
		oldest.Status = "running"
		return cloneDirectoryRequest(oldest), nil
	}
	pendingKey := directoryPendingKey(runtimeID)
	for attempt := 0; attempt < 5; attempt++ {
		ids, err := s.rdb.ZRange(ctx, pendingKey, 0, 0).Result()
		if err != nil || len(ids) == 0 {
			return nil, err
		}
		request, err := s.Get(ctx, ids[0])
		if err != nil {
			return nil, err
		}
		if request == nil || request.Status != "pending" {
			if err := s.rdb.ZRem(ctx, pendingKey, ids[0]).Err(); err != nil {
				return nil, err
			}
			continue
		}
		request.Status = "running"
		data, err := json.Marshal(request)
		if err != nil {
			return nil, err
		}
		won, err := claimPendingScript.Run(ctx, s.rdb, []string{pendingKey, directoryRequestKey(request.ID)}, request.ID, data, int(directoryRequestRetention.Seconds())).Int()
		if err != nil {
			return nil, err
		}
		if won == 1 {
			return request, nil
		}
	}
	return nil, nil
}

var completeDirectoryRequestScript = redis.NewScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.status ~= 'running' then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`)

func (s *DirectoryBrowseStore) Complete(ctx context.Context, id string, report protocol.DirectoryBrowseReport) error {
	if s.rdb == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		request := s.requests[id]
		if request == nil || cloneDirectoryRequest(request).Status != "running" {
			return nil
		}
		request.DirectoryBrowseReport = report
		request.Status = "completed"
		if report.Error != "" {
			request.Status = "failed"
		}
		return nil
	}
	request, err := s.Get(ctx, id)
	if err != nil || request == nil || request.Status != "running" {
		return err
	}
	request.DirectoryBrowseReport, request.Status = report, "completed"
	if report.Error != "" {
		request.Status = "failed"
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	return completeDirectoryRequestScript.Run(ctx, s.rdb, []string{directoryRequestKey(id)}, data, int(directoryRequestRetention.Seconds())).Err()
}

func (h *Handler) requireDirectoryBrowseOwner(w http.ResponseWriter, r *http.Request) (db.AgentRuntime, string, bool) {
	rt, member, ok := h.requireRuntimeReadAccess(w, r, obsmetrics.RuntimeLookupSourceRuntimeAPI, chi.URLParam(r, "runtimeId"))
	if !ok {
		return db.AgentRuntime{}, "", false
	}
	userID := uuidToString(member.UserID)
	if userID == "" || uuidToString(rt.OwnerID) != userID {
		writeError(w, http.StatusForbidden, "only the machine owner can browse its directories")
		return db.AgentRuntime{}, "", false
	}
	return rt, userID, true
}

func (h *Handler) InitiateDirectoryBrowse(w http.ResponseWriter, r *http.Request) {
	rt, userID, ok := h.requireDirectoryBrowseOwner(w, r)
	if !ok {
		return
	}
	if !rt.DaemonID.Valid || rt.DaemonID.String == "" || rt.RuntimeMode == "cloud" {
		writeError(w, http.StatusUnprocessableEntity, "directory browsing requires a local machine")
		return
	}
	if rt.Status != "online" {
		writeError(w, http.StatusServiceUnavailable, "machine is offline")
		return
	}
	if !runtimeHasCapability(rt.Metadata, protocol.DaemonCapabilityDirectoryBrowseV1) {
		writeError(w, http.StatusUnprocessableEntity, "update the machine's Multica runtime to choose directories")
		return
	}
	var input protocol.DirectoryBrowseInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid directory request")
		return
	}
	if (input.Operation != "roots" && input.Operation != "list" && input.Operation != "validate") || len(input.Path) > 4096 || (input.Operation != "roots" && !isAbsoluteLocalPath(input.Path)) {
		writeError(w, http.StatusBadRequest, "invalid directory operation or absolute path")
		return
	}
	request, err := h.DirectoryBrowseStore.Create(r.Context(), DirectoryBrowseRequest{
		RuntimeID: uuidToString(rt.ID), DaemonID: rt.DaemonID.String, WorkspaceID: uuidToString(rt.WorkspaceID), CreatorID: userID, Input: input,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to enqueue directory request")
		return
	}
	h.requestDaemonPendingWork(request.RuntimeID, protocol.PendingWorkKindDirectories)
	writeJSON(w, http.StatusAccepted, request)
}

func (h *Handler) GetDirectoryBrowse(w http.ResponseWriter, r *http.Request) {
	rt, userID, ok := h.requireDirectoryBrowseOwner(w, r)
	if !ok {
		return
	}
	requestID := chi.URLParam(r, "requestId")
	if !validDirectoryRequestID(requestID) {
		writeError(w, http.StatusBadRequest, "invalid request_id")
		return
	}
	request, err := h.DirectoryBrowseStore.Get(r.Context(), requestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load directory request")
		return
	}
	if request == nil || request.RuntimeID != uuidToString(rt.ID) || request.DaemonID != rt.DaemonID.String || request.WorkspaceID != uuidToString(rt.WorkspaceID) || request.CreatorID != userID {
		writeError(w, http.StatusNotFound, "directory request not found")
		return
	}
	writeJSON(w, http.StatusOK, request)
}

func (h *Handler) ReportDirectoryBrowse(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	requestID := chi.URLParam(r, "requestId")
	if !validDirectoryRequestID(requestID) {
		writeError(w, http.StatusBadRequest, "invalid request_id")
		return
	}
	request, err := h.DirectoryBrowseStore.Get(r.Context(), requestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load directory request")
		return
	}
	if request == nil || request.RuntimeID != uuidToString(rt.ID) || request.DaemonID != rt.DaemonID.String || request.WorkspaceID != uuidToString(rt.WorkspaceID) {
		writeError(w, http.StatusNotFound, "directory request not found")
		return
	}
	var report protocol.DirectoryBrowseReport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&report); err != nil || (report.Result == nil && report.Error == "") || (report.Result != nil && len(report.Result.Entries) > protocol.DirectoryBrowseMaxEntries) {
		writeError(w, http.StatusBadRequest, "invalid directory result")
		return
	}
	if err := h.DirectoryBrowseStore.Complete(r.Context(), request.ID, report); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save directory result")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
