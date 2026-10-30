package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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
