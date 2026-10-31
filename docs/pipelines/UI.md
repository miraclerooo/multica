# Pipeline and task document interfaces (YANF-8)

The UI follows the approved pipeline and Markdown-document prototypes. Its initial engine/API baseline was PR #6 at `0e3a755d1da07e62ca3575cd103b6e774eeb6f2b`; it now also incorporates the independently verified D02 backend commit `009ad8d7343db0278e42f1c06805407fc304c014`. That integration changes CLI error handling, without changing the engine/API or migrations.

## Entry points

- Squad → Pipeline: capabilities, dialect drafts, source diagnostics, compiled graph, complete-roster bindings, version comparison, immutable saves and atomic activation. Unsupported kinds remain readable with writes disabled. Dialect changes keep separate drafts; they do not convert or replace the original instructions.
- Issue → Pipeline card → `/{workspace}/pipelines/{run}`: history, actual nodes, attempt selection, task logs, dependencies, pinned materials, retry, cancel and human decisions. The Web and Desktop routers mount the same view; Desktop also recognizes the new tab subject and diagnostics route.
- Mika workbench: sends the current source, selected dialect, squad policy and full roster through the existing chat API. A complete returned YAML block must compile before adoption. Adoption keeps a draft; save/activation remains explicit. Unobtained reference files are identified as such.
- Issue deliverable viewer / pipeline artifact catalog → Link to project document: select a same-project Markdown document or create one, append a source through the real association API, and retain form fields on conflict. Issue documents provide reverse navigation and relationship-only unlinking.
- Project → Specs & Docs: task groups keyed by stable issue IDs, current task names, server-side search, unassociated Project materials, existing Markdown editing/history and source provenance. Fixed internal Markdown content links use authenticated transport on Web, Desktop and mobile; external URLs keep their ordinary link behavior.
- Mobile: issue run history, vertical nodes, attempts and existing task transcript routes, fixed material readers, approval and grouped Markdown reading. YAML editing stays on Web/Desktop.

## State and concurrency

Server snapshots stay in TanStack Query. Core stores retain YAML and approval drafts plus node selection for Web/Desktop. Approval opinions retain the revision that was reviewed, including after responsive remounts or a competing decision. YAML activation uses the squad revision captured when editing began; a newer WebSocket snapshot does not silently rebase it. Explicit comparison/review updates the expected revision. Save idempotency keys survive retries and reloads of a draft; a confirmed new run receives a new operation key.

Mika conversation pointers and unsent requirements also survive closing the workbench. Completion uses the real `chat_session_id` protocol and the existing pending-task query, with API refresh after missed events.

Run controls require a known dialect, compiler v1 plan, node capabilities and run/node statuses. Unknown values remain readable with a localized reason and their original value. The same pure policy drives shared Web/Desktop controls and mobile approval, including submission guards. Known active states include queued, running, waiting approval and blocked: an independent agent running alongside a waiting gate does not disable that gate. Retry retains the engine's support for failed agents in understood failed/succeeded runs; cancelled, cancelling and rejected runs stay inoperable. Existing permission, materials, review-revision and opinion checks remain in place.

The mobile client owns its requests, queries, mutations, realtime subscriptions and review input. It imports only shared types, pure schemas and utilities. Its request transport keeps bearer auth, workspace headers, timeout/abort forwarding, logging and 401 cleanup. Octet-stream repository material types are resolved from their fixed filenames; unsupported native formats provide an explicit Web route instead of a blank preview. The material reader uses the same transport rather than opening unauthenticated API URLs in the system browser.

## Verification

Commands ran against an isolated managed development database and API, using source-built server and CLI. No installed agent CLI or paid agent was invoked. Pipeline E2E fixtures persist a completed/failed fake executor snapshot; compilation, configuration, artifact-content reads, document writes, decisions, retry and cancellation use real authenticated HTTP endpoints.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | All 10 tasks passed, including Web and Desktop |
| `pnpm lint` | All 7 tasks passed; existing repository warnings remain |
| `pnpm test --concurrency=1` | All 8 tasks passed: UI 326, docs 19, UI Lab 46, Web 293, core 2,466, Desktop 788, views 6,497 (10,435 tests) |
| Final core pipeline/content-link tests | 12 passed, including a later regression for the captured configuration revision |
| Final pipeline view / link routing tests | 11 passed, including read-only keyboard protection, unknown kinds and Mika completion/adoption without automatic publication |
| Mobile typecheck / lint / tests | Passed; 289 tests plus iOS wrapper assertions |
| Expo iOS export | Hermes bundle and DOM material reader exported successfully; this is a bundle check, not native rendering or an IPA |
| Real API E2E | All 7 scenarios passed, no skips; the three pipeline scenarios also assert no uncaught browser errors |
| Final 390px document-directory recheck | The affected real API scenario passed again; checks completed search, opaque sheet positioning, separate New/Close targets, creation dialog and focus restoration, plus no horizontal page overflow |
| Hermes role-binding correction (R07) | 14 core pipeline tests, 3 squad view tests, core/views typechecks and helper lint passed; one new actual-browser/API scenario verifies selection and leader fallback remain valid and saveable |
| Unknown-state/plan controls (D01/A28) | 39 core pipeline tests and 18 shared view tests passed; callback probes verify zero decision/retry/cancel requests for unfamiliar snapshots, with concurrent-gate and revision/material/permission controls. Core/views/mobile types, relevant lint and 289 mobile tests passed |
| D02 integration delta | Merged the verified backend commit, preserving both parent histories. Server source and backend contract docs match that commit; the existing CLI error/failed-run-query contract test passed. The already verified 40 process scenarios and race results were reused |
| `git diff --check` | Passed |

Pipeline E2E covers both real compilers, source preservation across dialects, dynamic plans, save versus activation, stale squad revisions, fixed v1 material after a v2 edit, document association 409 comparison/retry, idempotent insertion, task grouping/search, authenticated body-link opening, approval races with retained comments, 390px light/dark reading, upstream waits, attempt history, retry and cancellation. Existing document E2E exercises all editing modes, draft recovery, optimistic conflict comparison/copy, actual source CLI revisions and access checks.

Screenshots in `ui-evidence/` come from the actual Web product and authenticated test fixtures. The 390px images are browser viewports, not iPhone screenshots. The issue's approved prototype is the design reference; it is not presented as a product screenshot.

The task-directory capture waits for search completion and the sheet's opening transition to finish. `task-markdown-390.png` replaces an earlier translucent transition capture; `task-markdown-body-390.png` shows the unobstructed body separately. The recheck also fixed overlapping New/Close controls and the nested trigger that previously closed the sheet without opening the creation form.

Hermes role selection adds a missing `roles` declaration alongside the selected state's `by` field. Existing declarations, comments and custom instructions remain in the YAML model. Selecting the leader removes only that state's `by`; declarations and other states' references remain. Canonical helper cases cover absent/empty roles, new and existing roles, repeated selection, and leader fallback. `hermes-role-selected.png` and `hermes-role-leader.png` show the actual single-member squad; both authenticated validation responses have `syntax_valid: true`, `binding_valid: true` and no diagnostics.

PM's independent material/approval replay timed out twice at the default five-second Approve expectation, then passed with a fifteen-second review configuration. That waiting difference is retained separately from R07, which was a reproducible missing-declaration error. The R07 correction did not change the approval scenario or global expectation settings, and did not repeat the original full suites or the accepted 390px work.

## Acceptance evidence and limits

- A03–A06, A30–A37: capability-driven dialects, original-source preservation, complete roster bindings, custom compiled nodes and immutable configuration. Browser tests use leader-only squads and both dialects; helper tests cover custom binding edits and unchanged instructions.
- A15/A17/A18/A19/A21/A26/A41/A42: actual retry/cancel/decision/content APIs, attempts, declaration-versus-publication, pinned revisions, conflict drafts and unpriced usage. The server remains authoritative for permissions, availability and scheduling.
- A25/A38–A44: shared routes, readonly controls, task groups/search, Markdown body links, source association, retained human paragraphs, reverse references, unlink controls and responsive browsing. The four pre-existing document scenarios are retained as regressions.

Native device/simulator visual checks (keyboard, scrolling, themes, navigation and reconnect across clients) and Electron window visual checks remain unverified. Xcode/simctl is unavailable on this machine. Mika generation and a real agent/GitHub-installation execution were not exercised: the tests use fake executors and do not claim a full real-runtime acceptance. Unsupported backend capabilities, including dialect conversion and Hermes branches/rollback, remain unsupported. The comprehensive Go suite was not rerun for this UI-only change; backend evidence and its known repocache EPERM limitation remain in PR #6.

The D01 component probes use the actual shared view and schema-parsed API snapshots with mocked transport, not a server authorization-bypass test. Mobile reuses the tested pure policy and passed its own code checks; native press/rendering was not reproduced. YANF-9's later repocache single-package run of 114 passing cases does not resolve the historical concurrent full-suite EPERM failure.

The UI PR depends on PR #6. It is stacked on that branch so review contains only the interface changes; retarget to main after the backend is integrated. Nothing in this delivery merges or deploys either PR.
