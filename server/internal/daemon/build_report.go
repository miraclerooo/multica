package daemon

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Probe only the executable that this daemon would reload. Never search for a
// user-installed agent, run an updater, or infer disk identity from this process.
func (d *Daemon) runtimeBuildReport(ctx context.Context) protocol.RuntimeBuildReport {
	d.buildReportMu.Lock()
	defer d.buildReportMu.Unlock()
	if time.Since(d.buildReportAt) < time.Minute {
		return d.buildReportCache
	}
	report := protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: d.cfg.CLIVersion, Commit: d.cfg.CLICommit, Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: d.cfg.BuildReleaseChannel, UpgradeGuideURL: protocol.SafeUpgradeGuide(d.cfg.BuildUpgradeGuideURL)}, DiskReason: "disk_probe_unavailable", ReloadPendingReason: d.reloadPending()}
	if d.cfg.ReportBuildContract {
		target, err := d.restartTargetBinary()
		if err == nil {
			probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			cmd := exec.CommandContext(probeCtx, target, "version", "--output", "json")
			cmd.WaitDelay = time.Second
			data, probeErr := cmd.Output()
			if probeErr == nil && len(data) <= 65536 {
				var disk protocol.BuildInfo
				if json.Unmarshal(data, &disk) == nil && disk.Version != "" {
					disk.UpgradeGuideURL = protocol.SafeUpgradeGuide(disk.UpgradeGuideURL)
					report.Disk = &disk
					report.DiskReason = ""
				}
			}
		}
	}
	d.buildReportAt = time.Now()
	d.buildReportCache = report
	return report
}
