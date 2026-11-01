// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { IssueSchema } from "../api/schemas";
import { IssueExecutionSchema, canStartIssueExecution, PIPELINE_SELECTION_CAPABILITY, selectionFromPreview, safeUpgradeGuide } from "./execution";
import { PipelineCatalogSchema } from "./schema";

afterEach(() => vi.unstubAllGlobals());
const snapshot = {
  requested_mode: "pipeline", mode: "pipeline", squad_id: "s", pipeline_id: "p", pipeline_name: "Custom",
  definition_id: "d1", definition_revision: 1, creator_id: "human", state: "waiting_runtime",
  readiness: {ready: false, runtimes: [{runtime_id: "r", status: "unknown"}]},
};
const issue = {
  id: "i", workspace_id: "w", number: 1, identifier: "P-1", title: "Draft", description: null, status: "todo", priority: "none",
  assignee_type: "squad", assignee_id: "s", creator_type: "member", creator_id: "human", parent_issue_id: null,
  project_id: null, position: 0, stage: null, start_date: null, due_date: null, created_at: "now", updated_at: "now",
};
const capabilities = {schema_version: 1, compiler_version: "v1", kinds: ["gitlab_yaml", "hermes_yaml"], features: {task_execution_selection: true}};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

it("pins the explicit previewed definition and keeps default/guidance selectors free of stale IDs", () => {
  const preview = IssueExecutionSchema.parse(snapshot);
  expect(selectionFromPreview({mode: "pipeline", pipeline_id: "p"}, preview)).toEqual({mode: "pipeline", pipeline_id: "p", definition_id: "d1"});
  expect(selectionFromPreview({mode: "default"}, {...preview, requested_mode: "default"})).toEqual({mode: "default"});
  expect(selectionFromPreview({mode: "markdown"}, {...preview, requested_mode: "markdown", mode: "markdown"})).toEqual({mode: "markdown"});
});
it.each([
  {pipeline_id: "foreign"}, {definition_id: ""}, {mode: "future_mode"}, {state: "future_hold"}, {requested_mode: "default"},
])("does not submit an incompatible or foreign preview %j", change => {
  expect(selectionFromPreview({mode: "pipeline", pipeline_id: "p"}, IssueExecutionSchema.parse({...snapshot, ...change}))).toBeNull();
});
it("refuses a different version than the explicit choice", () => {
  expect(selectionFromPreview({mode: "pipeline", pipeline_id: "p", definition_id: "d2"}, IssueExecutionSchema.parse(snapshot))).toBeNull();
});
it.each(["http://example.com/guide", "https://user:secret@example.com/guide", "https://example.com/?token=sample", "https://example.com/#secret", "javascript:alert(1)", "invalid"])("refuses unsafe upgrade destinations %s", value => {
  expect(safeUpgradeGuide(value)).toBeNull();
});
it("accepts a public HTTPS deployment guide without tokens", () => expect(safeUpgradeGuide("https://example.com/deployment")).toBe("https://example.com/deployment"));

it("does not infer support or disk identity from a daemon version", () => {
  const parsed = IssueExecutionSchema.parse(snapshot);
  expect(canStartIssueExecution(parsed)).toBe(false);
  expect(parsed.readiness.runtimes[0]?.disk).toBeNull();
  expect(parsed.readiness.runtimes[0]?.daemon.release_channel).toBe("unknown");
  expect(canStartIssueExecution({...parsed, readiness: {ready: true, runtimes: parsed.readiness.runtimes}})).toBe(false);
  const observed = {...parsed.readiness.runtimes[0]!, status: "supported", daemon: {...parsed.readiness.runtimes[0]!.daemon, capabilities: [PIPELINE_SELECTION_CAPABILITY]}, disk: {...parsed.readiness.runtimes[0]!.daemon, capabilities: [PIPELINE_SELECTION_CAPABILITY]}};
  expect(canStartIssueExecution({...parsed, readiness: {ready: true, runtimes: [observed]}})).toBe(true);
  expect(canStartIssueExecution({...parsed, readiness: {ready: true, runtimes: [{...observed, disk: null}]}})).toBe(false);
  expect(canStartIssueExecution({...parsed, definition_id: undefined, readiness: {ready: true, runtimes: [observed]}})).toBe(false);
  expect(canStartIssueExecution({...parsed, state: "future_state", readiness: {ready: true, runtimes: []}})).toBe(false);
  expect(IssueSchema.parse({...issue, execution: {mode: true}}).execution).toBeNull();
  expect(IssueSchema.parse(issue).execution).toBeUndefined();
});

it.each([{}, {features: {}}, {...capabilities, features: {task_execution_selection: false}}])("refuses an old or malformed server before creating a selected task", async value => {
  const fetch = vi.fn().mockResolvedValue(response(value)); vi.stubGlobal("fetch", fetch);
  await expect(new ApiClient("https://api.example.test").createIssue({title: "Draft", assignee_type: "squad", assignee_id: "s", execution: {mode: "markdown"}})).rejects.toMatchObject({body: {code: "unsupported_capability"}});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("submits and acknowledges the fixed selection in one create mutation", async () => {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/capabilities") ? capabilities : {...issue, execution: snapshot}, url.endsWith("/capabilities") ? 200 : 201)));
  vi.stubGlobal("fetch", fetch);
  const input = {title: "Draft", assignee_type: "squad" as const, assignee_id: "s", execution: {mode: "pipeline" as const, pipeline_id: "p", definition_id: "d1"}, idempotency_key: "same-create"};
  const out = await new ApiClient("https://api.example.test").createIssue(input);
  expect(out.execution).toMatchObject({pipeline_id: "p", definition_id: "d1", state: "waiting_runtime"});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(input);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it.each([undefined, {...snapshot, pipeline_id: "other"}, {...snapshot, definition_id: "other"}])("rejects an unacknowledged selection and keeps the mutation failed", async execution => {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/capabilities") ? capabilities : {...issue, execution})));
  vi.stubGlobal("fetch", fetch);
  await expect(new ApiClient("https://api.example.test").createIssue({title: "Draft", execution: {mode: "pipeline", pipeline_id: "p", definition_id: "d1"}})).rejects.toMatchObject({body: {code: "execution_snapshot_missing"}});
});

it("leaves omitted execution compatible with older servers", async () => {
  const fetch = vi.fn().mockResolvedValue(response(issue, 201));vi.stubGlobal("fetch", fetch);
  expect((await new ApiClient("https://api.example.test").createIssue({title: "Draft"})).id).toBe("i");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("applies the same acknowledgement guard to manual comment-source creation", async () => {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/capabilities") ? capabilities : issue)));
  vi.stubGlobal("fetch",fetch);
  await expect(new ApiClient("https://api.example.test").createCommentSubIssue("comment", {
    mode:"manual",capture_token:"capture",issue:{title:"Draft",execution:{mode:"pipeline",pipeline_id:"p",definition_id:"d1"},idempotency_key:"same"},
  })).rejects.toMatchObject({body:{code:"execution_snapshot_missing",issue_id:"i"}});
  expect(fetch.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
  expect(fetch.mock.calls[1]![0]).toContain("/api/comments/comment/sub-issues");
});

it("parses the catalog and readiness APIs without enabling malformed mutations", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({})));vi.stubGlobal("fetch", fetch);
  const client = new ApiClient("https://api.example.test");
  expect(await client.getPipelineCatalog("p")).toBeNull();
  await expect(client.createPipelineCatalog({name: "One", squad_id: "s", source: "original", idempotency_key: "one"})).rejects.toMatchObject({body: {code: "malformed_response"}});
  await expect(client.renamePipelineCatalog("p", {name: "Renamed", expected_revision: 2})).rejects.toMatchObject({body: {code: "malformed_response"}});
  expect((await client.listPipelineCatalog({squad_id: "s"})).items).toEqual([]);
  expect(await client.preflightPipelineExecution({squad_id: "s"})).toBeNull();
  expect(await client.getIssueExecution("i")).toBeNull();
  await expect(client.startIssueExecution("i")).rejects.toMatchObject({body: {code: "malformed_response"}});
  expect(PipelineCatalogSchema.parse({id: "p", workspace_id: "w", squad_id: "s", name: "One", revision: 1, created_at: "now", updated_at: "now"}).executable_definition_id).toBeNull();
});

it("preserves conflict payloads for a recheck instead of creating another issue", async () => {
  const fetch = vi.fn().mockResolvedValue(response({code: "runtime_not_ready", error: "Wait", execution: snapshot}, 409));vi.stubGlobal("fetch", fetch);
  await expect(new ApiClient("https://api.example.test").startIssueExecution("i")).rejects.toMatchObject({status: 409, body: {code: "runtime_not_ready", execution: {definition_id: "d1"}}});
  expect(fetch.mock.calls[0]![0]).toContain("/api/issues/i/execution/start");
  expect(fetch).toHaveBeenCalledTimes(1);
});
