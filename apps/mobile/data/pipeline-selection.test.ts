// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

vi.hoisted(() => {process.env.EXPO_PUBLIC_API_URL="https://api.example.test";});
vi.mock("@/data/workspace-store", () => ({getCurrentSlug: () => "workspace"}));
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
const response = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{"Content-Type":"application/json"}});
const selection = {mode:"pipeline" as const,pipeline_id:"p",definition_id:"d1"};
const execution = {requested_mode:"pipeline",mode:"pipeline",squad_id:"s",pipeline_id:"p",pipeline_name:"Named",definition_id:"d1",definition_revision:1,creator_id:"human",state:"waiting_runtime",readiness:{ready:false,runtimes:[]}};
const issue = {id:"created",workspace_id:"ws",number:1,identifier:"UI-1",title:"Draft",description:null,status:"todo",priority:"none",assignee_type:"squad",assignee_id:"s",creator_type:"member",creator_id:"human",parent_issue_id:null,project_id:null,position:0,stage:null,start_date:null,due_date:null,created_at:"now",updated_at:"now",execution};
const capabilities = {schema_version:1,compiler_version:"1",kinds:["gitlab_yaml","hermes_yaml"],features:{task_execution_selection:true}};
function mockFetch(fn: (url: string, init?: RequestInit) => Response) {
  vi.spyOn(console,"log").mockImplementation(() => {});
  const fetch=vi.fn(async (url: string,init?: RequestInit) => fn(url,init));vi.stubGlobal("fetch",fetch);return fetch;
}
it("mobile submits an exact pipeline/version and stable receipt in one atomic issue request", async () => {
  const fetch=mockFetch(url => response(url.endsWith("/capabilities") ? capabilities : issue));
  const input={title:"Draft",assignee_type:"squad" as const,assignee_id:"s",execution:selection,idempotency_key:"same-receipt"};
  expect((await api.createIssue(input)).execution?.definition_id).toBe("d1");
  const writes=fetch.mock.calls.filter(([,init]) => init?.method==="POST");
  expect(writes).toHaveLength(1);expect(JSON.parse(writes[0]![1]!.body as string)).toEqual(input);
});
it("mobile refuses an unsupported server before writing an issue", async () => {
  const fetch=mockFetch(() => response({...capabilities,features:{}}));
  await expect(api.createIssue({title:"Draft",execution:selection})).rejects.toMatchObject({body:{code:"unsupported_capability"}});
  expect(fetch.mock.calls.filter(([,init]) => init?.method==="POST")).toHaveLength(0);
});
it("mobile preserves an already-created issue ID when the selection acknowledgement is absent", async () => {
  const fetch=mockFetch(url => response(url.endsWith("/capabilities") ? capabilities : {...issue,execution:null}));
  await expect(api.createIssue({title:"Draft",execution:selection})).rejects.toMatchObject({body:{code:"execution_snapshot_missing",issue_id:"created"}});
  expect(fetch.mock.calls.filter(([,init]) => init?.method==="POST")).toHaveLength(1);
});
it("mobile rechecks and starts the existing issue without changing its frozen version", async () => {
  const fetch=mockFetch(url => response(url.endsWith("/start") ? {execution,run:{}} : {execution}));
  expect((await api.getIssueExecution("existing/id"))?.execution?.definition_id).toBe("d1");
  await expect(api.startIssueExecution("existing/id")).rejects.toMatchObject({status:502});
  expect(fetch.mock.calls.map(([url])=>url)).toEqual(["https://api.example.test/api/issues/existing%2Fid/execution","https://api.example.test/api/issues/existing%2Fid/execution/start"]);
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({});
});
it("mobile rejects malformed catalog/version write acknowledgements without reporting a saved draft", async () => {
  mockFetch(() => response({}));
  await expect(api.createPipelineCatalog({squad_id:"s",name:"Named",source:"source",idempotency_key:"key"})).rejects.toMatchObject({status:502});
  await expect(api.createPipelineDefinition({squad_id:"s",pipeline_id:"p",source:"source",idempotency_key:"key"})).rejects.toMatchObject({status:502});
  await expect(api.renamePipelineCatalog("p","Renamed",2)).rejects.toMatchObject({status:502});
});
it("mobile retains structured server errors and actual failure reasons", async () => {
  mockFetch(() => response({code:"revision_conflict",error:"The pipeline changed; compare its latest source."},409));
  await expect(api.renamePipelineCatalog("p","Renamed",1)).rejects.toMatchObject({status:409,message:"The pipeline changed; compare its latest source.",body:{code:"revision_conflict"}});
});
