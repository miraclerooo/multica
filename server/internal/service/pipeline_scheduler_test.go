package service

import (
	"context"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestPipelineSquadCannotUseLegacySystemWakeTarget(t *testing.T) {
	f, _, id, agent := wakeFixture(t)
	squad := f.Squad(t, "pipeline system wake target", agent, testutil.Cols{"instructions_mode": "pipeline"})
	f.Exec(t, "UPDATE issue SET assignee_type='squad',assignee_id=$2 WHERE id=$1", id, squad)
	issue, err := f.q.GetIssue(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"pipeline", "future_mode"} {
		f.Exec(t, "UPDATE squad SET instructions_mode=$2 WHERE id=$1", squad, mode)
		target, err := resolveWakeTarget(context.Background(), f.q, issue)
		if err != nil || target.Type != "none" || target.Agent.ID.Valid {
			t.Fatalf("%s used old leader protocol: %+v, %v", mode, target, err)
		}
	}
}
