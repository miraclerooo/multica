package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func browseLocalDirectories(ctx context.Context, input protocol.DirectoryBrowseInput) (*protocol.DirectoryBrowseResult, error) {
	result := &protocol.DirectoryBrowseResult{}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if input.Operation == "roots" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		result.Entries = append(result.Entries, protocol.DirectoryBrowseEntry{Name: filepath.Base(home), Path: home})
		if runtime.GOOS == "windows" {
			for drive := 'A'; drive <= 'Z'; drive++ {
				path := fmt.Sprintf("%c:%c", drive, os.PathSeparator)
				if info, err := os.Stat(path); err == nil && info.IsDir() {
					result.Entries = append(result.Entries, protocol.DirectoryBrowseEntry{Name: path, Path: path})
				}
			}
		} else {
			result.Entries = append(result.Entries, protocol.DirectoryBrowseEntry{Name: "/", Path: "/"})
		}
		return result, nil
	}
	path, err := normalizeLocalPath(input.Path)
	if err != nil {
		return nil, err
	}
	result.Path = path
	switch input.Operation {
	case "validate":
		if err := validateLocalPath(path); err != nil {
			return nil, err
		}
		result.RealPath, err = filepath.EvalSymlinks(path)
		if err != nil {
			return nil, err
		}
		result.IsGitRepo = isGitWorkTree(ctx, path)
		return result, nil
	case "list":
		// Navigation through home/system roots is distinct from selecting a
		// directory as an agent's writable working directory.
		dir, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer dir.Close()
		if parent := filepath.Dir(path); parent != path {
			result.Parent = parent
		}
		for scanned := 0; scanned < 10000; {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			entries, readErr := dir.ReadDir(128)
			for _, entry := range entries {
				scanned++
				child := filepath.Join(path, entry.Name())
				isDir := entry.IsDir()
				if entry.Type()&os.ModeSymlink != 0 {
					if info, statErr := os.Stat(child); statErr == nil {
						isDir = info.IsDir()
					}
				}
				if !isDir {
					continue
				}
				if len(result.Entries) == protocol.DirectoryBrowseMaxEntries {
					result.Truncated = true
					break
				}
				result.Entries = append(result.Entries, protocol.DirectoryBrowseEntry{Name: entry.Name(), Path: child})
			}
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return nil, readErr
			}
			if errors.Is(readErr, io.EOF) || result.Truncated {
				break
			}
			if scanned >= 10000 {
				result.Truncated = true
			}
		}
		sort.Slice(result.Entries, func(i, j int) bool { return result.Entries[i].Name < result.Entries[j].Name })
		return result, nil
	default:
		return nil, errors.New("unsupported directory operation")
	}
}

func (d *Daemon) handleDirectoryBrowse(ctx context.Context, rt Runtime, request protocol.PendingDirectoryBrowse) {
	browseCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, err := browseLocalDirectories(browseCtx, request.DirectoryBrowseInput)
	report := protocol.DirectoryBrowseReport{Result: result}
	if err != nil {
		report.Error = err.Error()
	}
	d.reportRuntimeResultWithRetry(ctx, "directory_browse", rt.ID, request.ID, func(ctx context.Context) error {
		return d.client.postJSON(ctx, fmt.Sprintf("/api/daemon/runtimes/%s/directories/%s/result", rt.ID, request.ID), report, nil)
	})
}
