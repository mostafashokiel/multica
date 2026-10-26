"use client";

import { Columns3 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { usePipelineViewStore, workflowListOptions, WorkflowPipelineSquadNone } from "@multica/core/workflows";
import { squadListOptions } from "@multica/core/workspace/queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { PAGE_GUTTER, PAGE_RAIL } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { cn } from "@multica/ui/lib/utils";
import { WorkflowPipelinePane } from "./workflow-pipeline-pane";
import { WorkflowsDisabledState, WorkflowsErrorState, isWorkflowsDisabled } from "./workflow-state";

const ALL = "__all__";

/**
 * Where the workspace's workflow issues stand: one workflow at a time (its stages
 * are the columns), optionally narrowed to one squad. The choices live in the URL
 * (?workflow=<key>&squad=<id|none>), so a view can be bookmarked and shared.
 */
export function PipelinePage() {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const { pathname, searchParams, replace } = useNavigation();
  const workflows = useQuery(workflowListOptions(wsId));
  const squads = useQuery(squadListOptions(wsId));

  const list = workflows.data ?? [];
  const wanted = searchParams.get("workflow");
  const remembered = usePipelineViewStore((s) => s.workflow);
  const setRemembered = usePipelineViewStore((s) => s.setWorkflow);
  // The URL decides; without it, the workflow last looked at; without that, the first.
  const selected = list.find((w) => w.key === wanted) ?? list.find((w) => w.key === remembered) ?? list[0];
  const squadParam = searchParams.get("squad") ?? "";
  const squadList = (squads.data ?? []).filter((s) => s.archived_at === null);
  // A squad that no longer exists is not applied: the page would show nothing and say nothing.
  const squad =
    squadParam === WorkflowPipelineSquadNone || squadList.some((s) => s.id === squadParam) ? squadParam : "";

  const go = (next: { workflow?: string; squad?: string }) => {
    if (next.workflow) setRemembered(next.workflow);
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    replace(query ? `${pathname}?${query}` : pathname);
  };

  const header = <CollectionPageHeader icon={Columns3} title={t(($) => $.pipeline.page_title)} />;

  if (workflows.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {isWorkflowsDisabled(workflows.error) ? (
          <WorkflowsDisabledState />
        ) : (
          <WorkflowsErrorState message={t(($) => $.page.load_failed)} />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(PAGE_RAIL, PAGE_GUTTER, "flex flex-col gap-4 py-6")}>
          {workflows.isLoading ? (
            <Skeleton className="h-40 w-full" aria-hidden="true" />
          ) : selected === undefined ? (
            <CollectionPageState icon={Columns3} title={t(($) => $.pipeline.no_workflows)} description={undefined} />
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-48 flex-col gap-1">
                  <label htmlFor="pipeline-workflow" className="text-caption text-muted-foreground">
                    {t(($) => $.pipeline.workflow_label)}
                  </label>
                  <Select
                    items={list.map((w) => ({ value: w.key, label: w.name }))}
                    value={selected.key}
                    onValueChange={(next) => go({ workflow: next ?? undefined })}
                  >
                    <SelectTrigger id="pipeline-workflow" className="w-64 max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {list.map((w) => (
                        <SelectItem key={w.key} value={w.key}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-48 flex-col gap-1">
                  <label htmlFor="pipeline-squad" className="text-caption text-muted-foreground">
                    {t(($) => $.pipeline.squad_label)}
                  </label>
                  <Select
                    items={[
                      { value: ALL, label: t(($) => $.pipeline.squad_all) },
                      ...squadList.map((s) => ({ value: s.id, label: s.name })),
                      { value: WorkflowPipelineSquadNone, label: t(($) => $.pipeline.squad_none) },
                    ]}
                    value={squad === "" ? ALL : squad}
                    onValueChange={(next) => go({ squad: next === null || next === ALL ? undefined : next })}
                  >
                    <SelectTrigger id="pipeline-squad" className="w-64 max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t(($) => $.pipeline.squad_all)}</SelectItem>
                      {squadList.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={WorkflowPipelineSquadNone}>{t(($) => $.pipeline.squad_none)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <WorkflowPipelinePane workflowId={selected.id} workflowKey={selected.key} squad={squad} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
