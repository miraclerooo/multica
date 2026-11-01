package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (h *Handler) DaemonBuildReport(w http.ResponseWriter, r *http.Request) {
	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}
	var report protocol.RuntimeBuildReport
	if !decodePipelineBody(w, r, &report) {
		return
	}
	report.Daemon.UpgradeGuideURL = protocol.SafeUpgradeGuide(report.Daemon.UpgradeGuideURL)
	if report.Disk != nil {
		report.Disk.UpgradeGuideURL = protocol.SafeUpgradeGuide(report.Disk.UpgradeGuideURL)
	}
	data, _ := json.Marshal(map[string]any{"build_report": report, "build_report_at": time.Now().UTC().Format(time.RFC3339Nano)})
	if err := h.Queries.SaveRuntimeBuildReport(r.Context(), db.SaveRuntimeBuildReportParams{ID: rt.ID, WorkspaceID: rt.WorkspaceID, Report: data}); err != nil {
		writeError(w, 500, "could not save build report")
		return
	}
	writeJSON(w, 200, map[string]bool{"saved": true})
}
