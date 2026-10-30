package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestBrowseLocalDirectories(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "project")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "private.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	list, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: "list", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Entries) != 1 || list.Entries[0].Path != child {
		t.Fatalf("expected directories only: %+v", list)
	}
	if list.Parent != filepath.Dir(root) {
		t.Fatalf("wrong parent: %+v", list)
	}
	selected, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: "validate", Path: child})
	if err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(child)
	if selected.Path != child || selected.RealPath != real {
		t.Fatalf("wrong selection: %+v", selected)
	}
}

func TestBrowseNavigationDoesNotAllowSelectingHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if _, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: "list", Path: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: "validate", Path: home}); err == nil {
		t.Fatal("home must not be selectable")
	}
	link := filepath.Join(t.TempDir(), "home-link")
	if err := os.Symlink(home, link); err != nil {
		t.Skip(err)
	}
	if _, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: "validate", Path: link}); err == nil {
		t.Fatal("symlink to home must not bypass validation")
	}
}

func TestBrowseRejectsRelativePathAndCancelledContext(t *testing.T) {
	for _, operation := range []string{"list", "validate"} {
		if _, err := browseLocalDirectories(context.Background(), protocol.DirectoryBrowseInput{Operation: operation, Path: "./project"}); err == nil {
			t.Fatal("relative path accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := browseLocalDirectories(ctx, protocol.DirectoryBrowseInput{Operation: "roots"}); err == nil {
		t.Fatal("cancelled request continued")
	}
}

func TestDirectoryBrowseHintRequestsRealFilesystem(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "private.txt"), []byte("not directory data"), 0600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	queue := []protocol.PendingDirectoryBrowse{{
		ID:                   strings.Repeat("a", 32),
		DirectoryBrowseInput: protocol.DirectoryBrowseInput{Operation: "list", Path: root},
	}}
	reports := make(chan protocol.DirectoryBrowseReport, 2)
	idle := make(chan struct{}, 1)
	reportCount := 0
	d, _ := pendingWorkHintDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/daemon/heartbeat":
			mu.Lock()
			ack := protocol.DaemonHeartbeatAckPayload{RuntimeID: "rt-1", Status: "ok"}
			if len(queue) > 0 {
				request := queue[0]
				queue = queue[1:]
				ack.PendingDirectoryBrowse = &request
			} else if reportCount == 2 {
				select {
				case idle <- struct{}{}:
				default:
				}
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(ack)
		case strings.HasPrefix(r.URL.Path, "/api/daemon/runtimes/rt-1/directories/"):
			var report protocol.DirectoryBrowseReport
			if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
				t.Error(err)
				http.Error(w, "invalid report", http.StatusBadRequest)
				return
			}
			mu.Lock()
			reportCount++
			mu.Unlock()
			reports <- report
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			http.NotFound(w, r)
		}
	})
	withPendingWorkHintMinInterval(t, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	d.rootCtx = ctx
	t.Cleanup(cancel)

	d.handlePendingWorkHint("rt-1", "directories")
	select {
	case report := <-reports:
		if report.Error != "" || report.Result == nil || len(report.Result.Entries) != 1 || report.Result.Entries[0].Path != project {
			t.Fatalf("wrong real directory listing: %+v", report)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("directory listing was not reported")
	}
	mu.Lock()
	queue = append(queue, protocol.PendingDirectoryBrowse{
		ID:                   strings.Repeat("b", 32),
		DirectoryBrowseInput: protocol.DirectoryBrowseInput{Operation: "validate", Path: project},
	})
	mu.Unlock()
	// A user can click the returned folder before the one-second hint floor.
	// This second request must not wait for the normal 15-second heartbeat.
	d.handlePendingWorkHint("rt-1", "directories")
	select {
	case report := <-reports:
		real, _ := filepath.EvalSymlinks(project)
		if report.Error != "" || report.Result == nil || report.Result.Path != project || report.Result.RealPath != real {
			t.Fatalf("wrong validated selection: %+v", report)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("follow-up folder selection stalled behind the periodic heartbeat")
	}
	select {
	case <-idle:
	case <-time.After(3 * time.Second):
		t.Fatal("directory request queue did not drain")
	}
}
