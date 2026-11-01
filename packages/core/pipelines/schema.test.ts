// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { PipelinePlanSchema } from "./schema";
import { SquadSchema } from "../api/schemas";

afterEach(() => vi.unstubAllGlobals());
it("preserves future kinds and user text without enabling guessed capabilities", async () => {
  const plan = { kind: "future_kind", compiler_version: "2", source_hash: "hash", stages: ["custom"], nodes: [] };
  expect(PipelinePlanSchema.parse(plan).kind).toBe("future_kind");
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({features: "malformed"}), {status: 200}));
  vi.stubGlobal("fetch", fetch);
  const client = new ApiClient("https://api.example.test");
  expect((await client.getPipelineCapabilities()).kinds).toEqual([]);
  fetch.mockImplementation(() => Promise.resolve(new Response("{}", {status: 200})));
  expect(await client.getPipelineRun("run")).toBeNull();
  expect(await client.getPipelineJob("run", "custom")).toBeNull();
  expect(await client.createPipelineDefinition({source: "kind: hermes_yaml\n", squad_id: "s", idempotency_key: "key"})).toBeNull();
  expect((await client.listPipelineDefinitions({squad_id: "s"})).items).toEqual([]);
  expect((await client.listPipelineRuns()).items).toEqual([]);
  expect((await client.listPipelineArtifacts("run")).items).toEqual([]);
  expect((await client.validatePipeline({source: "original"})).syntax_valid).toBe(false);
});
it("leaves legacy squads in markdown and keeps unknown modes readable", () => {
  const squad = {id: "s", workspace_id: "w", name: "team", leader_id: "a", creator_id: "m", created_at: "now", updated_at: "now"};
  expect(SquadSchema.parse(squad)).toMatchObject({instructions_mode: "markdown", pipeline_definition_id: null, revision: 1});
  expect(SquadSchema.parse({...squad, instructions_mode: "future"}).instructions_mode).toBe("future");
});
