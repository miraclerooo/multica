# Project Specs & Docs (YANF-4 / YANF-2)

## Scope

Projects expose a shared web/desktop three-column document workspace: grouped, searchable directory; Markdown reading/direct editing, split preview and source; resource information, recent editors and revision history. A lightweight Spec template contains context/goals, numbered REQ headings, WHEN/THEN scenarios and Markdown task lists. OpenSpec is a content reference only; there is no new dependency, approval, archive or Git synchronization workflow.

## Storage and API contract

- `project_document` stores workspace/project, kind (`spec` or `document`), title, Markdown body, current integer version and latest author/time. `project_document_revision` stores immutable full snapshots, including title, body, base version, author type/ID/name and timestamp. No foreign keys; application transactions maintain relationships.
- `GET/POST /api/projects/{id}/documents` discovers/creates documents. Creation writes version 1, its revision and a `project_document` project resource in one transaction.
- `GET/PUT /api/projects/{id}/documents/{documentId}` reads the latest saved snapshot or saves a new revision. PUT requires `base_version`, title and body. A conditional UPDATE checks workspace/project/document/version atomically; revision insertion shares the transaction. A stale request returns 409 with the latest snapshot and never overwrites it.
- `GET /api/projects/{id}/documents/{documentId}/revisions` returns immutable snapshots. All endpoints reuse project/workspace membership and authenticated actor attribution; clients cannot choose authors.
- Resource references are `multica://project/{projectUUID}/documents/{documentUUID}`. `GET /api/projects/{id}/resources/{resourceId}/content` resolves a document resource to the latest saved document. `multica project document list|get|create|update|history` uses the same endpoints, including required base versions. Task context advertises these resources and the commands needed to read their current contents.

## Draft and conflict rules

Client-owned Zustand drafts use the platform StorageAdapter and are keyed by workspace, project and document. A draft includes its original base snapshot/version, local title/body and failure/conflict state. Navigation never saves implicitly. An acknowledged save advances only its own document and preserves edits made while the request was pending. Failed and conflicting drafts survive navigation and reload; discard requires confirmation. Query caches own saved server data.

The conflict dialog shows the actual original base, local title/body and viewed remote title/body, with line differences. Users can save a separate local copy, adopt remote after confirming discard, or explicitly save local against the viewed remote version. The last option still submits that exact version; any subsequent remote update produces another 409. Copies preserve both local title and body. History comparison includes titles and bodies of both chosen snapshots.

## Acceptance and verification

- Create both kinds; switch all three modes; edit and check Markdown tasks; save, reload and read the same snapshot.
- Switch documents or leave/reopen with dirty, failed and conflicting drafts; reload restores them. Finish a request after switching documents without altering the other document; edits during save remain dirty.
- Verify human/agent author, timestamps, immutable versions and base versions; compare title-only and body changes.
- Send competing real HTTP writes at one base: exactly one succeeds, one returns 409. Update remote after opening comparison: the previously viewed base is rejected again.
- Read and revise through the CLI/API, discover and resolve the project resource, and read the agent revision from the web.
- Reject foreign workspace/project/document and resource references, invalid fields and unsupported kinds. Clean up document rows/revisions when deleting their project.
- Verify shared web/desktop entry points, accessible dialogs and narrow-screen overflow, light/dark screenshots, API malformed-response tests, draft/state unit tests, handler/CLI integration tests and browser E2E.

Verification results and remaining limits are recorded with the implementation handoff.
