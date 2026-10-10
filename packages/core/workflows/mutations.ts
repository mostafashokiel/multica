import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ApplyWorkflowRequest,
  CreateWorkflowRequest,
  SaveWorkflowVersionRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowApplyResult,
  WorkflowWithVersion,
} from "../types";
import { workspaceKeys } from "../workspace/queries";
import { workflowKeys } from "./queries";

/**
 * Write a workflow version's briefing into a squad's instructions.
 *
 * The squad's instructions changed, so the squad caches are refreshed along
 * with the workflow's (the audit trail gained an entry). The server also
 * announces squad:updated, but the caller should not wait for the socket to see
 * its own write.
 */
export function useApplyWorkflow(wsId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowApplyResult, Error, ApplyWorkflowRequest>({
    mutationFn: (data) => api.applyWorkflow(workflowId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) });
    },
  });
}

/** Create a workflow. Refreshes the list; the caller moves to the new workflow. */
export function useCreateWorkflow(wsId: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowWithVersion, Error, CreateWorkflowRequest>({
    mutationFn: (data) => api.createWorkflow(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) }),
  });
}

/** Save the next version of a workflow. A 409 leaves the caches alone: nothing was written. */
export function useSaveWorkflowVersion(wsId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowWithVersion, Error, SaveWorkflowVersionRequest>({
    mutationFn: (data) => api.saveWorkflowVersion(workflowId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) }),
  });
}

/** Save an old version's content as the newest version. */
export function useRestoreWorkflowVersion(wsId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowWithVersion, Error, number>({
    mutationFn: (version) => api.restoreWorkflowVersion(workflowId, version),
    onSuccess: () => qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) }),
  });
}

/** Rename a workflow, or change its description. Every workflow view shows the name, so all of them refresh. */
export function useUpdateWorkflow(wsId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation<Workflow, Error, UpdateWorkflowRequest>({
    mutationFn: (data) => api.updateWorkflow(workflowId, data),
    // Also after a refusal: a stale revision is the usual one, and a retry must carry the current one.
    onSettled: () => qc.invalidateQueries({ queryKey: workflowKeys.all(wsId) }),
  });
}
