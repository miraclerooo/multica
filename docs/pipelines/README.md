# Squad pipeline API and CLI (YANF-7)

This change supplies the server and shared core contract for the approved v1.2
design. The pipeline UI is a separate delivery. Both dialects are executable:
the engine parses the original document, stores its bytes and SHA-256, and
freezes the compiled plan, compiler version, bindings, squad policy, issue
title/description, project and workflow step in each run. No conversion or
template substitution is performed.

## Dialects

`kind` selects `gitlab_yaml` or `hermes_yaml`. An omitted kind is the legacy
GitLab format. All other kinds and unsupported fields produce diagnostics.
Diagnostics carry `code`, `severity`, `message`, `line`, `column`, and optional
`job_id`, `field`, `suggestion`. Syntax errors without a recoverable location
use zero; semantic errors identify the source node.

GitLab fields:

| Field | Behavior |
| --- | --- |
| `stages` | Unique, nonempty user stage names, in order |
| Top-level job | User identifier, with `stage` and agent `instructions` |
| `tags` | Zero/one role; missing or `[]` selects `leader_id` |
| `needs` | Exact ordering and default artifact sources; `[]` removes the barrier |
| No `needs` | All earlier stages are a barrier; jobs in one stage may run concurrently |
| `dependencies` | Earlier-stage artifact sources; does not remove barriers; incompatible with explicit `needs` |
| `artifacts.paths` | Exact relative paths; every declaration is required for success |
| `when` | `on_success` (default), `manual`, `on_failure` |
| `allow_failure` | Default false; accepted failures do not activate `on_failure` |
| `retry` | 0–10 extra attempts; default zero; explicit manual retry is separate |
| `owner` | Optional, unique human notification role; confers no approval rights |

Explicit `needs` may refer to the same or an earlier stage. Cycles, unknown
references, duplicate keys, anchors, aliases, includes and Runner fields are
rejected. There are no mandatory stage, node or role names.

Hermes mapping:

| Source | Compiled plan |
| --- | --- |
| `roles: {name: {}}`, state `by` | Squad role reference; omitted `by` uses leader |
| State `entry` | Exact agent instructions |
| State `title` | Display label; source ID remains the state key |
| `edges: [{from, to, type: forward}]` | One connected acyclic forward chain |
| `gates: {name: {type: manual, owner?: role}}` and state `gate` | Blocking manual node after that state |
| State `artifacts.paths` | Same output contract as GitLab |
| State `output`, `exit_check` | Retained declarations for display; never executed or treated as verification |
| State `owner`, `retry`, `allow_failure` | Same semantics as GitLab |

Hermes gates compile to `<state>.gate.<gate>` IDs and retain the source state ID
and location. A following edge depends on the preceding gate and receives the
preceding state's artifacts. Branches/joins, conditional routes and rollback
are rejected. Metadata `id`, `name`, `version` is retained in the immutable
source. The internal stages list contains the user's state names.

## HTTP contract

All routes use existing authentication and workspace membership. `X-Workspace-ID`
selects the workspace. IDs in writes are resolved or parsed at the boundary.
Squad configuration requires owner/admin or squad-creator management rights;
agent invocation checks have no private-agent admin bypass. Human decisions
require an authenticated human with the existing issue operation rights, and
do not require any special squad role.

| Method / path | Request / response |
| --- | --- |
| GET `/api/pipelines/capabilities` | `schema_version`, `compiler_version`, `kinds`, feature booleans, limits |
| POST `/api/pipelines/validate` | `{source, squad_id?}` → `{kind, syntax_valid, binding_valid, diagnostics, plan}` |
| POST `/api/pipelines/definitions` | `{source, squad_id, idempotency_key, activate?, expected_revision?}` → immutable definition |
| POST `/api/squads/:id/pipeline-versions` | Same save; squad ID comes from path; activate requires squad revision |
| GET `/api/pipelines/definitions?squad_id=...` | Definition page |
| GET `/api/pipelines/definitions/:id` | Original source, plan, hash, revision, creator and compiler version |
| PUT `/api/squads/:id` | Adds `instructions_mode`, `pipeline_definition_id`, `expected_revision` |
| POST `/api/pipeline-runs` | `{issue_id, squad_id, definition_id?, idempotency_key}` → run snapshot |
| GET `/api/pipeline-runs?issue_id=...&squad_id=...` | Run page |
| GET `/api/pipeline-runs/:id` | Run, plan, jobs, attempts and decisions |
| POST `/api/pipeline-runs/:id/cancel` | `{reason, idempotency_key}` |
| GET `/api/pipeline-runs/:id/jobs/:job` | Node, state/reason/revision, executor, attempts, decision |
| POST `/api/pipeline-runs/:id/jobs/:job/retry` | `{expected_revision, idempotency_key}` |
| POST `/api/pipeline-runs/:id/jobs/:job/report` | `{attempt, result, report, artifacts, idempotency_key}` |
| POST `/api/pipeline-runs/:id/jobs/:job/decisions` | `{expected_revision, decision: approve\|reject, reason?, idempotency_key}` |
| GET `/api/pipeline-runs/:id/artifacts?job_id=...` | Declaration and publication page |
| GET `/api/pipeline-runs/:id/artifact-content?artifact_id=...` | Authenticated content read; existing attachment delivery or pinned repository read |

Collection pages are `{items, limit, offset}`; limit defaults to 50, maximum
100. Read a subsequent page by advancing offset by the number of returned
items. A run includes `revision`, `plan`, `policy`, issue/project/workflow
snapshots, `jobs`, and created/updated timestamps. Each job includes its full
compiled node, state, reason, revision, actual executor, attempts and optional
decision. Attempts retain task IDs, timestamps, reports and pinned inputs.
Usage is read from existing task usage rows per attempt/model; null
`cost_usd_ticks` means unpriced, never free. Log reads use the existing task
messages API and its permissions.

Validation without a squad has `binding_valid: null`. A valid source is not a
claim that a runtime is online or a role is bound. Saving alone compiles the
source; enabling checks bindings. Activation and version creation are one
transaction. Source, kind, plan and version rows have no update endpoint.

Changing a squad mode/definition requires the revision read from its GET.
Ordinary older-client edits omit these fields and preserve them. `markdown`
clears the default definition binding while keeping instructions and live run
snapshots. Definitions belong to their owning squad; copying requires saving
a new version in the destination squad. Runs require the issue to be assigned
to that squad. Backlog, triage and terminal issues cannot start a run.

## Results and artifacts

An agent task's normal exit is only process completion. The current executor
must report `succeeded`, `failed` or `blocked` and nonempty report text while
the attempt is running. The server checks task ID, agent, run, job and attempt.
Reports are immutable once accepted. Process failure overrides reported
success. An absent result blocks with `result_unreported`; missing output
blocks with `artifact_unavailable`. Neither can open a dependent manual gate.

An artifact report uses exactly one of:

```json
{"path":"reports/summary.md","attachment_id":"<attachment UUID>"}
```

```json
{"path":"reports/summary.md","repo":"owner/repository","ref":"branch-or-commit"}
```

Attachments must belong to this issue and this exact task/agent, with readable
stored content. GitHub repository files are read through an installation bound
to this workspace. The branch/ref resolves to a commit SHA at publication;
downstream reads use that SHA and source attempt. A deployment without GitHub
content permissions retains a reported, unavailable reference and blocks
required consumption. Other Git providers are not supported by this artifact
adapter. Local paths, a text `ARTIFACT:`/`REF:` claim, and YAML declarations do
not publish content. CLI callers submit the structured reference array through
`--artifacts-file`; the existing line protocol remains useful report text.

Publication states are `declared`, `reported`, `accessible`, `missing`. The
catalog never invents download URLs. Attempts retain previous reports, and
new downstream attempts use the current upstream attempt only. Readability is
rechecked for material handoff, approval and download. Human decisions record
the exact materials, actor, time and node revision.

## Scheduling and collaboration

The persistent run is the transaction aggregate: its JSON state holds jobs,
append-only attempts, artifact references, decisions and idempotency receipts.
It uses a row lock together with the issue lock. Task insertion, pipeline
registration and the corresponding job transition commit together. The
`agent_task_queue` row carries run/job/attempt provenance. This intentionally
uses two pipeline tables instead of separate tables for every aggregate child;
the API exposes those children without weakening atomicity or history.

Completion/failure bridges reconcile the aggregate. The server also runs a
recovery pass after restart and periodically, reading registered task IDs
instead of creating replacements. Queue delivery and cancellation use the
existing runtime. External side effects are not claimed to be exactly once.
Multiple nodes may bind to the same agent; existing runtime concurrency limits
still apply. Offline/unbound/revoked execution waits or blocks with a reason.
Invocation and issue context are checked again before task claim.

Assignment and backlog promotion route pipeline squads to this service.
Pipeline comments, completion replay, reruns and failures cannot invoke the
old squad coordinator or reset the parent to `todo`. A pipeline job uses a
fresh task session and a dedicated handoff brief, including upstream files and
the result contract, without the legacy leader delegation protocol.

For default issue statuses, execution projects `in_progress`, final approval
and success project `in_review`, and failures/resource blocks project
`blocked`. The engine never marks an issue `done`. A named project workflow
keeps its step; changing scope, project, workflow step or assignee cancels
remaining old work rather than overwriting the user's change. The handoff
instructions and squad policy are snapshots. Rejection ends the run and
cancels concurrent work. Cancelling stops new dispatch and cancels registered
tasks; it does not activate failure recovery.

`create_issue` automation shares the assignment entry and waits for the whole
pipeline, including human gates. `run_only` with a pipeline squad is rejected
both at configuration and dispatch. Optional human owners get deduplicated
inbox notifications on waiting approval, failed and blocked nodes; their role
grants no extra authority.

Idempotency keys are required for writes. Reusing an operation key with a
different body returns `idempotency_conflict`. Start has one active run per
issue, and competing decisions serialize by node revision. An expired revision
or a new decision on a terminal gate returns `revision_conflict`. Retry appends
an attempt, preserves history and refuses active execution or already-started
downstream work. Pipeline reruns use new run creation with a selected version.

## CLI

All commands default to JSON. `get --output yaml` emits the saved source
unchanged. API errors expose stable JSON codes on stderr and exit nonzero;
stdout remains JSON when present. Querying a failed run still exits zero.

```sh
multica pipeline capabilities
multica pipeline validate flow.yaml --squad <id>
multica pipeline create flow.yaml --squad <id> --idempotency-key <key>
multica pipeline get <definition-id> --output yaml
multica pipeline list --squad <id> --limit 50 --offset 0
multica squad update <id> --instructions-mode pipeline \
  --pipeline-definition <definition-id> --expected-revision <revision>
multica pipeline run create --issue <issue> --squad <id> --idempotency-key <key>
multica pipeline run list --issue <issue>
multica pipeline run get <run-id>
multica pipeline job get <run-id> <job>
multica pipeline job logs <run-id> <job> --attempt 1
multica pipeline job report <run-id> <job> --attempt 1 --result succeeded \
  --report-file report.md --artifacts-file references.json --idempotency-key <key>
multica pipeline job retry <run-id> <job> --expected-revision <revision> --idempotency-key <key>
multica pipeline job approve <run-id> <job> --expected-revision <revision> --idempotency-key <key>
multica pipeline job reject <run-id> <job> --expected-revision <revision> \
  --reason-file reason.md --idempotency-key <key>
multica pipeline artifact list <run-id>
multica pipeline artifact download <artifact-id> --output-dir ./downloads
multica pipeline run cancel <run-id> --reason "Stop" --idempotency-key <key>
```

`validate` and `create` accept `-` for stdin. Node IDs and roles are user values.
Artifact IDs are copied from the catalog. Downloads refuse to overwrite a
local file. Job logs are bounded reads; streaming/follow is not implemented.

## Shared core and UI handoff

Import `@multica/core/pipelines` for schemas, request types, query options and
mutations, or the corresponding types from `@multica/core/types`. Every new
client response uses zod and `parseWithFallback`: malformed snapshots become
null, malformed validation fails closed, and missing capabilities expose no
actions. Unknown kinds/modes/statuses remain readable strings, so consumers
must explicitly gate actions on recognized capabilities and current states.
Query keys contain the workspace ID. Subscribe to `pipeline:updated` and call
the workspace invalidator; invalidate on websocket reconnect as well. Issue
status is also returned in the frozen run's `projected_status`.

The UI should preserve source drafts and the approved diagram layout, render
actual nodes/edges and role options, and submit explicit node revisions and
idempotency keys. It must not copy the prototype's simulated dialect converter.
No UI or mobile verification is claimed by this backend delivery.

## Capability boundaries

Supported P1: both compilers, configurable graphs/roles, GitLab stage barriers
and DAGs, Hermes forward chains/manual gates, failure conditions, explicit
retry budgets, immutable versions, atomic activation, persisted execution,
human decisions, attempt-bound artifacts, existing runtime/log/usage bridges,
CLI, core client contracts, project workflow and automation routing.

Explicitly unsupported (reported false or rejected): conditional Hermes
branches/joins, rollback/reopening graphs, named outputs/consumes, glob/regex
artifacts, remote YAML includes and GitLab Runner execution, dialect
conversion, automation `run_only`, workspace-only draft definitions, and
streaming CLI logs. `output`/`exit_check` retain metadata only. No deployment,
paid-agent smoke test, UI implementation or production verification is part of
this PR.

## Migration and verification

Migrations 601–608 add default markdown mode, squad revisions, immutable
definitions, run aggregates and task provenance. There are no new foreign keys.
Every new index has its own concurrent migration. Existing clients can keep
editing ordinary squad fields. Reverting a default affects future triggers;
cancel live runs explicitly before rolling the product server back. Historical
versions/attempts survive retries and mode changes. Explicit issue/workspace
deletion cleans up its pipeline records through the existing scoped delete
queries. `make sqlc` regenerates all affected row projections.

Canonical evidence lives beside the implementation:

- `internal/pipeline/*_test.go`: dialect parity, all four shipped examples,
  source diagnostics, barriers, failure/gate behavior, retry and pinned inputs.
- `internal/handler/pipeline_test.go`: real PostgreSQL/API tests with fake task
  completion, custom roles, both dialects, permissions, immutable snapshots,
  approvals/concurrency, artifacts, notifications, cancellation, workflows and
  automation.
- `internal/integrations/ghsnapshot/artifact_test.go`: a fake GitHub server
  proves branch resolution and pinned content reads.
- `cmd/multica/cmd_pipeline_test.go`: exact source round-trip, JSON errors and
  failed-run query exit behavior through a fake HTTP service.
- `packages/core/pipelines/schema.test.ts`: malformed responses and legacy or
  unknown enums fail safely at the shared API boundary.

Use `make test` for the Go suite, including the existing agent CLI guard, and
the core package typecheck/tests/lint for the shared contract. Real runtimes,
GitHub installation contents access and UI behavior still require deployment
acceptance with the user's selected credentials and squad.
