package ghsnapshot

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRepositoryArtifactPinsMovingBranch(t *testing.T) {
	sha := strings.Repeat("a", 40)
	reads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/access_tokens"):
			w.WriteHeader(201)
			fmt.Fprintf(w, `{"token":"fake-installation-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case r.URL.Path == "/repos/org/repo/commits/main":
			fmt.Fprintf(w, `{"sha":%q}`, sha)
		case strings.HasPrefix(r.URL.Path, "/repos/org/repo/contents/"):
			reads++
			if r.URL.Query().Get("ref") != sha {
				t.Error("content followed a mutable branch")
			}
			_, _ = w.Write([]byte(`{"type":"file","encoding":"base64","content":"cmVwb3J0Cg=="}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client := newTestClient(t, server.URL)
	got, data, err := client.RepositoryFile(context.Background(), 42, "org/repo", "reports/context.md", "main")
	if err != nil || got != sha || string(data) != "report\n" || reads != 1 {
		t.Fatalf("pinning failed: %q %q %v", got, data, err)
	}
	for _, repo := range []string{"https://evil.example/repo", "org/repo/../../private"} {
		if _, _, err = client.RepositoryFile(context.Background(), 42, repo, "report.md", "main"); err == nil {
			t.Fatal("arbitrary repository address accepted")
		}
	}
}
