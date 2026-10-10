import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Workflow queries (flag `workflows_v1`). Read-only for now. Every key starts
 * with the workspace id so a workspace switch never shows another workspace's
 * workflows, and `all(wsId)` invalidates the lot on a `workflow:*` event.
 */
export const workflowKeys = {
  all: (wsId: string) => ["workflows", wsId] as const,
  list: (wsId: string) => [...workflowKeys.all(wsId), "list"] as const,
  /** The list with archived workflows in it. */
  listWithArchived: (wsId: string) => [...workflowKeys.all(wsId), "list", "with-archived"] as const,
  detail: (wsId: string, id: string) => [...workflowKeys.all(wsId), "detail", id] as const,
  versions: (wsId: string, id: string) => [...workflowKeys.all(wsId), "versions", id] as const,
  version: (wsId: string, id: string, version: number) =>
    [...workflowKeys.all(wsId), "version", id, version] as const,
  audit: (wsId: string, id: string) => [...workflowKeys.all(wsId), "audit", id] as const,
  pipeline: (wsId: string, id: string, squad = "") => [...workflowKeys.all(wsId), "pipeline", id, squad] as const,
  squads: (wsId: string, id: string) => [...workflowKeys.all(wsId), "squads", id] as const,
};

/** The pipeline's squad filter that keeps only the issues assigned to no squad. */
export const WorkflowPipelineSquadNone = "none";

export function workflowListOptions(wsId: string, enabled = true, includeArchived = false) {
  return queryOptions({
    queryKey: includeArchived ? workflowKeys.listWithArchived(wsId) : workflowKeys.list(wsId),
    queryFn: () => api.listWorkflows(includeArchived ? { includeArchived: true } : undefined),
    select: (data) => data.workflows,
    enabled,
    // A 403 means the feature is off for this workspace; retrying will not
    // change that.
    retry: false,
  });
}

export function workflowDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: workflowKeys.detail(wsId, id),
    queryFn: () => api.getWorkflow(id),
    enabled: id !== "",
    retry: false,
  });
}

export function workflowVersionsOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: workflowKeys.versions(wsId, id),
    queryFn: () => api.listWorkflowVersions(id),
    select: (data) => data.versions,
    enabled: id !== "",
    retry: false,
  });
}

/** One stored version, including its YAML text and validation issues. */
export function workflowVersionOptions(wsId: string, id: string, version: number) {
  return queryOptions({
    queryKey: workflowKeys.version(wsId, id, version),
    queryFn: () => api.getWorkflowVersion(id, version),
    enabled: id !== "" && version > 0,
    // Versions are immutable: a fetched one never goes stale.
    staleTime: Infinity,
    retry: false,
  });
}

export function workflowAuditOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: workflowKeys.audit(wsId, id),
    queryFn: () => api.listWorkflowAudit(id),
    select: (data) => data.audit,
    enabled: id !== "",
    retry: false,
  });
}

/**
 * Where the workflow's issues stand, optionally only those of one squad (an id, or
 * "none" for no squad). Issues move without anything on the page changing, so it
 * refreshes itself while it is open (every 15 s, and on focus).
 */
export function workflowPipelineOptions(wsId: string, id: string, opts: { squad?: string } = {}, enabled = true) {
  return queryOptions({
    queryKey: workflowKeys.pipeline(wsId, id, opts.squad ?? ""),
    queryFn: () => api.getWorkflowPipeline(id, opts),
    enabled: enabled && id !== "",
    // The app treats every query as fresh forever and refreshes it on realtime events;
    // nothing announces a label moving an issue between stages, so this one is always
    // stale: opening or switching a view refetches at once (the cached copy shows while
    // it does), and it keeps refreshing while it stays open.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
    retry: false,
  });
}

/** The squads that follow this workflow. Refreshed with the rest of the workflow's caches. */
export function workflowSquadsOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: workflowKeys.squads(wsId, id),
    queryFn: () => api.listWorkflowSquads(id),
    select: (data) => data.squads,
    // A squad's instructions can change on the squad's own page, which says nothing here.
    staleTime: 0,
    enabled: id !== "",
    retry: false,
  });
}

/**
 * The briefing a version would give a squad. A POST on the wire but a pure read
 * (nothing is written), so it is a query; the squad name is part of the key
 * because it is part of the text.
 */
export function workflowRenderOptions(
  wsId: string,
  id: string,
  opts: { version?: number; squadId?: string },
  enabled = true,
) {
  return queryOptions({
    queryKey: [...workflowKeys.all(wsId), "render", id, opts.version ?? 0, opts.squadId ?? ""] as const,
    queryFn: () => api.renderWorkflow(id, { version: opts.version, squad_id: opts.squadId }),
    enabled: enabled && id !== "",
    retry: false,
  });
}

/**
 * The server's verdict on a definition's text. Keyed by the text, so each distinct
 * text is judged once; `keepPreviousData` lets an editor keep showing the last verdict
 * while the next one is on its way instead of flashing empty.
 */
export function workflowValidationOptions(wsId: string, definition: string, enabled = true) {
  return queryOptions({
    queryKey: [...workflowKeys.all(wsId), "validate", definition] as const,
    queryFn: () => api.validateWorkflow(definition),
    enabled: enabled && definition !== "",
    staleTime: Infinity,
    // A verdict is only worth keeping while it is the text on screen.
    gcTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
