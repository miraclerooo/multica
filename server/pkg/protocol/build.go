package protocol

import (
	"net/url"
	"slices"
	"strings"

	"golang.org/x/mod/semver"
)

// This capability includes the CLI selection commands and the daemon's build
// report. It is deliberately not inferred from an older release number.
const CapabilityPipelineSelectionV1 = "pipeline-task-selection-v1"
const CapabilityPipelineCatalogV1 = "pipeline-catalog-v1"
const CapabilityRuntimeBuildReportV1 = "runtime-build-report-v1"

type BuildInfo struct {
	Version         string   `json:"version"`
	Commit          string   `json:"commit"`
	BuildCommit     string   `json:"build_commit,omitempty"`
	Capabilities    []string `json:"capabilities"`
	ReleaseChannel  string   `json:"release_channel"`
	UpgradeGuideURL string   `json:"upgrade_guide_url,omitempty"`
}

type RuntimeBuildReport struct {
	Daemon              BuildInfo  `json:"daemon"`
	Disk                *BuildInfo `json:"disk"`
	DiskReason          string     `json:"disk_reason"`
	ReloadPendingReason string     `json:"reload_pending_reason"`
}

func PipelineClientCapabilities() []string {
	return []string{CapabilityPipelineSelectionV1, CapabilityPipelineCatalogV1, CapabilityRuntimeBuildReportV1}
}

func (b BuildInfo) Supports(capability string) bool {
	return slices.Contains(b.Capabilities, capability)
}

// A guide may be displayed to another member. Never forward signed URLs,
// credentials, arbitrary shell commands, or a non-HTTP scheme from config.
func SafeUpgradeGuide(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return u.String()
}

// BuildRelation compares released semvers, including prereleases. Custom
// commit builds have no chronological ordering: equality is established by
// the full build revision, never lexicographic comparison of a SHA suffix.
func BuildRelation(disk, loaded BuildInfo) string {
	if disk.BuildCommit != "" {
		disk.Commit = disk.BuildCommit
	}
	if loaded.BuildCommit != "" {
		loaded.Commit = loaded.BuildCommit
	}
	validCommit := func(v string) bool { return len(v) == 40 && strings.Trim(v, "0123456789abcdef") == "" }
	if validCommit(disk.Commit) && validCommit(loaded.Commit) {
		if disk.Commit == loaded.Commit {
			return "same"
		}
		return "different_build"
	}
	if disk.Version == "" || loaded.Version == "" || disk.Version == "unknown" || loaded.Version == "unknown" {
		return "unknown"
	}
	if disk.Version == loaded.Version {
		if semver.IsValid("v" + strings.TrimPrefix(disk.Version, "v")) {
			return "same_version"
		}
		return "unknown"
	}
	if disk.ReleaseChannel == "official" && loaded.ReleaseChannel == "official" {
		a, b := "v"+strings.TrimPrefix(disk.Version, "v"), "v"+strings.TrimPrefix(loaded.Version, "v")
		if semver.IsValid(a) && semver.IsValid(b) {
			if semver.Compare(a, b) > 0 {
				return "newer"
			}
			return "older"
		}
	}
	return "different_build"
}
