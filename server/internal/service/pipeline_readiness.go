package service

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type RuntimeCompatibility struct {
	RuntimeID            string              `json:"runtime_id"`
	Name                 string              `json:"name"`
	AgentIDs             []string            `json:"agent_ids"`
	Status               string              `json:"status"`
	Reason               string              `json:"reason"`
	RequiredCapabilities []string            `json:"required_capabilities"`
	MissingCapabilities  []string            `json:"missing_capabilities"`
	Daemon               protocol.BuildInfo  `json:"daemon"`
	Disk                 *protocol.BuildInfo `json:"disk"`
	DiskReason           string              `json:"disk_reason"`
	BuildRelation        string              `json:"build_relation"`
	LoadState            string              `json:"load_state"`
	ReloadPendingReason  string              `json:"reload_pending_reason"`
	ReportedAt           string              `json:"reported_at"`
	UpgradeAction        string              `json:"upgrade_action"`
	UpgradeGuideURL      string              `json:"upgrade_guide_url"`
}
type ExecutionReadiness struct {
	Ready    bool                   `json:"ready"`
	Runtimes []RuntimeCompatibility `json:"runtimes"`
}

func runtimeCompatibility(rt db.AgentRuntime) RuntimeCompatibility {
	out := RuntimeCompatibility{RuntimeID: util.UUIDToString(rt.ID), Name: rt.Name, AgentIDs: []string{}, Status: "unknown", Reason: "build_report_unavailable", RequiredCapabilities: []string{protocol.CapabilityPipelineSelectionV1}, MissingCapabilities: []string{}, DiskReason: "disk_probe_unavailable", BuildRelation: "unknown", UpgradeAction: "channel_not_configured"}
	var metadata struct {
		Report       *protocol.RuntimeBuildReport `json:"build_report"`
		ReportedAt   string                       `json:"build_report_at"`
		CLIVersion   string                       `json:"cli_version"`
		Capabilities []string                     `json:"capabilities"`
	}
	_ = json.Unmarshal(rt.Metadata, &metadata)
	out.ReportedAt = metadata.ReportedAt
	if metadata.Report != nil {
		report := metadata.Report
		out.Daemon, out.Disk, out.DiskReason, out.ReloadPendingReason = report.Daemon, report.Disk, report.DiskReason, report.ReloadPendingReason
		out.Daemon.UpgradeGuideURL = protocol.SafeUpgradeGuide(out.Daemon.UpgradeGuideURL)
		if out.Disk != nil {
			out.Disk.UpgradeGuideURL = protocol.SafeUpgradeGuide(out.Disk.UpgradeGuideURL)
			out.BuildRelation = protocol.BuildRelation(*out.Disk, out.Daemon)
		}
	} else {
		out.Daemon = protocol.BuildInfo{Version: metadata.CLIVersion, Capabilities: metadata.Capabilities, ReleaseChannel: "unknown"}
		if strings.Contains(metadata.CLIVersion, "-ipoke.") {
			out.Daemon.ReleaseChannel = "ipoke"
		}
	}
	out.LoadState = "unknown"
	if out.Disk == nil && out.DiskReason == "" {
		out.DiskReason = "disk_probe_unavailable"
	}
	if out.BuildRelation == "same" {
		out.LoadState = "loaded"
	}
	if out.BuildRelation == "different_build" || out.BuildRelation == "newer" || out.BuildRelation == "older" || out.ReloadPendingReason != "" {
		out.LoadState = "pending"
	}
	if out.Daemon.Supports(protocol.CapabilityPipelineSelectionV1) {
		out.Status = "supported"
		out.Reason = "capability_reported"
		if out.Disk == nil || out.Disk.Capabilities == nil {
			out.Status = "unknown"
			out.Reason = "installed_cli_capability_unknown"
		} else if !out.Disk.Supports(protocol.CapabilityPipelineSelectionV1) {
			out.Status = "insufficient"
			out.Reason = "installed_cli_capability_missing"
			out.MissingCapabilities = out.RequiredCapabilities
		}
	} else if out.Daemon.Capabilities != nil {
		out.Status = "insufficient"
		out.Reason = "required_capability_missing"
		out.MissingCapabilities = out.RequiredCapabilities
	}
	if !out.Daemon.Supports(protocol.CapabilityPipelineSelectionV1) && out.Daemon.Capabilities != nil && out.Disk != nil && out.Disk.Supports(protocol.CapabilityPipelineSelectionV1) {
		out.Status = "daemon_pending"
		out.Reason = "installed_build_not_loaded"
		out.LoadState = "pending"
		if out.ReloadPendingReason == "" {
			out.ReloadPendingReason = "daemon has not loaded the installed build; recheck after the runtime is idle"
		}
	}
	if metadata.Report != nil {
		at, e := time.Parse(time.RFC3339Nano, metadata.ReportedAt)
		if e != nil || time.Since(at) > 2*time.Minute {
			out.Status = "unknown"
			out.Reason = "build_report_stale"
		}
	}
	if rt.Status != "online" {
		out.Status = "unknown"
		out.Reason = "runtime_offline"
	}
	guide := protocol.SafeUpgradeGuide(out.Daemon.UpgradeGuideURL)
	if out.Daemon.ReleaseChannel == "official" {
		out.UpgradeAction = "official_update"
	} else if guide != "" {
		out.UpgradeAction = "deployment_guide"
		out.UpgradeGuideURL = guide
	}
	if out.Status == "daemon_pending" {
		out.UpgradeAction = "wait_idle_and_recheck"
	}
	if rt.Status != "online" {
		out.UpgradeAction = "wait_online_and_recheck"
	}
	return out
}

func (s *PipelineService) ExecutionReadiness(ctx context.Context, q *db.Queries, ws string, bindings map[string]string) (ExecutionReadiness, error) {
	out := ExecutionReadiness{Ready: true, Runtimes: []RuntimeCompatibility{}}
	byRuntime := map[string]*RuntimeCompatibility{}
	seen := map[string]bool{}
	for job, id := range bindings {
		if len(job) >= 6 && job[:6] == "owner:" {
			continue
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		a, err := q.GetAgent(ctx, pipelineUUID(id))
		if err != nil || util.UUIDToString(a.WorkspaceID) != ws || a.ArchivedAt.Valid {
			return out, pipeline.Fail("role_unbound", "executor is unavailable")
		}
		rid := util.UUIDToString(a.RuntimeID)
		if p := byRuntime[rid]; p != nil {
			p.AgentIDs = append(p.AgentIDs, id)
			continue
		}
		c := RuntimeCompatibility{RuntimeID: rid, AgentIDs: []string{id}, Status: "unknown", Reason: "runtime_unavailable", RequiredCapabilities: []string{protocol.CapabilityPipelineSelectionV1}, MissingCapabilities: []string{}, DiskReason: "disk_probe_unavailable", BuildRelation: "unknown", LoadState: "unknown", UpgradeAction: "channel_not_configured"}
		if a.RuntimeID.Valid {
			rt, e := (RuntimeLookup{Queries: q, Source: "task"}).Get(ctx, a.RuntimeID)
			if e != nil {
				return out, e
			}
			if util.UUIDToString(rt.WorkspaceID) != ws {
				return out, pipeline.Fail("invocation_forbidden", "runtime is not available in this workspace")
			}
			c = runtimeCompatibility(rt)
			c.AgentIDs = []string{id}
		}
		byRuntime[rid] = &c
	}
	keys := make([]string, 0, len(byRuntime))
	for id := range byRuntime {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		c := *byRuntime[id]
		sort.Strings(c.AgentIDs)
		if c.Status != "supported" {
			out.Ready = false
		}
		out.Runtimes = append(out.Runtimes, c)
	}
	return out, nil
}
