import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { workspaceKeys } from "../workspace/queries";
import type { PipelineDecisionInput, PipelineDefinitionInput, PipelineListInput, PipelineRevisionInput, PipelineRunInput } from "./schema";

export const pipelineKeys = {
  all: (wsId: string) => ["pipelines", wsId] as const,
  capabilities: (wsId: string) => [...pipelineKeys.all(wsId), "capabilities"] as const,
  definitions: (wsId: string, input: PipelineListInput) => [...pipelineKeys.all(wsId), "definitions", input] as const,
  definition: (wsId: string, id: string) => [...pipelineKeys.all(wsId), "definition", id] as const,
  runs: (wsId: string, input: PipelineListInput) => [...pipelineKeys.all(wsId), "runs", input] as const,
  run: (wsId: string, id: string) => [...pipelineKeys.all(wsId), "run", id] as const,
  job: (wsId: string, id: string, job: string) => [...pipelineKeys.run(wsId, id), "job", job] as const,
  artifacts: (wsId: string, id: string, input: PipelineListInput) => [...pipelineKeys.run(wsId, id), "artifacts", input] as const,
};
export const pipelineCapabilitiesOptions = (wsId: string) => queryOptions({ queryKey: pipelineKeys.capabilities(wsId), queryFn: () => api.getPipelineCapabilities() });
export const pipelineDefinitionsOptions = (wsId: string, input: PipelineListInput) => queryOptions({ queryKey: pipelineKeys.definitions(wsId, input), queryFn: () => api.listPipelineDefinitions(input) });
export const pipelineDefinitionOptions = (wsId: string, id: string) => queryOptions({ queryKey: pipelineKeys.definition(wsId, id), queryFn: () => api.getPipelineDefinition(id), enabled: !!id });
export const pipelineRunsOptions = (wsId: string, input: PipelineListInput) => queryOptions({ queryKey: pipelineKeys.runs(wsId, input), queryFn: () => api.listPipelineRuns(input) });
export const pipelineRunOptions = (wsId: string, id: string) => queryOptions({ queryKey: pipelineKeys.run(wsId, id), queryFn: () => api.getPipelineRun(id), enabled: !!id });
export const pipelineJobOptions = (wsId: string, id: string, job: string) => queryOptions({ queryKey: pipelineKeys.job(wsId, id, job), queryFn: () => api.getPipelineJob(id, job), enabled: !!id && !!job });
export const pipelineArtifactsOptions = (wsId: string, id: string, input: PipelineListInput = {}) => queryOptions({ queryKey: pipelineKeys.artifacts(wsId, id, input), queryFn: () => api.listPipelineArtifacts(id, input), enabled: !!id });

// Pipeline events and reconnects invalidate this workspace's aggregate. The
// view subscribes through its existing realtime provider; no state is mirrored.
export function usePipelineInvalidation(wsId: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: pipelineKeys.all(wsId) }),
      qc.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) }),
    ]);
  };
}
export function useCreatePipelineDefinition(wsId: string) { const invalidate = usePipelineInvalidation(wsId); return useMutation({ mutationFn: (input: PipelineDefinitionInput) => api.createPipelineDefinition(input), onSuccess: invalidate }); }
export function useCreatePipelineRun(wsId: string) { const invalidate = usePipelineInvalidation(wsId); return useMutation({ mutationFn: (input: PipelineRunInput) => api.createPipelineRun(input), onSuccess: invalidate }); }
export function usePipelineDecision(wsId: string, id: string, job: string) { const invalidate = usePipelineInvalidation(wsId); return useMutation({ mutationFn: (input: PipelineDecisionInput) => api.decidePipelineJob(id, job, input), onSettled: invalidate }); }
export function useRetryPipelineJob(wsId: string, id: string, job: string) { const invalidate = usePipelineInvalidation(wsId); return useMutation({ mutationFn: (input: PipelineRevisionInput) => api.retryPipelineJob(id, job, input), onSettled: invalidate }); }
export function useCancelPipelineRun(wsId: string, id: string) { const invalidate = usePipelineInvalidation(wsId); return useMutation({ mutationFn: (input: {reason: string; idempotency_key: string}) => api.cancelPipelineRun(id, input), onSettled: invalidate }); }
