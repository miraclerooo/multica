# Pipeline and task document interfaces (YANF-8)

The v1.6 definition canvas builds on released main `9b8d8917824c01db67389436dfcea10f189a6d82`, tree `054c19bf51c0a1c5ff3ebdd9d027ac256f5217ef`. It adds node and connection editing to the existing shared Web/Desktop definition route. It reuses catalog, definition and validation APIs; backend, compiler, scheduler and CLI semantics are unchanged. The released v1.5 selection/continuation and v1.4 Markdown/R07/D01/R2-01 protections remain in place. Earlier delivery records below are explicitly historical.

## Entry points

- Squad → Pipeline: named catalog, new/rename, independent version histories and a separately saved squad default; capabilities, dialect drafts, source diagnostics, compiled graph, complete-roster bindings, version comparison, immutable saves and atomic activation. Unsupported kinds remain readable with writes disabled. Dialect changes keep separate drafts; they do not convert or replace the original instructions.
- Issue → Pipeline card → `/{workspace}/pipelines/{run}`: history, actual nodes, attempt selection, task logs, dependencies, pinned materials, retry, cancel and human decisions. The Web and Desktop routers mount the same view; Desktop also recognizes the new tab subject and diagnostics route.
- Mika workbench: sends the current source, selected dialect, squad policy and full roster through the existing chat API. A complete returned YAML block must compile before adoption. Adoption keeps a draft; save/activation remains explicit. Unobtained reference files are identified as such.
- Issue deliverable viewer / pipeline artifact catalog → Link to project document: select a same-project Markdown document or create one, append a source through the real association API, and retain form fields on conflict. Issue documents provide reverse navigation and relationship-only unlinking.
- Project → Specs & Docs: task groups keyed by stable issue IDs, current task names, server-side search, unassociated Project materials, existing Markdown editing/history and source provenance. Fixed internal Markdown content links use authenticated transport on Web, Desktop and mobile; external URLs keep their ordinary link behavior.
- Mobile → More → Pipelines: squad/catalog/version/default formSheet pickers and native text editing for YAML. New Issue has its own execution picker, preview and confirmed result/continuation. Issue views retain run history, vertical nodes, transcripts, fixed materials, approval and grouped Markdown. Interactive graph editing and Mika authoring remain on Web/Desktop.

## v1.6 document and canvas editing

`packages/core/pipelines/document.ts` projects the user's YAML document into editable nodes and provenance-tagged connections. Commands change a fresh YAML AST transactionally; they never regenerate a whole source from a compiled plan. Comments, full instructions, untouched configuration, paths, declarations and actual references survive edits. GitLab uses job IDs without inventing titles. Hermes uses state IDs and titles, plus actual `state.gate` references and `gates` declarations; generated gate IDs never become new states.

The shared definition editor offers node creation/properties/deletion, selection, node dragging, background panning, zoom/fit, port connection/reconnection and equivalent endpoint forms. GitLab needs, stage inference and dependencies materials have distinct line types. Replacing inference requires confirmation and preserves other references. A needs/dependencies conflict keeps the original materials and requests a YAML policy choice. Hermes supports the existing forward chain; branches/joins/cycles stay unsupported. Deleting a node or gate previews affected references and never adds a bridge. Removing a Hermes gate also removes its outgoing state edge, leaving a repairable draft instead of bypassing the gate.

Properties use complete instruction text, current agent roles/leader fallback, supported conditions, integer retries 0–10, exact artifact paths, owner roles and existing Hermes output/exit-check configuration. Manual gates omit executor/retry/output controls. The owner string is a human squad role, as validated by the existing binding service. YAML and canvas share the same scoped draft and undo/redo history, including keyboard undo in YAML. Current draft content and bounded history persist; layout/viewport preferences live separately under workspace/squad/logical-pipeline keys and never enter a save request.

An invalid or unsafe source stays unchanged. The last safely mapped diagram is visibly read-only; forced form/port callbacks cannot write it over the new input. Unknown compiler/capabilities and in-flight saves also guard handlers. Validation is keyed to the submitted source, and Save requires the current response with understood compiler/kind and no binding failure. History previews and run diagrams remain read-only. Edit current definition opens the current draft; version conflicts preserve local source for comparison, explicit review or reload. Reload retains a recoverable local copy.

All writes still use `POST /api/pipelines/catalog` or `/definitions` with the existing source, identity, CAS and idempotency contracts; `POST /validate` returns the actual executable plan/hash. Saving a version and enabling a squad default remain separate. No coordinates, node CRUD API, new runtime capability, CLI upgrade or daemon restart is required. Native mobile retains its existing viewing/approval/YAML and Web/Desktop canvas guidance; this is not a new native canvas.

Canonical ownership: `document.test.ts` covers AST/semantic matrices, `editor.test.ts` covers shared history/layout isolation, `definition-canvas.test.tsx` covers actual form/callback protection, and `e2e/pipeline-canvas.spec.ts` covers authenticated browser/API compilation, pointer and keyboard actions, 390px, independent pipelines and real 409 recovery. New product screenshots are in `ui-evidence/v1.6/`; old screenshots and counts below are not evidence for these new interactions. Native/Electron visuals and real agent execution remain outside this local verification.

### v1.6 local verification

| Check | Observed result |
| --- | --- |
| Core pipeline canonical tests | 6 files, 100 passing cases, including AST edits, history/layout isolation and the existing R07/D01/R2 rules |
| Shared views pipeline canonical tests | 4 files, 43 passing cases, including actual forms and forced callback protection |
| Authenticated Chromium product tests | 5 distinct scenarios passed: 3 canvas scenarios plus the existing source/activation and Hermes role regressions |
| 390px evidence refresh | The Hermes browser scenario passed again after fitting the entire graph and capturing stable graph/property screenshots; this is the same scenario, not an additional acceptance item |
| Types | Core, shared views, Web, Desktop main/preload and renderer passed |
| Targeted lint | Core pipeline TS, shared pipeline TSX, new E2E using the repository base config and changed landing dictionaries passed |
| Copy and docs | 5 landing dictionary cases passed; 6 canvas locale keysets match (73 nonempty strings each); docs MDX generation and whitespace checks passed |

The browser fixtures use the managed local backend/PostgreSQL with fake executor identities and a real human squad role. They inspect actual save responses and server-compiled plans/hashes, original immutable definitions, a previously frozen task selection and an actual version-conflict response. The three new scenarios do not execute a paid agent. The 390px shots are responsive Web, not native device screenshots. The historical runtime recovery/cancellation, native/Electron/cross-client, Mika/real agent/GitHub, repocache EPERM versus later single-package 114, approval 5-second versus 15-second and A29 extension boundaries below remain unchanged. This is implementation evidence for review, not completion of all 65 acceptance items.

## v1.5 selection and continuation

The shared Web/Desktop squad route mounts `catalog-workspace.tsx` around the existing YAML/graph editor. Catalog entries use `GET/POST /api/pipelines/catalog` and `PATCH /catalog/:id`; their `executable_definition_id` is loaded to display actual kind and independent version. Editor histories filter by `pipeline_id`. Saving a version alone does not alter the squad default. An empty default selector opens creation instead of writing an invalid binding.

Manual New Issue, including manual comment-source capture, uses `POST /api/pipelines/preflight`. Choices are remembered by squad; a personal/different squad assignment cannot submit foreign IDs. The explicit pipeline request carries the displayed `definition_id`, its `pipeline_id`, and one stable create receipt. The agent-assisted capture API has no task execution selector: its squad action carries the prompt and actor into the manual form for direct execution selection; it does not send invented quick-create fields or start a second path.

Confirmed squad creation shows the actual issue and saved selection immediately. A malformed selection acknowledgement retains the draft and provides the already-created issue for inspection. Recheck uses `GET /api/issues/:id/execution`; continuation uses `POST /execution/start` on that ID, never another create. Publishing a later version does not replace the saved version. Human/server capability checks and `canStartIssueExecution` protect the button and callback.

The client consumes the four backend feature flags. Runtime support comes from the returned readiness/capabilities, not version-string guesses. Daemon and observed disk identity remain separate; null disk data stays unknown. Upgrade actions follow the response: user-executed official update, safe deployment guide, unconfigured channel, or wait/recheck. Nothing upgrades, restarts or generates an agent run merely to inspect compatibility.

Server data stays in Query. Draft source/name, reviewed catalog/squad revision, selected version and creation receipt stay client-owned. Source fields wait for their original definition before editing. Own rename/save operations are serialized; external revision conflicts preserve source for explicit comparison. A legacy squad draft can be adopted into its one migrated catalog identity without overwriting an existing independent draft. Mobile owns all requests/queries/subscriptions and draft stores, including logout cleanup; it imports only pure rules/schemas and types from core.

The browser canonical flow is `e2e/pipeline-selection.spec.ts`. It uses authenticated local HTTP/PostgreSQL and fake executors/build reports. Mobile Node tests verify its independent transport and draft logic; iOS export verifies bundling. No simulator is installed, so these are not native rendering/press/keyboard or cross-client reconnect claims. Web/Desktop share the production route; Electron window visuals remain unverified. The historical full Go repocache EPERM and later 114-case single-package result, old approval 5-second timeout/15-second passing configuration, and real Mika/agent/GitHub execution limits remain applicable. This delivery does not certify all 55 acceptance items.

## Historical v1.5 verification

These checks cover the new UI delta on backend `96e39979ab57651082bb20191518df978b493a55`:

| Check | Result |
| --- | --- |
| Core pipeline and API schema tests | 181 passed in 6 files |
| Shared pipeline views and manual/quick creation tests | 133 passed in 7 files; includes forced callbacks after permission/capability loss, squad quick-capture handoff and the dialog shell |
| Mobile | 297 tests and iOS wrapper checks passed; final independent transport/draft selection subset: 8 passed. Typecheck and lint passed |
| Types | Core, views, Web, Desktop node/renderer and mobile passed |
| Relevant lint / docs | Core, views and mobile passed; landing dictionary checks: 5 passed; Fumadocs MDX generation passed |
| Real browser/API | Four v1.5 flows plus the two affected original YAML/dialect and Hermes role-binding regressions passed |
| iOS export | Hermes bundle and DOM reader exported; no native visual or IPA claim |

The new browser flows cover independent GitLab/Hermes catalogs, rename/save/default isolation, empty-default guidance, squad/personal reassignment, pinned selection, separate daemon/disk readiness, keyboard operation, continuation of the same issue after a newer version is published, and idempotent repeat start. Squad quick creation carries the prompt into execution selection without a quick-create request. The creation body scrolls independently of its footer; the Create action stays fully visible at 390×844 and 390×500. Build reports are controlled test fixtures, not observations of a real daemon upgrade.

Current captures live in `ui-evidence/v1.5/`: catalog at Desktop/390px, separate narrow editor, creation choice, quick-capture handoff, blocked daemon readiness with expanded identities, same-issue start, and dark result. Captures wait for the relevant data and finish CSS transitions. The parent directory contains historical v1.4 evidence.

## State and concurrency

Server snapshots stay in TanStack Query. Core stores retain YAML and approval drafts plus node selection for Web/Desktop. Approval opinions retain the revision that was reviewed, including after responsive remounts or a competing decision. YAML activation uses the squad revision captured when editing began; a newer WebSocket snapshot does not silently rebase it. Explicit comparison/review updates the expected revision. Save idempotency keys survive retries and reloads of a draft; a confirmed new run receives a new operation key.

Mika conversation pointers and unsent requirements also survive closing the workbench. Completion uses the real `chat_session_id` protocol and the existing pending-task query, with API refresh after missed events.

Run controls require a known dialect, compiler v1 plan, node capabilities and run/node statuses. Unknown values remain readable with a localized reason and their original value. The same pure policy drives shared Web/Desktop controls and mobile approval, including submission guards. Known active states include queued, running, waiting approval and blocked: an independent agent running alongside a waiting gate does not disable that gate. Retry retains the engine's support for failed agents in understood failed/succeeded runs; cancelled, cancelling and rejected runs stay inoperable. Existing permission, materials, review-revision and opinion checks remain in place.

The mobile client owns its requests, queries, mutations, realtime subscriptions and review input. It imports only shared types, pure schemas and utilities. Its request transport keeps bearer auth, workspace headers, timeout/abort forwarding, logging and 401 cleanup. Octet-stream repository material types are resolved from their fixed filenames; unsupported native formats provide an explicit Web route instead of a blank preview. The material reader uses the same transport rather than opening unauthenticated API URLs in the system browser.

## Historical v1.4 verification

The following records are retained from the previous v1.4 deliveries; they were not all repeated for v1.5. Commands ran against an isolated managed development database and API, using source-built server and CLI. No installed agent CLI or paid agent was invoked. Pipeline E2E fixtures persist a completed/failed fake executor snapshot; compilation, configuration, artifact-content reads, document writes, decisions, retry and cancellation use real authenticated HTTP endpoints.

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

The former v1.4 UI PR #7 depended on backend PR #6. Both are historical. The new v1.5 UI branch is stacked on backend PR #8 (`agent/YANF-7-multiple-pipelines-v1.5`), so its review contains the new interface delta. Nothing in this delivery merges or deploys either branch.
