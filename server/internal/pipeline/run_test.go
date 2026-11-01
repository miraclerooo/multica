package pipeline

import "testing"

func testRun(t *testing.T) Run {
	t.Helper()
	v := Compile(customGitlab)
	if !v.SyntaxValid {
		t.Fatal(v.Diagnostics)
	}
	r := NewRun(*v.Plan, map[string]string{"read_sources": "same-agent", "make_notes": "same-agent"})
	r.Advance()
	return r
}
func registerFake(j *Job) {
	j.Attempts = append(j.Attempts, Attempt{Number: len(j.Attempts) + 1, TaskID: "fake", ExecutorID: j.ExecutorID, Status: "running", Inputs: []Artifact{}})
	j.Set("running", "")
}

func TestFailureCannotOpenManualGate(t *testing.T) {
	for _, result := range []string{"missing", "failed", "blocked", "missing_artifact"} {
		t.Run(result, func(t *testing.T) {
			r := testRun(t)
			j := r.Job("read_sources")
			registerFake(j)
			switch result {
			case "failed", "blocked":
				j.Current().Report = &Report{Result: result, Text: result}
			case "missing_artifact":
				j.Current().Report = &Report{Result: "succeeded", Text: "no published material"}
			}
			r.Finish(j, "completed")
			r.Advance()
			if j.Status == "succeeded" || r.Job("make_notes").Status == "ready" || r.Job("confirm_notes").Status == "waiting_approval" {
				t.Fatalf("unsafe advance: %+v", r)
			}
			if err := r.Decide("confirm_notes", r.Job("confirm_notes").Revision, "forged", "user", "approve", "", "now"); err == nil {
				t.Fatal("nonready approval accepted")
			}
		})
	}
}

func TestResultsAndAttemptPinnedInputs(t *testing.T) {
	r := testRun(t)
	j := r.Job("read_sources")
	registerFake(j)
	j.Current().Report = &Report{Result: "succeeded", Text: "done", Artifacts: []Artifact{{JobID: j.Node.ID, Attempt: 1, Path: j.Node.Paths[0], Status: "accessible", Repo: "org/repo", SHA: "fixed-sha"}}}
	r.Finish(j, "completed")
	r.Advance()
	inputs, ok := r.Inputs(r.Job("make_notes"))
	if !ok || len(inputs) != 1 || inputs[0].Attempt != 1 || inputs[0].SHA != "fixed-sha" {
		t.Fatalf("inputs not pinned: %+v", inputs)
	}
	j.Attempts = append(j.Attempts, Attempt{Number: 2, TaskID: "retry"})
	if _, ok = r.Inputs(r.Job("make_notes")); ok {
		t.Fatal("previous attempt was reused")
	}
}

func TestApprovalRevisionIdempotencyAndTerminalProtection(t *testing.T) {
	r := testRun(t)
	for i := 0; i < 2; i++ {
		j := &r.Jobs[i]
		j.Node.Paths = []string{}
		registerFake(j)
		j.Current().Report = &Report{Result: "succeeded", Text: "done"}
		r.Finish(j, "completed")
		r.Advance()
	}
	j := r.Job("confirm_notes")
	revision := j.Revision
	if err := r.Decide(j.Node.ID, revision, "approve-once", "human", "approve", "", "now"); err != nil {
		t.Fatal(err)
	}
	if r.Status != "succeeded" || j.Decision.ActorID != "human" {
		t.Fatalf("unexpected decision: %+v", r)
	}
	if err := r.Decide(j.Node.ID, revision, "approve-once", "human", "approve", "", "later"); err != nil {
		t.Fatal("idempotent replay failed", err)
	}
	for _, key := range []string{"new-key", "approve-once"} {
		if err := r.Decide(j.Node.ID, revision, key, "human", "reject", "overwrite", "later"); err == nil {
			t.Fatal("terminal decision overwritten")
		}
	}
}

func TestRetryKeepsHistoryAndIdempotency(t *testing.T) {
	r := testRun(t)
	j := r.Job("read_sources")
	registerFake(j)
	r.Finish(j, "failed")
	r.Advance()
	rev := j.Revision
	if err := r.Retry(j.Node.ID, rev, "retry-once"); err != nil {
		t.Fatal(err)
	}
	if err := r.Retry(j.Node.ID, rev, "retry-once"); err != nil {
		t.Fatal(err)
	}
	if j.Status != "ready" || len(j.Attempts) != 1 || j.Attempts[0].Status != "failed" || r.Job("make_notes").Status != "pending" {
		t.Fatalf("history lost: %+v", r)
	}
}

func TestFailureRoutingAndAllowedFailure(t *testing.T) {
	source := `stages: [a, b]
work: {stage: a, instructions: work, allow_failure: true}
recover: {stage: b, instructions: recover, when: on_failure}
gate: {stage: b, when: manual}
`
	v := Compile(source)
	if !v.SyntaxValid {
		t.Fatal(v.Diagnostics)
	}
	r := NewRun(*v.Plan, map[string]string{})
	r.Advance()
	j := r.Job("work")
	registerFake(j)
	r.Finish(j, "failed")
	r.Advance()
	if r.Job("recover").Status != "skipped" || r.Job("gate").Status != "waiting_approval" {
		t.Fatalf("allow_failure semantics: %+v", r)
	}
}

func TestCancellationDoesNotRunFailureRecovery(t *testing.T) {
	v := Compile("stages: [a, b]\nwork: {stage: a, instructions: work}\nrecover: {stage: b, instructions: recover, when: on_failure}\n")
	if !v.SyntaxValid {
		t.Fatal(v.Diagnostics)
	}
	r := NewRun(*v.Plan, map[string]string{})
	r.Advance()
	j := r.Job("work")
	registerFake(j)
	r.Finish(j, "cancelled")
	r.Advance()
	if r.Job("recover").Status != "skipped" || r.Status == "succeeded" {
		t.Fatalf("cancellation ran recovery or became success: %+v", r)
	}
}
