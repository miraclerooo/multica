package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRuntimeBuildReportSeparatesDiskProcessAndNeverRestarts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake executable")
	}
	originalResolve, originalBrew := resolveSelfExecutable, isBrewInstall
	t.Cleanup(func() { resolveSelfExecutable = originalResolve; isBrewInstall = originalBrew })
	path := filepath.Join(t.TempDir(), "multica")
	resolveSelfExecutable = func() (string, error) { return path, nil }
	isBrewInstall = func() bool { return false }
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte("#!/bin/sh\n[ \"$1\" = version ] && [ \"$2\" = --output ] && [ \"$3\" = json ] || exit 99\nprintf '%s' '"+body+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"version":"0.7.2-ipoke.new","commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","capabilities":["pipeline-task-selection-v1"],"release_channel":"ipoke"}`)
	d := &Daemon{cfg: Config{CLIVersion: "0.7.2-ipoke.loaded", CLICommit: strings.Repeat("a", 40), BuildReleaseChannel: "ipoke", ReportBuildContract: true}, logger: slog.Default()}
	d.cancelFunc = func() { t.Fatal("report restarted the daemon") }
	d.activeTasks.Store(1)
	d.setReloadPending("in-flight task; waiting for idle")
	report := d.runtimeBuildReport(context.Background())
	if report.Daemon.Version != "0.7.2-ipoke.loaded" || report.Daemon.Commit != strings.Repeat("a", 40) || report.Disk == nil || report.Disk.Version != "0.7.2-ipoke.new" || report.ReloadPendingReason == "" {
		t.Fatalf("incorrect process/disk identity %+v", report)
	}
	write("not json")
	d.buildReportAt = time.Time{}
	report = d.runtimeBuildReport(context.Background())
	if report.Disk != nil || report.DiskReason != "disk_probe_unavailable" || report.Daemon.Version != "0.7.2-ipoke.loaded" {
		t.Fatal("unknown disk replaced with daemon identity")
	}
}
