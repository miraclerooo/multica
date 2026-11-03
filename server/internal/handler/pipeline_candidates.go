package handler

import (
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/pipeline"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Candidate identities are user/agent IDs, never squad role labels. Workspace
// membership grants notification eligibility, not permission to approve a run.
func (h *Handler) PipelineCandidates(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, r.URL.Query().Get("squad_id"), "squad_id")
	if !ok {
		return
	}
	squad, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: id, WorkspaceID: member.WorkspaceID})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if squad.ArchivedAt.Valid {
		writePipelineError(w, pipeline.Fail("squad_archived", "squad is archived"))
		return
	}
	people, err := h.Queries.ListMembersWithUser(r.Context(), member.WorkspaceID)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	humans := []map[string]any{}
	var current map[string]any
	search := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("search")))
	for _, p := range people {
		v := map[string]any{"user_id": uuidToString(p.UserID), "member_id": uuidToString(p.ID), "name": p.UserName}
		if p.UserID == member.UserID {
			current = v
		}
		if search == "" || strings.Contains(strings.ToLower(p.UserName), search) {
			humans = append(humans, v)
		}
	}
	if current == nil {
		writePipelineError(w, pipeline.Fail("owner_unavailable", "current authenticated human is unavailable"))
		return
	}
	members, err := h.Queries.ListSquadMembers(r.Context(), squad.ID)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	agents := []map[string]any{}
	for _, m := range members {
		if m.MemberType != "agent" {
			continue
		}
		a, e := h.Queries.GetAgent(r.Context(), m.MemberID)
		if e != nil || a.WorkspaceID != member.WorkspaceID {
			continue
		}
		reason := ""
		if a.ArchivedAt.Valid {
			reason = "agent_archived"
		} else if h.Pipelines.CanInvoke == nil || !h.Pipelines.CanInvoke(r.Context(), a, uuidToString(member.UserID), ws) {
			reason = "invocation_forbidden"
		}
		if search == "" || strings.Contains(strings.ToLower(a.Name), search) {
			agents = append(agents, map[string]any{"agent_id": uuidToString(a.ID), "name": a.Name, "role": m.Role, "can_invoke": reason == "", "reason": reason, "is_leader": a.ID == squad.LeaderID})
		}
	}
	writeJSON(w, 200, map[string]any{"squad_id": uuidToString(squad.ID), "current_user": current, "default_owner_user_id": uuidToString(member.UserID), "leader_id": uuidToString(squad.LeaderID), "humans": humans, "agents": agents})
}
