import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PipelineDecisionInput } from "@multica/core/pipelines/schema";
import { api } from "@/data/api";
import { useWSSubscriptions } from "@/lib/use-ws-subscriptions";

export const pipelineKeys = {
  all: (wsId: string | null) => ["pipelines", wsId] as const,
  run: (wsId: string | null, id: string) => [...pipelineKeys.all(wsId), "run", id] as const,
  runs: (wsId: string | null, issueId: string, offset: number) => [...pipelineKeys.all(wsId), "issue", issueId, offset] as const,
};
export const pipelineRunOptions = (wsId: string | null, id: string) => queryOptions({ queryKey: pipelineKeys.run(wsId, id), queryFn: ({signal}) => api.getPipelineRun(id, {signal}), enabled: !!wsId && !!id });
export const pipelineRunsOptions = (wsId: string | null, issueId: string, offset = 0) => queryOptions({ queryKey: pipelineKeys.runs(wsId, issueId, offset), queryFn: ({signal}) => api.listPipelineRuns(issueId, offset, {signal}), enabled: !!wsId && !!issueId });
export const pipelineArtifactsOptions = (wsId: string | null, id: string, offset = 0) => queryOptions({ queryKey: [...pipelineKeys.run(wsId, id), "artifacts", offset], queryFn: ({signal}) => api.listPipelineArtifacts(id, offset, {signal}), enabled: !!wsId && !!id });
export function usePipelineDecision(wsId: string | null, id: string, jobId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: PipelineDecisionInput) => api.decidePipelineJob(id, jobId, input), onSettled: () => qc.invalidateQueries({queryKey: pipelineKeys.all(wsId)}) });
}
export function usePipelineRealtime(issueId?: string, runId?: string) {
  const qc = useQueryClient();
  useWSSubscriptions((ws, wsId) => {
    const refresh = () => { void qc.invalidateQueries({queryKey: pipelineKeys.all(wsId)}); };
    return [ws.on("pipeline:updated", payload => {
      if ((!issueId || payload.issue_id === issueId) && (!runId || payload.run_id === runId)) refresh();
    }), ws.onReconnect(refresh)];
  }, [qc, issueId, runId]);
}

export const documentKeys = {
  all: (wsId: string | null, projectId: string) => ["project-documents", wsId, projectId] as const,
  document: (wsId: string | null, projectId: string, id: string, version?: number) => ["project-documents", wsId, projectId, "document", id, version] as const,
};
export const projectDocumentsOptions = (wsId: string | null, projectId: string, q = "") => queryOptions({ queryKey: [...documentKeys.all(wsId, projectId), "groups", q], queryFn: ({signal}) => api.listProjectDocuments(projectId, q, {signal}), enabled: !!wsId && !!projectId });
export const projectDocumentOptions = (wsId: string | null, projectId: string, id: string, version?: number) => queryOptions({ queryKey: documentKeys.document(wsId, projectId, id, version), queryFn: ({signal}) => api.getProjectDocument(projectId, id, version, {signal}), enabled: !!wsId && !!projectId && !!id });
export function useDocumentsRealtime(projectId: string) {
  const qc = useQueryClient();
  useWSSubscriptions((ws, wsId) => {
    const refresh = () => { void qc.invalidateQueries({queryKey: documentKeys.all(wsId, projectId)}); };
    return [ws.on("project_document:updated", refresh), ws.on("issue:updated", refresh), ws.onReconnect(refresh)];
  }, [qc, projectId]);
}
