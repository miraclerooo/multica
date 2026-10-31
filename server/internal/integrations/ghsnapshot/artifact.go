package ghsnapshot

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"regexp"
	"strings"
)

var artifactRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var artifactSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

// RepositoryFile resolves a branch once and reads a regular file at that exact
// commit. Credentials stay inside this installation-scoped API client.
func (c *Client) RepositoryFile(ctx context.Context, installationID int64, repo, file, ref string) (string, []byte, error) {
	if !c.Enabled() {
		return "", nil, errors.New("github content access unavailable")
	}
	if !artifactRepo.MatchString(repo) || file == "" || path.Clean(file) != file || path.IsAbs(file) || strings.HasPrefix(file, "../") || file == ".." || ref == "" {
		return "", nil, errors.New("invalid repository artifact reference")
	}
	base := "/repos/" + repo
	commit, err := c.restGet(ctx, installationID, base+"/commits/"+url.PathEscape(ref))
	if err != nil {
		return "", nil, err
	}
	var resolved struct {
		SHA string `json:"sha"`
	}
	if json.Unmarshal(commit, &resolved) != nil || !artifactSHA.MatchString(resolved.SHA) {
		return "", nil, errors.New("invalid commit response")
	}
	content, err := c.restGet(ctx, installationID, base+"/contents/"+url.PathEscape(file)+"?ref="+url.QueryEscape(resolved.SHA))
	if err != nil {
		return "", nil, err
	}
	var body struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	if json.Unmarshal(content, &body) != nil || body.Type != "file" || body.Encoding != "base64" {
		return "", nil, errors.New("artifact must be an accessible regular file")
	}
	data, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(body.Content, "\n", ""))
	if err != nil {
		return "", nil, errors.New("invalid repository content")
	}
	return resolved.SHA, data, nil
}
