# YANF-7 verification and handoff

Date: 2026-10-31. Base: `937d91637b1c36943b1e64edf4fa0b0f891d1089` on `main`.
The approved prototype attachment's SHA-256 was verified as
`51e2d434bf910c166d05f4f2606bc5903f27b9fc4f5bee97d8f405ea9a0125f9`.
The prototype was not used as an execution or conversion implementation.
Scope: the saved v1.4 project specification (document version 3), including
§15's Markdown body links, source task grouping and structured provenance.

Both prototype approvals are satisfied. The pipeline approval remains comment
`01a1922c-62ba-79e5-8ca4-9ddac9828a60`. The Markdown document area was approved
by Admin at 2026-10-31 15:09:12 UTC in comment
`01a19281-f439-7a9f-ac11-f7031764e5c9`. Its reviewed HTML is attachment
`01a19276-4fbc-7782-ae9f-cd6e0d2a6b9e`, with review SHA-256
`b24539c4b792de2229c9742ca1a2c1f5809c3810fff7f9a68086ffc358273210`.
The saved project delivery index (document
`b7951b67-2f62-4378-90e8-3e5c7204ea58`, version 4) records that the raw download
hash is `70075154ac4459e3c0c6f0fb631cf960b87b8890fdc1156aae5e06e6f35776ff`
because of an additional download script. These identify the same reviewed
design, not a new version. This handoff uses that approval record and does not
request or perform a new design review.

## Delivered contract

See `docs/pipelines/README.md` for exact API routes, JSON shapes, dialect
mapping, CLI commands, persistence and recovery rules, migration instructions,
and the UI integration contract. The implementation preserves the original
source kind and instructions and has no automatic dialect converter.

Both dialects, custom node/role names and repeated role bindings are supported.
Runs are persisted aggregates containing jobs, attempts, reports, artifacts,
decisions and operation receipts. Two pipeline tables plus task provenance
replace the proposal's suggested separate child tables; task registration and
state transitions are atomic. Definitions remain immutable. Source hashes,
compiler versions and run snapshots remain fixed across default-version and
mode changes.

The v1.4 addition reuses the existing Markdown/revision model. Task relations,
pinned source records and operation receipts support append-only collection
into existing or new documents. No independent link resource kind was added.
The core contract includes grouping/search, reverse lookup, source metadata,
fixed revision reads, association and unlink, with CLI equivalents.

## Checks actually run

| Check | Result |
| --- | --- |
| `make sqlc` | Passed; generated row projections and pipeline queries committed |
| Migrations 601–612 through the checkout's managed environment | Passed in isolated `multica_multica_94`; concurrent-index retry hooks registered |
| `go build ./cmd/server ./cmd/multica` | Passed |
| Focused Go checks with `-race`, across compiler, service, handler, real HTTP router, CLI, GitHub adapter and migrator | Passed; latest run also includes legacy squad/rerun/wakeup cases |
| Full handler suite with `-race`, including v1.4 | Passed: 165.330 seconds in the final broad Go run |
| Full service, server-command, CLI-command, migrator and GitHub adapter suites in the broad Go run | Passed |
| Guarded `bash scripts/test-go.sh --race --only agent` | Passed separately: `pkg/agent`, 179.367 seconds; real installed agent CLIs remain blocked |
| `pnpm --filter @multica/core typecheck` | Passed |
| `pnpm --filter @multica/core test` | Passed: 187 files, 2456 tests |
| Focused core document schema/draft checks | Passed: 3 files, 19 tests; includes final mutation cache invalidation change |
| Focused core pipeline/realtime checks | Passed: 8 files, 106 tests, including reconnect invalidation |
| `pnpm --filter @multica/core lint` | No errors; two existing warnings in `platform/core-provider.tsx` |
| `git diff --check` | Passed |

The v1.4 coverage recheck uses implementation commit
`c5e5f16f99a15737e3af08e0d8cc335d46576641`; the subsequent change corrects
approval metadata and this verification record only. No engine, API, core or
CLI implementation is repeated or replaced.

| v1.4 recheck | Actual result |
| --- | --- |
| Guarded `go test -race -v ./internal/handler ./cmd/server ./cmd/multica -run 'TestDocument\|TestProjectDocument' -count=1` | Passed: 19 top-level tests; handler 3.213s, authenticated HTTP router 1.940s, CLI 1.662s; PostgreSQL tests executed without skips |
| `pnpm --filter @multica/core exec vitest run documents/associations.test.ts documents/schema.test.ts documents/drafts.test.ts` | Passed: 3 files, 19 tests |
| Scope/contract inspection | Spec v1.4 saved version 3, delivery index version 4, source/route/core/CLI and A38–A44 evidence below agree; no independent link content model |

The recheck exercises real database revisions, source relations and HTTP
authorization with fake executors. It does not re-run the full suite or treat
the hand-maintained delivery index or prototype interactions as product test
evidence. The full-suite exception below remains unresolved.

Focused Go checks use the existing installed-agent CLI guard:

```sh
bash ../scripts/go-test-with-agent-cli-guard.sh -- go test -race \
  ./internal/handler ./internal/service ./cmd/server ./cmd/multica \
  ./internal/pipeline ./internal/integrations/ghsnapshot ./cmd/migrate \
  -run 'TestDocument|TestProjectDocument|TestPipeline|TestRerun|TestSquad|TestIssueWakeupSquad|TestEveryConcurrent|TestConcurrentIndex|TestRepositoryArtifact|TestDialect|TestCompiler|TestStageBarrier|TestShipped|TestFailureCannot|TestResultsAnd|TestApprovalRevision|TestRetryKeeps|TestFailureRouting|TestCancellationDoesNotRun' \
  -count=1
```

All executors and remote services used in new tests were fake. No paid agent
or real GitHub installation contents request was used.

## Evidence by behavior

| Behavior | Canonical evidence |
| --- | --- |
| Both dialects preserve instructions, roles, dependencies, gates and outputs | `compiler_test.go`: `TestDialectSemanticParity`, `TestShippedTemplatesCompile` |
| No mandatory four-stage structure, one role can execute multiple custom nodes | `TestPipelineBothDialectsPersistentExecution`; three compiled nodes in each dialect |
| Duplicate YAML keys, cycles, unknown fields/kinds and unsupported routes fail before persistence | `TestCompilerRejectsUnsupportedAndInvalidSource` |
| Stage barriers, explicit empty needs and independent artifact sources | `TestStageBarrierAndExplicitEmptyNeeds` |
| Process success is insufficient without a report or required content | `TestPipelineMissingAndFailedResultsCannotPassApproval`, `TestPipelineArtifactRemovedBeforeProcessCompletionCannotSucceed` |
| Missing outputs remain blocked and do not get silently re-enqueued | `TestPipelinePublishedArtifactsRequireCurrentAttemptAndAccessibleContent` |
| Start, retry and callback idempotency; attempts survive retry/restart | `TestPipelineStartRetryAndCallbackIdempotency`, `TestPipelineBothDialectsPersistentExecution` |
| Authenticated task token can report but cannot approve | `cmd/server/pipeline_integration_test.go`: `TestPipelineAuthenticatedHTTPResultAndHumanGate` |
| Human approval race, blank rejection, stale revisions and terminal protection | `TestPipelineApprovalRaceAndHumanIdentity`, `TestApprovalRevisionIdempotencyAndTerminalProtection` |
| Current-attempt artifact references, namespace and SHA pinning | `TestResultsAndAttemptPinnedInputs`, `TestRepositoryArtifactPinsMovingBranch`, publication tests |
| Role ambiguity, private-agent permission revocation, cross-squad ownership and workspace boundaries | `TestPipelineBindingPermissionsAndDefinitionOwnership`, `TestPipelineLeaderFallbackAndPermissionRecheck`, `TestPipelineCrossWorkspaceDefinitionAndArtifactReport` |
| Old clients preserve mode, old runs retain frozen versions, new runs use the new version | `TestPipelineSnapshotsModesCommentsAndCancellation`, `TestPipelineNewDefinitionLeavesLivePlanFrozen` |
| Unknown modes never fall back to leader execution | `TestPipelineUnknownSquadModeDoesNotFallBackToLeader` |
| Cancellation stops new scheduling and does not run failure recovery | `TestPipelineSnapshotsModesCommentsAndCancellation`, `TestCancellationDoesNotRunFailureRecovery` |
| Rejection cancels concurrent work | `TestPipelineRejectCancelsConcurrentAttempt` |
| Workflow step stays put; a moved step retires the old run before a fresh trigger | `TestPipelineWorkflowKeepsStepAndStopsWhenMoved` |
| Comments, legacy reruns and system child wakeups cannot dispatch the old coordinator | `TestPipelineLegacyRerunCannotStartCoordinator`, `TestPipelineSquadCannotUseLegacySystemWakeTarget`, comment suppression checks |
| Automation waits for the aggregate and gates; run_only is refused | `TestPipelineAutomationWaitsForAggregateAndRefusesRunOnly` |
| Optional owners are notified once and unknown prices stay null | `TestPipelineOwnerNotificationAndUnpricedUsage` |
| JSON errors preserve API error codes; querying a failed run succeeds | `cmd_pipeline_test.go`: source and error contract tests |
| Malformed shared responses fail closed; missing or future enums stay readable | `packages/core/pipelines/schema.test.ts` |

v1.4 backend/core/CLI evidence (the visual portions of A38–A44 remain for YANF-8):

| Acceptance scope | Canonical evidence |
| --- | --- |
| A38: stable task groups, identifier/title search, rename and unassociated legacy documents | `TestDocumentAssociationIdempotencyGroupingAndUnlink` |
| A39: standard Markdown links and descriptions, no link document/resource kind | `TestDocumentAssociationIdempotencyGroupingAndUnlink`, `TestDocumentAssociationPreservesExistingMarkdownLinks`, authenticated HTTP test |
| A40: idempotent existing/new collection, human prose preservation, same document referenced by multiple tasks | `TestDocumentAssociationIdempotencyGroupingAndUnlink`, `TestDocumentAssociationCreateReplayAndConflicts` |
| A41: downstream input, approval and download stay on document revision 1 after a version 2 save | `TestDocumentAssociationPinnedPipelineArtifactAndDocumentRevision` |
| A42: foreign project/workspace, missing project/content, local paths and unpublished declarations fail | `TestDocumentAssociationScopeAndUnavailableSources`, `TestDocumentAssociationPinnedPipelineArtifactAndDocumentRevision`; existing attachment/repository publication authorization tests |
| A43: association, task query, source query, unlink and fixed revision CLI/API | `TestDocumentAssociationAuthenticatedHTTP`, `TestDocumentAssociationCLIContract`, `TestDocumentReferencesUnlinkAndPinnedRevisionCLI` |
| A44: competing appends return latest without overwriting or partial source writes; drafts survive conflicts | `TestDocumentAssociationCompetingAppendsPreserveDraft`, `TestDocumentAssociationCreateReplayAndConflicts`, core `documents/associations.test.ts` |
| Source identities and project deletion cleanup | `TestDocumentAssociationAttachmentRepositoryAndCleanup`; full workspace deletion manifest suite |

## Check that is not green

`make test` is **not reported as passing**. In the final run, after the v1.4
code was fixed, the remaining failure was in the unchanged
`internal/daemon/repocache` package. The full handler, service, server-command,
CLI-command, migrator and GitHub adapter suites passed. Repeating the full
command outside the sandbox still left concurrent checkout tests reporting
`stop process tree: operation not permitted`, including
`TestCreateWorktree`, `TestRepeatedCheckoutOnTaskBranchIsNoop`,
`TestRepeatedCheckoutKeepsLocalWork` and
`TestFreshMigrationCarriesUnpushedBranch`.

The unchanged base commit's complete repocache package passed independently
with `-race` (35.539 seconds); individual failing checkout tests also passed
when rerun independently. This does not establish that the baseline full suite
passes, or that the remaining concurrent failure is resolved. No repocache
production code was changed. An earlier intermediate run also encountered
unchanged daemon checkout tests with the same EPERM; the final full daemon
suite passed (43.043 seconds).

Because the regular-package half of `make test` failed, its later `pkg/agent`
half did not run in that command. It was then run separately through the same
guard and passed with `-race` (179.367 seconds).

## Deliberate capability boundaries and acceptance work

Capabilities do not claim conditional Hermes branching/joins, automatic
rollback, named outputs/consumes, artifact glob/regex expansion, remote YAML
includes, external GitLab Runner execution, automatic dialect conversion,
automation run_only, workspace-only draft definitions, or streaming CLI logs.
Hermes `output` and `exit_check` retain declarations only. Repository content
publication currently supports GitHub through workspace-bound installations;
an unavailable adapter/reference blocks required content rather than claiming
delivery.

The API and CLI, including v1.4 §15, are ready for parent-task review. The
separate UI stage needs to implement both approved prototypes using these real
interfaces and run desktop/mobile accessibility/layout/end-to-end acceptance.
The parent task owns promotion of YANF-8; neither prototype needs another
approval, and this delivery does not start that stage.
Production runtime behavior, actual installation content permissions and
production restart/deployment remain unverified. No merge, deployment or squad
mode change was performed in the user's workspace.
