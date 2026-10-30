package protocol

const DaemonCapabilityDirectoryBrowseV1 = "directory-browse-v1"

const DirectoryBrowseMaxEntries = 200

type DirectoryBrowseInput struct {
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
}

type PendingDirectoryBrowse struct {
	ID string `json:"id"`
	DirectoryBrowseInput
}

type DirectoryBrowseEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type DirectoryBrowseResult struct {
	Path      string                 `json:"path,omitempty"`
	RealPath  string                 `json:"real_path,omitempty"`
	Parent    string                 `json:"parent,omitempty"`
	Entries   []DirectoryBrowseEntry `json:"entries,omitempty"`
	Truncated bool                   `json:"truncated,omitempty"`
	IsGitRepo bool                   `json:"is_git_repo"`
}

type DirectoryBrowseReport struct {
	Result *DirectoryBrowseResult `json:"result,omitempty"`
	Error  string                 `json:"error,omitempty"`
}
