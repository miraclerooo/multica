package protocol

import (
	"strings"
	"testing"
)

func TestBuildRelationUsesReleaseSemanticsAndCommitIdentity(t *testing.T) {
	for _, tt := range []struct {
		name         string
		disk, loaded BuildInfo
		want         string
	}{
		{"semantic", BuildInfo{Version: "0.10.0", ReleaseChannel: "official"}, BuildInfo{Version: "0.9.0", ReleaseChannel: "official"}, "newer"},
		{"prerelease", BuildInfo{Version: "v1.0.0-rc.2", ReleaseChannel: "official"}, BuildInfo{Version: "v1.0.0-rc.10", ReleaseChannel: "official"}, "older"},
		{"custom commits unordered", BuildInfo{Version: "0.7.2-ipoke.zzz", Commit: strings.Repeat("a", 40)}, BuildInfo{Version: "0.7.2-ipoke.aaa", Commit: strings.Repeat("b", 40)}, "different_build"},
		{"same tree", BuildInfo{Version: "new-label", Commit: strings.Repeat("a", 40)}, BuildInfo{Version: "old-label", Commit: strings.Repeat("a", 40)}, "same"},
		{"missing", BuildInfo{}, BuildInfo{Version: "0.7.2"}, "unknown"},
		{"same unknown", BuildInfo{Version: "unknown"}, BuildInfo{Version: "unknown"}, "unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := BuildRelation(tt.disk, tt.loaded); got != tt.want {
				t.Fatalf("got %s want %s", got, tt.want)
			}
		})
	}
}

func TestUpgradeGuideCannotDiscloseCredentials(t *testing.T) {
	for _, raw := range []string{"https://owner:secret@example.test/upgrade", "https://example.test/upgrade?token=secret", "file:///machine/upgrade", "javascript:alert(1)", "http://example.test/upgrade"} {
		if got := SafeUpgradeGuide(raw); got != "" {
			t.Fatalf("unsafe guide accepted: %s", got)
		}
	}
	if got := SafeUpgradeGuide("https://deployment.example.test/releases/upgrade"); got == "" {
		t.Fatal("deployment guide rejected")
	}
}
