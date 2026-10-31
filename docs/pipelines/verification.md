# YANF-7 verification and handoff

Date: 2026-10-31. Base: `937d91637b1c36943b1e64edf4fa0b0f891d1089` on `main`.
The approved prototype attachment's SHA-256 was verified as
`51e2d434bf910c166d05f4f2606bc5903f27b9fc4f5bee97d8f405ea9a0125f9`.
The prototype was not used as an execution or conversion implementation.

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

## Checks actually run

| Check | Result |
| --- | --- |
| `make sqlc` | Passed; generated row projections and pipeline queries committed |
| Migrations 601–608 through the checkout's managed environment | Passed in isolated `multica_multica_94`; concurrent-index retry hooks registered |
| `go build ./cmd/server ./cmd/multica` | Passed |
| Focused Go checks with `-race`, across compiler, service, handler, real HTTP router, CLI, GitHub adapter and migrator | Passed; latest run also includes legacy squad/rerun/wakeup cases |
| Full handler suite with `-race` after manifest fixes | Passed (149.511 seconds); subsequent full suite handler pass was 173.499 seconds |
| Full service, server-command, CLI-command, migrator and GitHub adapter suites in the broad Go run | Passed |
| `pnpm --filter @multica/core typecheck` | Passed |
| `pnpm --filter @multica/core test` | Passed: 186 files, 2448 tests |
| Latest focused core schema/realtime checks | Passed: 8 files, 106 tests, including reconnect invalidation |
| `pnpm --filter @multica/core lint` | No errors; two existing warnings in `platform/core-provider.tsx` |
| `git diff --check` | Passed |

The final focused Go check used the existing installed-agent CLI guard:

```sh
bash ../scripts/go-test-with-agent-cli-guard.sh -- go test -race \
  ./internal/handler ./internal/service ./cmd/server ./cmd/multica \
  ./internal/pipeline ./internal/integrations/ghsnapshot ./cmd/migrate \
  -run 'TestPipeline|TestRerun|TestSquad|TestIssueWakeupSquad|TestEveryConcurrent|TestConcurrentIndex|TestRepositoryArtifact|TestDialect|TestCompiler|TestStageBarrier|TestShipped|TestFailureCannot|TestResultsAnd|TestApprovalRevision|TestRetryKeeps|TestFailureRouting|TestCancellationDoesNotRun' \
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

## Check that is not green

`make test` was attempted twice and is **not reported as passing**. After fixing
the new migration cleanup registration and workspace deletion manifest, its
remaining failure was in the unchanged `internal/daemon/repocache` package.
Concurrent repository checkout tests reported
`stop process tree: operation not permitted`, including
`TestCreateIsolatedCheckoutImportsFetchedTipFromShallowCache`,
`TestReconcileCoAuthoredByHookInCheckoutMigratesReleasedHook`,
`TestRepeatedCheckoutKeepsLocalWork` and
`TestRepeatedCheckoutOnTaskBranchIsNoop`.

The unchanged base commit's complete repocache package passed independently
with `-race` (35.539 seconds); individual failing checkout tests also passed
when rerun independently. This does not establish that the baseline full suite
passes, or that the remaining concurrent failure is resolved. No repocache
production code was changed. The first broad run also had a WeCom timing-budget
failure; its independent rerun and the second broad run passed.

Because the regular-package half of `make test` failed, its later `pkg/agent`
half did not run. The new fake-executor evidence does not depend on that half.

## Deliberate capability boundaries and acceptance work

Capabilities do not claim conditional Hermes branching/joins, automatic
rollback, named outputs/consumes, artifact glob/regex expansion, remote YAML
includes, external GitLab Runner execution, automatic dialect conversion,
automation run_only, workspace-only draft definitions, or streaming CLI logs.
Hermes `output` and `exit_check` retain declarations only. Repository content
publication currently supports GitHub through workspace-bound installations;
an unavailable adapter/reference blocks required content rather than claiming
delivery.

The API and CLI are ready for parent-task review. The separate UI stage still
needs to implement the approved desktop/mobile interactions using these real
interfaces and to run its own accessibility/layout/end-to-end acceptance.
Production runtime behavior, actual installation content permissions and
production restart/deployment remain unverified. No merge, deployment or squad
mode change was performed in the user's workspace.
