package pipeline

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"error"`
}

func (e *Error) Error() string        { return e.Message }
func Fail(code, message string) error { return &Error{code, message} }
func Fingerprint(v any) string        { b, _ := json.Marshal(v); return fmt.Sprintf("%x", sha256.Sum256(b)) }

type Artifact struct {
	ID              string `json:"id"`
	JobID           string `json:"job_id"`
	Attempt         int    `json:"attempt"`
	Path            string `json:"path"`
	AttachmentID    string `json:"attachment_id,omitempty"`
	DocumentID      string `json:"document_id,omitempty"`
	DocumentVersion int32  `json:"document_version,omitempty"`
	Repo            string `json:"repo,omitempty"`
	Ref             string `json:"ref,omitempty"`
	SHA             string `json:"sha,omitempty"`
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
}
type Report struct {
	Result    string     `json:"result"`
	Text      string     `json:"report"`
	Artifacts []Artifact `json:"artifacts"`
}
type Attempt struct {
	Usage       []Usage    `json:"usage"`
	Number      int        `json:"number"`
	TaskID      string     `json:"task_id"`
	ExecutorID  string     `json:"executor_id"`
	Status      string     `json:"status"`
	Inputs      []Artifact `json:"inputs"`
	Report      *Report    `json:"report"`
	ReportKey   string     `json:"report_key,omitempty"`
	ReportHash  string     `json:"report_hash,omitempty"`
	StartedAt   string     `json:"started_at,omitempty"`
	CompletedAt string     `json:"completed_at,omitempty"`
}

type Usage struct {
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	InputTokens      int64  `json:"input_tokens"`
	OutputTokens     int64  `json:"output_tokens"`
	CacheReadTokens  int64  `json:"cache_read_tokens"`
	CacheWriteTokens int64  `json:"cache_write_tokens"`
	CostUSDTicks     *int64 `json:"cost_usd_ticks"`
}
type Decision struct {
	ActorID     string     `json:"actor_id"`
	Decision    string     `json:"decision"`
	Reason      string     `json:"reason"`
	JobRevision int64      `json:"job_revision"`
	Materials   []Artifact `json:"materials"`
	CreatedAt   string     `json:"created_at"`
}
type Job struct {
	OwnerID        string    `json:"owner_id,omitempty"`
	NotifiedStatus string    `json:"notified_status,omitempty"`
	Node           Node      `json:"node"`
	Status         string    `json:"status"`
	Reason         string    `json:"reason"`
	Revision       int64     `json:"revision"`
	ExecutorID     string    `json:"executor_id"`
	Attempts       []Attempt `json:"attempts"`
	Decision       *Decision `json:"decision"`
}
type Run struct {
	ID               string            `json:"id"`
	WorkspaceID      string            `json:"workspace_id"`
	IssueID          string            `json:"issue_id"`
	SquadID          string            `json:"squad_id"`
	DefinitionID     string            `json:"definition_id"`
	CreatorID        string            `json:"creator_id"`
	Revision         int64             `json:"revision"`
	Status           string            `json:"status"`
	StopStatus       string            `json:"stop_status,omitempty"`
	Reason           string            `json:"reason"`
	Plan             Plan              `json:"plan"`
	Policy           string            `json:"policy"`
	IssueTitle       string            `json:"issue_title"`
	IssueDescription string            `json:"issue_description"`
	IssueRevision    int64             `json:"issue_revision"`
	ProjectID        string            `json:"project_id"`
	WorkflowID       string            `json:"workflow_id"`
	WorkflowStep     string            `json:"workflow_step"`
	ProjectedStatus  string            `json:"projected_status"`
	Jobs             []Job             `json:"jobs"`
	Operations       map[string]string `json:"operations"`
	CreatedAt        string            `json:"created_at"`
	UpdatedAt        string            `json:"updated_at"`
}

func NewRun(plan Plan, bindings map[string]string) Run {
	r := Run{Plan: plan, Status: "queued", Jobs: []Job{}, Operations: map[string]string{}}
	for _, n := range plan.Nodes {
		r.Jobs = append(r.Jobs, Job{Node: n, Status: "pending", Revision: 1, ExecutorID: bindings[n.ID], OwnerID: bindings["owner:"+n.ID], Attempts: []Attempt{}})
	}
	return r
}
func (r *Run) Job(id string) *Job {
	for i := range r.Jobs {
		if r.Jobs[i].Node.ID == id {
			return &r.Jobs[i]
		}
	}
	return nil
}
func Terminal(s string) bool {
	switch s {
	case "succeeded", "failed", "rejected", "skipped", "cancelled":
		return true
	}
	return false
}
func (j *Job) Set(status, reason string) {
	if j.Status != status || j.Reason != reason {
		j.Status = status
		j.Reason = reason
		j.Revision++
	}
}
func (j *Job) Current() *Attempt {
	if len(j.Attempts) == 0 {
		return nil
	}
	return &j.Attempts[len(j.Attempts)-1]
}

// Inputs always use the current upstream attempt; a previous successful attempt
// is never substituted after a retry. Declarations have no content reference.
func (r *Run) Inputs(j *Job) ([]Artifact, bool) {
	out := []Artifact{}
	available := true
	for _, id := range j.Node.ArtifactSources {
		up := r.Job(id)
		if up == nil {
			available = false
			continue
		}
		a := up.Current()
		for _, p := range up.Node.Paths {
			found := false
			if a != nil && a.Report != nil {
				for _, v := range a.Report.Artifacts {
					if v.Path == p && v.Status == "accessible" {
						out = append(out, v)
						found = true
					}
				}
			}
			if !found {
				available = false
				out = append(out, Artifact{JobID: id, Path: p, Status: "missing"})
			}
		}
	}
	return out, available
}

func (r *Run) Artifacts() []Artifact {
	out := []Artifact{}
	for _, j := range r.Jobs {
		for _, p := range j.Node.Paths {
			out = append(out, Artifact{JobID: j.Node.ID, Path: p, Status: "declared"})
		}
		for _, a := range j.Attempts {
			if a.Report != nil {
				out = append(out, a.Report.Artifacts...)
			}
		}
	}
	return out
}

// Advance evaluates the frozen plan; only the service may register an execution.
func (r *Run) Advance() {
	if Terminal(r.Status) || r.Status == "cancelling" {
		return
	}
	for pass := 0; pass <= len(r.Jobs); pass++ {
		changed := false
		for i := range r.Jobs {
			j := &r.Jobs[i]
			if j.Status != "pending" && j.Status != "ready" && !(j.Status == "blocked" && j.Reason == "artifact_unavailable" && j.Current() == nil) {
				continue
			}
			all, failed, stopped := true, false, false
			for _, id := range j.Node.Needs {
				up := r.Job(id)
				if up == nil {
					all = false
					break
				}
				if !Terminal(up.Status) {
					all = false
				}
				if up.Status == "cancelled" || (up.Status == "skipped" && up.Reason == "upstream_cancelled") {
					stopped = true
				}
				if (up.Status == "failed" || up.Status == "rejected" || up.Status == "cancelled" || (up.Status == "skipped" && up.Reason == "upstream_failed")) && !up.Node.AllowFailure {
					failed = true
				}
			}
			if !all {
				continue
			}
			before := j.Status
			if stopped {
				j.Set("skipped", "upstream_cancelled")
			} else if j.Node.When == "on_failure" {
				if !failed {
					j.Set("skipped", "failure_condition_false")
				} else {
					j.Set("ready", "")
				}
			} else if failed {
				j.Set("skipped", "upstream_failed")
			} else {
				j.Set("ready", "")
			}
			if j.Status == "ready" {
				if _, ok := r.Inputs(j); !ok {
					j.Set("blocked", "artifact_unavailable")
				} else if j.Node.Type == "manual" {
					j.Set("waiting_approval", "")
				}
			}
			changed = changed || before != j.Status
		}
		if !changed {
			break
		}
	}
	r.Summarize()
}

func (r *Run) Summarize() {
	if r.Status == "cancelled" || r.Status == "rejected" {
		return
	}
	active, waiting, blocked, failed, all := false, false, false, false, true
	for _, j := range r.Jobs {
		if !Terminal(j.Status) {
			all = false
		}
		switch j.Status {
		case "queued", "running", "ready":
			active = true
		case "waiting_approval":
			waiting = true
		case "blocked":
			blocked = true
		}
		if !j.Node.AllowFailure && (j.Status == "failed" || j.Status == "rejected" || j.Status == "cancelled" || (j.Status == "skipped" && (j.Reason == "upstream_failed" || j.Reason == "upstream_cancelled"))) {
			failed = true
		}
	}
	if r.Status == "cancelling" {
		if all {
			r.Status = "cancelled"
			if r.StopStatus == "rejected" {
				r.Status = "rejected"
			}
		}
		return
	}
	switch {
	case active:
		r.Status = "running"
	case waiting:
		r.Status = "waiting_approval"
	case blocked:
		r.Status = "blocked"
	case all && failed:
		r.Status = "failed"
	case all:
		r.Status = "succeeded"
	default:
		r.Status = "running"
	}
}

func (r *Run) Finish(j *Job, processStatus string) {
	a := j.Current()
	if a == nil || Terminal(j.Status) {
		return
	}
	a.Status = processStatus
	if processStatus == "cancelled" {
		j.Set("cancelled", "execution_cancelled")
		return
	}
	if processStatus == "failed" {
		j.Set("failed", "execution_failed")
	} else if processStatus == "completed" {
		if a.Report == nil {
			j.Set("blocked", "result_unreported")
			return
		}
		switch a.Report.Result {
		case "failed":
			j.Set("failed", "reported_failure")
		case "blocked":
			j.Set("blocked", "reported_blocked")
		case "succeeded":
			for _, p := range j.Node.Paths {
				found := false
				for _, v := range a.Report.Artifacts {
					if v.Path == p && v.Status == "accessible" {
						found = true
					}
				}
				if !found {
					j.Set("blocked", "artifact_unavailable")
					return
				}
			}
			j.Set("succeeded", "")
		}
	}
	if j.Status == "failed" && len(j.Attempts) <= j.Node.Retry {
		j.Set("pending", "retry_scheduled")
	}
}

// Receipt rejects reuse of an idempotency key with a different operation body.
func (r *Run) Receipt(key string, body any) (bool, error) {
	if strings.TrimSpace(key) == "" || len(key) > 200 {
		return false, Fail("idempotency_key_required", "a nonempty idempotency key of at most 200 characters is required")
	}
	hash := Fingerprint(body)
	if prev, ok := r.Operations[key]; ok {
		if prev != hash {
			return false, Fail("idempotency_conflict", "idempotency key was already used for a different operation")
		}
		return true, nil
	}
	return false, nil
}
func (r *Run) Record(key string, body any) { r.Operations[key] = Fingerprint(body) }

func (r *Run) Decide(id string, revision int64, key, actor, decision, reason, now string) error {
	body := []any{"decision", id, revision, actor, decision, reason}
	dup, err := r.Receipt(key, body)
	if err != nil || dup {
		return err
	}
	j := r.Job(id)
	if j == nil {
		return Fail("job_not_found", "job not found")
	}
	if Terminal(r.Status) || r.Status == "cancelling" || j.Status != "waiting_approval" || j.Revision != revision {
		return Fail("revision_conflict", "job is no longer awaiting this decision")
	}
	if decision != "approve" && decision != "reject" {
		return Fail("invalid_decision", "decision must be approve or reject")
	}
	if decision == "reject" && strings.TrimSpace(reason) == "" {
		return Fail("reason_required", "rejection requires a reason")
	}
	inputs, ok := r.Inputs(j)
	if !ok {
		return Fail("artifact_unavailable", "approval materials are unavailable")
	}
	j.Decision = &Decision{ActorID: actor, Decision: decision, Reason: reason, JobRevision: revision, Materials: inputs, CreatedAt: now}
	if decision == "approve" {
		j.Set("succeeded", "")
	} else {
		j.Set("rejected", reason)
		r.Status = "cancelling"
		r.StopStatus = "rejected"
		r.Reason = reason
		for i := range r.Jobs {
			other := &r.Jobs[i]
			if !Terminal(other.Status) && other.Current() == nil {
				other.Set("cancelled", "approval_rejected")
			}
		}
	}
	r.Record(key, body)
	r.Advance()
	r.Summarize()
	return nil
}

func (r *Run) Retry(id string, revision int64, key string) error {
	body := []any{"retry", id, revision}
	dup, err := r.Receipt(key, body)
	if err != nil || dup {
		return err
	}
	j := r.Job(id)
	if j == nil {
		return Fail("job_not_found", "job not found")
	}
	if r.Status == "cancelled" || r.Status == "cancelling" || r.Status == "rejected" || j.Node.Type != "agent" || j.Revision != revision || (j.Status != "failed" && j.Status != "blocked") {
		return Fail("revision_conflict", "job cannot be retried at this revision")
	}
	if a := j.Current(); a != nil && a.Status != "completed" && a.Status != "failed" && a.Status != "cancelled" {
		return Fail("active_attempt", "the current execution has not finished")
	}
	desc := map[string]bool{id: true}
	for pass := 0; pass < len(r.Jobs); pass++ {
		for _, n := range r.Jobs {
			for _, dep := range n.Node.Needs {
				if desc[dep] {
					desc[n.Node.ID] = true
				}
			}
		}
	}
	for _, n := range r.Jobs {
		if n.Node.ID != id && desc[n.Node.ID] && (len(n.Attempts) > 0 || n.Decision != nil) {
			return Fail("downstream_started", "downstream has already started; create a new run")
		}
	}
	j.Set("pending", "")
	for i := range r.Jobs {
		n := &r.Jobs[i]
		if n.Node.ID != id && desc[n.Node.ID] {
			n.Set("pending", "")
		}
	}
	r.Status = "running"
	r.Reason = ""
	r.Record(key, body)
	r.Advance()
	return nil
}

func (r *Run) Brief(j *Job) string {
	inputs, _ := r.Inputs(j)
	b, _ := json.MarshalIndent(inputs, "", "  ")
	return fmt.Sprintf("# Pipeline job\nRun: %s\nJob: %s\nAttempt: %d\nDefinition: %s (%s, compiler %s)\nIssue snapshot: %s\n%s\n\nSquad policy:\n%s\n\nInstructions:\n%s\n\nPinned upstream artifacts:\n%s\n\nComplete this job yourself. The server owns scheduling and parent issue status. Submit a structured result before finishing using `multica pipeline job report %s %s --attempt %d --result succeeded|failed|blocked --report-file <file> --idempotency-key <key>`; publish exact artifact paths using attachment IDs from this task, an accessible repository file pinned by SHA, or a project Markdown document_id and document_version. A normal process exit without a result blocks this job. Human decisions use the approval API.\n", r.ID, j.Node.ID, len(j.Attempts)+1, r.DefinitionID, r.Plan.Kind, r.Plan.CompilerVersion, r.IssueTitle, r.IssueDescription, r.Policy, j.Node.Instructions, b, r.ID, j.Node.ID, len(j.Attempts)+1)
}
