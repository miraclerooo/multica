package main

import (
	"os"
	"strings"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Publishers may embed these values. A custom build never silently inherits
// the official updater; the daemon also accepts explicit deployment config.
var releaseChannel = "unknown"
var upgradeGuideURL = ""

func currentBuildInfo() protocol.BuildInfo {
	channel := releaseChannel
	if v := os.Getenv("MULTICA_RELEASE_CHANNEL"); v != "" {
		channel = v
	}
	if channel == "unknown" && strings.Contains(version, "-ipoke.") {
		channel = "ipoke"
	}
	guide := upgradeGuideURL
	if v := os.Getenv("MULTICA_UPGRADE_GUIDE_URL"); v != "" {
		guide = v
	}
	return protocol.BuildInfo{Version: version, Commit: buildCommit, Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: channel, UpgradeGuideURL: protocol.SafeUpgradeGuide(guide)}
}
