package handler

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestDirectoryBrowseStoreClaimsAndTerminalResults(t *testing.T) {
	ctx := context.Background()
	store := NewDirectoryBrowseStore(nil)
	request, err := store.Create(ctx, DirectoryBrowseRequest{RuntimeID: "machine-a", Input: protocol.DirectoryBrowseInput{Operation: "list", Path: "/projects"}})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := store.PopPending(ctx, "machine-b"); err != nil || got != nil {
		t.Fatalf("cross-machine claim: %v %v", got, err)
	}
	var claims atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got, err := store.PopPending(ctx, "machine-a"); err == nil && got != nil {
				claims.Add(1)
			}
		}()
	}
	wg.Wait()
	if claims.Load() != 1 {
		t.Fatalf("claimed %d times", claims.Load())
	}
	if err := store.Complete(ctx, request.ID, protocol.DirectoryBrowseReport{Result: &protocol.DirectoryBrowseResult{Path: "/projects"}}); err != nil {
		t.Fatal(err)
	}
	_ = store.Complete(ctx, request.ID, protocol.DirectoryBrowseReport{Error: "late duplicate"})
	got, _ := store.Get(ctx, request.ID)
	if got.Status != "completed" || got.Error != "" {
		t.Fatalf("late report overwrote result: %+v", got)
	}
	expired, _ := store.Create(ctx, DirectoryBrowseRequest{RuntimeID: "machine-a"})
	store.mu.Lock()
	store.requests[expired.ID].CreatedAt = time.Now().Add(-2 * directoryRequestLifetime)
	store.mu.Unlock()
	got, _ = store.Get(ctx, expired.ID)
	if got.Status != "timeout" {
		t.Fatalf("expired request stayed %s", got.Status)
	}
	if got, _ := store.PopPending(ctx, "machine-a"); got != nil {
		t.Fatal("expired request was dispatched")
	}
}

func TestDirectoryBrowseRedisAcrossNodes(t *testing.T) {
	rdb := newRedisTestClient(t)
	a, b := NewDirectoryBrowseStore(rdb), NewDirectoryBrowseStore(rdb)
	ctx := context.Background()
	request, err := a.Create(ctx, DirectoryBrowseRequest{RuntimeID: "rt-a", CreatorID: "owner", Input: protocol.DirectoryBrowseInput{Operation: "roots"}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := b.PopPending(ctx, "rt-a")
	if err != nil || claimed == nil || claimed.ID != request.ID {
		t.Fatalf("cross-node claim: %+v %v", claimed, err)
	}
	if again, _ := a.PopPending(ctx, "rt-a"); again != nil {
		t.Fatal("duplicate claim")
	}
	if err := b.Complete(ctx, request.ID, protocol.DirectoryBrowseReport{Result: &protocol.DirectoryBrowseResult{Entries: []protocol.DirectoryBrowseEntry{{Name: "projects", Path: "/projects"}}}}); err != nil {
		t.Fatal(err)
	}
	got, err := a.Get(ctx, request.ID)
	if err != nil || got.Status != "completed" || got.Result.Entries[0].Path != "/projects" {
		t.Fatalf("result unavailable on other node: %+v %v", got, err)
	}
}

func TestDirectoryBrowseOwnerAndRequestIsolation(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	ownerID := fx.User(t, "Directory owner", fmt.Sprintf("directory-%d@test.invalid", time.Now().UnixNano()))
	fx.Member(t, testWorkspaceID, ownerID, "member")
	newRuntime := func(daemonID string) string {
		return fx.Insert(t, "agent_runtime", testutil.Cols{
			"workspace_id": testWorkspaceID, "owner_id": ownerID, "daemon_id": daemonID,
			"name": daemonID, "runtime_mode": "local", "provider": "codex", "status": "online",
			"visibility": "public", "metadata": `{"capabilities":["directory-browse-v1"]}`,
			"last_seen_at": testutil.Raw("now()"),
		})
	}
	runtimeID, otherRuntimeID := newRuntime("directory-a"), newRuntime("directory-b")
	makeRequest := func(userID, method, runtime, requestID string, body any) *http.Request {
		req := newRequestAsUser(userID, method, "/directories", body)
		return testutil.WithURLParams(req, "runtimeId", runtime, "requestId", requestID)
	}
	input := protocol.DirectoryBrowseInput{Operation: "list", Path: "/projects"}
	// The workspace owner can see this public runtime, but cannot enumerate
	// another member's filesystem.
	testutil.Call(t, testHandler.InitiateDirectoryBrowse, makeRequest(testUserID, "POST", runtimeID, "", input)).Want(http.StatusForbidden)
	var request DirectoryBrowseRequest
	testutil.Call(t, testHandler.InitiateDirectoryBrowse, makeRequest(ownerID, "POST", runtimeID, "", input)).Want(http.StatusAccepted).JSON(&request)
	if request.CreatorID != ownerID || request.DaemonID != "directory-a" {
		t.Fatalf("lost request binding: %+v", request)
	}
	testutil.Call(t, testHandler.GetDirectoryBrowse, makeRequest(testUserID, "GET", runtimeID, request.ID, nil)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.GetDirectoryBrowse, makeRequest(ownerID, "GET", otherRuntimeID, request.ID, nil)).Want(http.StatusNotFound)
	ack, _, err := testHandler.processHeartbeat(context.Background(), runtimeID, false)
	if err != nil || ack.PendingDirectoryBrowse == nil || ack.PendingDirectoryBrowse.ID != request.ID {
		t.Fatalf("heartbeat did not deliver request: %+v %v", ack, err)
	}
	report := protocol.DirectoryBrowseReport{Result: &protocol.DirectoryBrowseResult{Path: "/projects", Entries: []protocol.DirectoryBrowseEntry{{Name: "app", Path: "/projects/app"}}}}
	testutil.Call(t, testHandler.ReportDirectoryBrowse, makeRequest(ownerID, "POST", otherRuntimeID, request.ID, report)).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.ReportDirectoryBrowse, makeRequest(ownerID, "POST", runtimeID, request.ID, report)).Want(http.StatusOK)
	testutil.Call(t, testHandler.GetDirectoryBrowse, makeRequest(ownerID, "GET", runtimeID, request.ID, nil)).Want(http.StatusOK).JSON(&request)
	if request.Status != "completed" || request.Result.Entries[0].Path != "/projects/app" {
		t.Fatalf("wrong directory result: %+v", request)
	}
	testutil.Call(t, testHandler.InitiateDirectoryBrowse, makeRequest(ownerID, "POST", runtimeID, "", protocol.DirectoryBrowseInput{Operation: "list", Path: "../private"})).Want(http.StatusBadRequest)
	fx.Exec(t, "UPDATE agent_runtime SET metadata = '{}'::jsonb WHERE id = $1", runtimeID)
	testutil.Call(t, testHandler.InitiateDirectoryBrowse, makeRequest(ownerID, "POST", runtimeID, "", input)).Want(http.StatusUnprocessableEntity)
}
