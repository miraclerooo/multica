# Project Specs & Docs verification

Implementation for YANF-4 and parent YANF-2, against the confirmed three-column prototype. The implementation contract is in [project-documents.md](project-documents.md).

## Automated verification

| Check | Result |
| --- | --- |
| `make sqlc` | Generated models and queries are included. |
| Migration round trip | Up → down → up passes in an isolated PostgreSQL schema; rollback removes document references and keeps repository resources. |
| `make test` | Passed, including the race detector and the throttled `pkg/agent` suite. Development services were stopped so background maintenance could not alter test fixtures. |
| Document handlers | Six DB-backed tests pass with `-race`: templates/lifecycle, real competing HTTP writes, author and scope validation, transaction rollback, run-resource discovery, workspace cleanup. |
| CLI contracts | URI resolution, create/list/get/history, full snapshot updates and conflict propagation pass. The complete CLI suite also passes with `-race`. |
| Core document tests | 13 tests pass: original draft baselines, document/workspace isolation, edits during save, late callbacks, failure/conflict retention, Markdown structure, malformed API responses. |
| `pnpm typecheck` | All 10 workspaces pass, including web and desktop. |
| `pnpm lint` | All seven lint tasks pass; existing repository warnings remain. |
| `pnpm test --concurrency=2` | All eight tasks pass; core has 2,432 tests and shared views have 6,493 tests. |
| `pnpm --filter @multica/desktop build` | Main, preload and renderer build successfully. |
| Browser E2E | All four full-stack cases pass against the final implementation, including the built source CLI (29.2 seconds). |

The browser suite is `e2e/project-documents.spec.ts`. Run it against `make up` with a freshly built source CLI:

```bash
cd server
go build -o ../server/bin/multica-docs-test ./cmd/multica
cd ..
MULTICA_E2E_CLI="$PWD/server/bin/multica-docs-test" make env-exec ARGS="-- pnpm exec playwright test e2e/project-documents.spec.ts"
```

The agent test uses a test-created, workspace-bound task credential through the real auth middleware. It starts no external coding agent. It reads a document by URI, submits a revision through the built CLI, observes the updated title/body/agent author in the browser through WebSocket invalidation, discovers and resolves the project resource, and verifies that forged actor headers cannot impersonate that agent. A foreign workspace and a different project both reject access.

The other browser cases cover both document kinds, all three modes, Markdown checkbox synchronization, REQ deep links, saving/reload, confirmation and discard, narrow-screen directory/details sheets, unsaved/failed/conflicting drafts across navigation and reload, and a delayed save finishing after another document has opened. Real remote writes advance the document after a comparison is opened; the previously viewed version is rejected again with 409, and copying retains both the local title and body.

The HTTP competition test submits two requests against the same base version through an HTTP server backed by PostgreSQL: exactly one succeeds and the other receives 409. Revision insertion failure also rolls back the document update.

## Screenshots

- [Light workspace](../assets/yanf-4/spec-workspace-light.png)
- [Dark workspace](../assets/yanf-4/spec-workspace-dark.png)
- [Split editor](../assets/yanf-4/spec-editor-split.png)
- [Actual conflict and original base](../assets/yanf-4/spec-revision-diff.png)

Both themes were captured through the application's system-theme handling, including the native color scheme. The screenshots are from the running development application, with saved data and real API requests. The reference prototype was also opened in Chromium to check its mode switches, new-document choices and comparison flow; its mock storage and conflict actions were replaced by the production data path.

## Boundaries and operational notes

- The body limit is 1 MiB; titles allow 300 Unicode code points. Validation errors preserve the draft and are shown in the workspace.
- Drafts are local to the device and are cleared by account cleanup. Other members and runs read saved revisions only. Collaboration is revision-based, rather than character-by-character coediting.
- Desktop uses the same shared project view and passed typechecking and the production build. Native Electron GUI interaction was not separately exercised.
- Concurrent index migrations include the repository's invalid-index retry registrations. The pre-existing migration 596 registration and `user_password` workspace-deletion classification were also completed because the schema coverage checks exposed those omissions.
- The CLI test harness now isolates its working directory as well as its home, so ancestor daemon-task markers do not change member-credential contract tests. An unrelated floating-chat observer timing test passed on isolated rerun and in the complete frontend rerun; no chat product code was changed.
