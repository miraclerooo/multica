// @vitest-environment node
import {afterEach, expect, it, vi} from "vitest";
import {parse} from "yaml";
import {ApiClient} from "../api/client";
import {applyCanvasEdit, readCanvasDocument, canvasCapabilityRestriction, canvasMetadataCapabilityRestriction} from "./document";
import {pipelineRunActions} from "./utils";
import {PipelineRunSchema} from "./schema";
import {PipelinePlanSchema} from "./schema";

const agent="15cfc7a3-afd0-4fb4-9802-df6714172a91", owner="a3d005d9-0871-4375-9f01-85a8f4a02e63";
afterEach(()=>vi.unstubAllGlobals());
const source=`# Keep the source and every instruction.
kind: gitlab_yaml
stages: [work]
node_1:
  title: Original name
  stage: work
  agent_id: ${agent}
  instructions: |+
    Entire instruction.

    Final paragraph.

  artifacts:
    paths: [old/full.md] # old path stays exact
    files:
      - {name: plan.md, path: reports/plan.md, description: "First.\\n\\nSecond.\\n"}
      - {name: plan.md, path: other/plan.md, description: "Different evidence"}
gate:
  stage: work
  when: manual
  owner_user_id: ${owner}
  needs: [node_1]
`;

it("edits display names without changing IDs, dependencies, bindings or instruction paragraphs",()=>{
  const before=readCanvasDocument(source);
  expect(before.restriction).toBeNull();
  const result=applyCanvasEdit(source,{type:"update_node",id:"node_1",fields:{title:"New name"}}).source;
  const after=readCanvasDocument(result);
  expect(after.nodes[0]).toEqual({...before.nodes[0],title:"New name"});
  expect(after.edges).toEqual(before.edges);
  expect(result).toContain("# Keep the source and every instruction.");
  expect(parse(result).node_1.instructions).toBe(parse(source).node_1.instructions);
  expect(after.nodes[0]!.deliverables!.map(d=>d.path)).toEqual(["old/full.md","reports/plan.md","other/plan.md"]);
});
it("round trips multiple filenames and complete multiline descriptions without merging same-basename paths",()=>{
  const description="  Intentional leading spaces.\n\nSecond paragraph.\n\n";
  const files=readCanvasDocument(source).nodes[0]!.deliverables!.map(d=>({...d,description}));
  const text=applyCanvasEdit(source,{type:"update_node",id:"node_1",fields:{deliverables:files}}).source;
  expect(readCanvasDocument(text).nodes[0]!.deliverables).toEqual(files);
  const removed=applyCanvasEdit(text,{type:"update_node",id:"node_1",fields:{deliverables:files.slice(1)}}).source;
  expect(readCanvasDocument(removed).nodes[0]!.paths).toEqual(["reports/plan.md","other/plan.md"]);
  expect(()=>applyCanvasEdit(text,{type:"update_node",id:"node_1",fields:{paths:["oops.md"]}})).toThrow();
});
it("generates an unused stable ID and stage without rewriting existing identifiers",()=>{
  const result=applyCanvasEdit(source,{type:"add_node",nodeType:"agent",fields:{title:"Next work",instructions:"Full instructions",agentId:agent}});
  expect(result.selected).toBe("node_2");
  const next=readCanvasDocument(result.source);
  expect(next.nodes.find(n=>n.id==="node_2")).toMatchObject({title:"Next work",stage:"work",agentId:agent});
  expect(next.edges).toEqual(readCanvasDocument(source).edges);
});
it("preserves Hermes role/owner references until explicitly changed and edits new identity fields safely",()=>{
  const text=`kind: hermes_yaml
roles: {old: {}}
gates: {review: {type: manual, owner: missing-human-role}}
states:
  work:
    by: old
    entry: Entire instruction.
    gate: review
    output: {nested: {keep: [a, b]}} # keep nested output
`;
  const renamed=applyCanvasEdit(text,{type:"update_node",id:"work",fields:{title:"Display work"}}).source;
  expect(readCanvasDocument(renamed).nodes[0]!.role).toBe("old");
  expect(readCanvasDocument(renamed).nodes[1]!.owner).toBe("missing-human-role");
  expect(parse(renamed).states.work.output).toEqual({nested:{keep:["a","b"]}});
  const bound=applyCanvasEdit(renamed,{type:"update_node",id:"work",fields:{agentId:agent}}).source;
  expect(parse(bound).states.work.by).toBeUndefined();
  expect(parse(bound).states.work.agent_id).toBe(agent);
  const leader=applyCanvasEdit(bound,{type:"update_node",id:"work",fields:{role:""}}).source;
  expect(parse(leader).states.work.agent_id).toBeUndefined();
  const assigned=applyCanvasEdit(bound,{type:"update_node",id:"work.gate.review",fields:{title:"Confirm",ownerUserId:owner}}).source;
  expect(parse(assigned).gates.review).toEqual({type:"manual",title:"Confirm",owner_user_id:owner});
});
it("keeps unknown nested source read-only and does not turn invalid drafts into fresh diagrams",()=>{
  for(const text of [source+"unknown: {nested: [keep]}\n", "kind: gitlab_yaml\nstages: [\n"]) {
    expect(readCanvasDocument(text).restriction).toBeTruthy();
    expect(()=>applyCanvasEdit(text,{type:"update_node",id:"node_1",fields:{title:"No write"}})).toThrow();
  }
});
it("accepts compiler 2 and old plans without guessing new feature flags",()=>{
  const caps={schema_version:1,compiler_version:"2",kinds:["gitlab_yaml"],features:{custom_nodes:true,manual_gates:true,gitlab_dag:true},limits:{}};
  expect(canvasCapabilityRestriction(caps,"gitlab_yaml")).toBeNull();
  expect(canvasMetadataCapabilityRestriction(caps)).toBe("capability");
  expect(canvasMetadataCapabilityRestriction({...caps,features:{...caps.features,human_owner_identity:true,stable_agent_binding:true,node_display_names:true,deliverable_descriptions:true}})).toBeNull();
  const old=PipelinePlanSchema.parse({kind:"gitlab_yaml",compiler_version:"1",source_hash:"h",stages:[],nodes:[]});
  expect(old.compiler_version).toBe("1");
});
it("keeps compiler 2 actions guarded by real status and manual gate semantics",()=>{
  const run=PipelineRunSchema.parse({id:"r",workspace_id:"w",issue_id:"i",squad_id:"s",definition_id:"d",creator_id:owner,revision:1,status:"waiting_approval",reason:"",plan:{kind:"gitlab_yaml",compiler_version:"2",source_hash:"h",stages:[],nodes:[]},policy:"",issue_title:"i",issue_description:"",issue_revision:1,project_id:"",workflow_id:"",workflow_step:"",projected_status:"in_review",jobs:[],created_at:"",updated_at:""});
  expect(pipelineRunActions(run)).toMatchObject({restriction:null,cancel:true,decide:false});
  expect(pipelineRunActions({...run,status:"future"})).toMatchObject({cancel:false,decide:false,retry:false});
});
it("reads authenticated candidate identities and treats malformed responses as unavailable",async()=>{
  const payload={squad_id:"s",current_user:{user_id:owner,member_id:"m",name:"Admin"},default_owner_user_id:owner,leader_id:agent,humans:[{user_id:owner,member_id:"m",name:"Admin"}],agents:[{agent_id:agent,name:"No role executor",role:"",can_invoke:true,reason:"",is_leader:true}]};
  const fetch=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify(payload))));vi.stubGlobal("fetch",fetch);
  const api=new ApiClient("https://api.example.test");
  expect(await api.getPipelineCandidates("s","Admin person")).toEqual(payload);
  expect(String(fetch.mock.calls[0]![0])).toContain("search=Admin+person");
  fetch.mockImplementation(()=>Promise.resolve(new Response('{"current_user":"Admin","agents":[]}')));
  expect(await api.getPipelineCandidates("s")).toBeNull();
});
