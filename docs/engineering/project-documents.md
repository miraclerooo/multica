# Project documents API

Project documents persist Markdown specifications inside an existing project.
The API supplies persistence, revision checks, response schemas, and invalidation
events. The shared web/desktop Documents tab uses this contract as described below.
Editor uploads, categories, full-text search, and Agent context injection remain
separate work. There is no
`include_in_context` field or public sharing endpoint.

## Access and identity

Use the existing authenticated API client and workspace selector
(`X-Workspace-Slug` or `X-Workspace-ID`). All routes run under the same workspace
membership middleware as project routes. Projects currently have workspace-wide
visibility; documents introduce no additional audience or permission grants.
Every document query matches both `workspace_id` and `project_id`. Wrong project,
wrong workspace, missing document, and non-membership return 404. Anonymous
requests return 401.

Workspace members can create and edit. Task-token and cloud-PAT actors have
read-only document access, subject to their existing authentication and workspace
restrictions. Mutation attempts with those machine credentials return 403.

Only the document creator, a **member** project lead, or a workspace owner/admin
can delete. An agent lead does not grant deletion rights to that agent's owner.
`created_by` and `updated_by` are **user IDs** (`member.user_id`), not membership
row IDs. They are assigned by the server. For a member lead, `project.lead_id` is
also a user ID. Frontends can use these rules to show the delete action, then
show a confirmation and await the server result before removing the document.

## HTTP contract

All IDs below are UUIDs. Responses use the existing JSON error format
`{"error":"..."}`. Document objects are returned directly, without a wrapper.

| Method | Path | Request | Success |
| --- | --- | --- | --- |
| GET | `/api/projects/{id}/documents` | Optional `limit` (1–100, default 50), `offset` (nonnegative, default 0) | 200 `{documents: ProjectDocumentSummary[], total, limit, offset}` |
| POST | `/api/projects/{id}/documents` | `{title, content?, is_pinned?, position?}` | 201 `ProjectDocument` |
| GET | `/api/projects/{id}/documents/{docId}` | — | 200 `ProjectDocument` |
| PATCH | `/api/projects/{id}/documents/{docId}` | `{revision, title?, content?, is_pinned?, position?}` | 200 `ProjectDocument` |
| DELETE | `/api/projects/{id}/documents/{docId}?revision={revision}` | No body; revision required | 204, no body |

The list contains metadata plus `excerpt`, the first 240 Unicode characters of
the original Markdown; it never contains the full `content`. Render excerpts as
plain text. Rows sort by `is_pinned DESC, position ASC, updated_at DESC, id ASC`.
Pagination and total are live reads, not a multi-page snapshot; refresh after
reorder or mutation events. Use `total` for the Docs tab count.

`ProjectDocument` is:

```json
{
  "id": "<document UUID>",
  "workspace_id": "<workspace UUID>",
  "project_id": "<project UUID>",
  "title": "Architecture",
  "content": "# Architecture\n\nProject conventions.\n",
  "is_pinned": false,
  "position": 0,
  "revision": 1,
  "created_by": "<user UUID>",
  "updated_by": "<user UUID>",
  "created_at": "2026-10-29T12:00:00Z",
  "updated_at": "2026-10-29T12:00:00Z"
}
```

Titles are trimmed and must contain 1–200 Unicode characters. Content is stored
unchanged, including whitespace and code fences, with a 1 MiB UTF-8 byte limit.
NUL characters are rejected. Render Markdown using the existing sanitized
renderer; storing Markdown does not make embedded HTML trusted.
Creation defaults to empty content, `is_pinned=false`, and `position=0`.
Position accepts a signed 32-bit integer.

PATCH requires at least one editable field. Omitted fields keep their stored
values; `content:""`, `is_pinned:false`, and `position:0` are valid updates.
Explicit null, unknown fields (including ownership fields), malformed JSON,
invalid IDs, and missing/invalid revisions return 400. The transport body cap
permits JSON escaping of maximum-size content; exceeding it returns 413.

## Concurrent edits and deletion

Documents start at revision 1. Every successful PATCH atomically compares the
submitted revision and increments it, including a request that sets an existing
value again. Two saves using the same revision cannot both succeed. All fields,
including pin/order metadata, share this revision. A stale DELETE also fails
instead of discarding edits made since the delete confirmation was opened.

A stale PATCH or DELETE returns 409:

```json
{
  "error": "document changed; reload before saving or deleting",
  "code": "project_document_conflict",
  "current_revision": 4
}
```

There is no automatic merge or force-overwrite option. On conflict, keep the local
draft, fetch the latest document, and offer reload or an explicit merge. Never
silently retry the same content with `current_revision`: that would undo the
concurrency protection. If the document was deleted meanwhile, return 404.

Serialize saves per document, including pin/order edits and editor flushes.
Only adopt the revision from a successful response. On ambiguous network
failure, refetch before deciding whether to retry. POST has no idempotency key;
do not automatically retry a create whose outcome is unknown.

## Shared client and realtime integration

`@multica/core/api` now exposes:

```ts
api.listProjectDocuments(projectId, { limit: 50, offset: 0 });
api.getProjectDocument(projectId, documentId);
api.createProjectDocument(projectId, { title, content });
api.updateProjectDocument(projectId, documentId, { revision, content });
api.deleteProjectDocument(projectId, documentId, revision);
```

Types live in `packages/core/types/project.ts`; response schemas live in
`packages/core/projects/document-schema.ts`. Malformed document responses throw
instead of being mistaken for successful empty content. `ApiError.status` and
`ApiError.body.code` / `current_revision` expose the conflict contract.

WebSocket events use the repository's colon convention:

- `project_document:created`
- `project_document:updated`
- `project_document:deleted`

Each event has the standard `actor_type:"member"` / `actor_id` envelope and
payload `{project_id, document_id, revision}`. Create/update carry the saved
revision; delete carries the last persisted revision. Events are published only
after a successful write/commit, to the document's existing workspace room.
They contain neither Markdown nor caller-specific permission flags. Failed
validation, permission checks, conflicts, and failed commits emit no event.

Use workspace-scoped query keys such as
`["project-documents", wsId, projectId, "list", pagination]` and
`["project-documents", wsId, projectId, "detail", documentId]`. Invalidate the list
and matching detail on events. A dirty editor keeps its draft when a refetch
reveals a newer revision. Workspace/project deletion uses the existing
`workspace:deleted` / `project:deleted` events to clear descendant caches; it does
not emit one event per removed document. Refetch on reconnect: events are
invalidation hints, not a durable document history or a total order of changes.

## Web and desktop frontend

The shared `ProjectDetail` provides Issues / Documents tabs. `?tab=docs` opens
the board; `?tab=docs&doc=<UUID>` opens a document. The existing navigation adapter
handles both web routing and desktop tabs; no platform-specific document route
is required. List summaries are fetched through all pages for title/excerpt
filtering. There are no invented category or Agent-context fields.

The editor uses `ContentEditor` and the sanitized `ReadonlyContent` renderer.
Local drafts persist with their base revision in workspace-scoped storage.
Changes debounce for one second. Mode/document/tab changes flush pending editor
text; unmount and page-hide also flush, with browser drafts retained if the
network cannot finish. Save requests, including pin and order changes, serialize
per document and send **`revision`**, never `expected_revision`. Reordering uses
the existing PATCH `position` field; there is no bulk reorder endpoint, so a
partial failure refreshes the list and surfaces the affected document.

409 pauses automatic saving and retains the local draft. Loading the remote
version requires an explicit confirmation; copying the local draft remains
available. 403/404 and ambiguous network failures retain drafts as well. Retry
refetches before writing and never advances a stale draft's revision to force
an overwrite. Delete confirms against a captured revision and waits for success.
Creation has no automatic retries because the API has no idempotency key.

Document events invalidate the list and matching detail; reconnect invalidates
all document queries in the active workspace. An incoming revision never replaces
a dirty draft. The current UI does not upload document attachments or inject
documents into Agent context.

Verification: `e2e/project-documents.spec.ts` exercises the real API for creation,
editing, navigation flush, a competing 409 write, reload recovery, and deletion.
The permission scenario uses a real ordinary member and a controlled 403 response
to verify that the browser preserves a denied draft. Save serialization, limits,
pagination, and deletion eligibility have canonical core tests.

## Persistence and rollout

Apply migrations 595–598 before deploying the API. The table has no foreign keys;
ownership is checked in handlers and parent deletion cleans documents in its
existing transaction. Creation acquires workspace then project key-share locks
to participate in the existing parent-deletion protocol and avoid orphan rows.
Indexes are built concurrently in separate migrations, with invalid-index retry
cleanup registered in the migration runner.

Deploy the server before enabling the Docs frontend. Existing clients continue
working because this API is additive. Rolling these migrations down removes all
project documents; preserve data before a production rollback.
