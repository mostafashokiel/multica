"use client";

import { FileUp, Plus, Workflow } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentMember } from "@multica/core/permissions";
import { useWorkspacePaths } from "@multica/core/paths";
import { workflowListOptions } from "@multica/core/workflows";
import type { Workflow as WorkflowRow } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  ListGrid,
  ListGridCell,
  ListGridHeader,
  ListGridHeaderCell,
  ListGridRow,
  LIST_GRID_BOTTOM_CLEARANCE,
} from "@multica/ui/components/ui/list-grid";
import { Button } from "@multica/ui/components/ui/button";
import { CollectionPageHeader, CollectionPageHeaderAction, CollectionPageState } from "../../layout/collection-page";
import { useNavigation, useRowLink } from "../../navigation";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";
import {
  WorkflowsDisabledState,
  WorkflowsErrorState,
  isWorkflowsDisabled,
} from "./workflow-state";
import { WorkflowStatusBadge } from "./workflow-status-badge";

// Edge tracks, name, then key / version / status / updated from @2xl up.
const GRID_COLS =
  "grid-cols-[0.75rem_minmax(120px,1fr)_0.75rem] " +
  "@2xl:grid-cols-[0.75rem_minmax(200px,1fr)_160px_96px_112px_112px_0.75rem]";

export function WorkflowsPage() {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const { data: workflows = [], isLoading, error } = useQuery(workflowListOptions(wsId));
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  // Only owners and admins can create workflows; nobody else is offered the button.
  const { role } = useCurrentMember(wsId);
  const canCreate = (role === "owner" || role === "admin") && !error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader
        icon={Workflow}
        title={t(($) => $.page.title)}
        count={workflows.length}
        actions={
          canCreate ? (
            <>
              <CollectionPageHeaderAction icon={FileUp} label={t(($) => $.page.import_button)} onClick={() => push(`${p.workflowNew()}?tab=yaml`)} />
              <CollectionPageHeaderAction icon={Plus} label={t(($) => $.page.new_button)} onClick={() => push(p.workflowNew())} />
            </>
          ) : null
        }
      />
      {error ? (
        isWorkflowsDisabled(error) ? (
          <WorkflowsDisabledState />
        ) : (
          <WorkflowsErrorState message={t(($) => $.page.load_failed)} />
        )
      ) : isLoading ? (
        <LoadingSkeleton />
      ) : workflows.length === 0 ? (
        <CollectionPageState
          icon={Workflow}
          title={t(($) => $.page.empty)}
          description={canCreate ? t(($) => $.page.empty_description_create) : t(($) => $.page.empty_description)}
          actions={
            canCreate ? (
              <Button size="sm" onClick={() => push(p.workflowNew())}>
                <Plus aria-hidden="true" className="size-3.5" />
                {t(($) => $.page.new_button)}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <WorkflowTable workflows={workflows} />
      )}
    </div>
  );
}

function WorkflowTable({ workflows }: { workflows: WorkflowRow[] }) {
  const { t } = useT("workflows");
  const p = useWorkspacePaths();
  const rowLink = useRowLink();
  const timeAgo = useTimeAgo();

  return (
    <div className="@container min-h-0 flex-1 overflow-auto">
      <ListGrid className={GRID_COLS} style={{ paddingBottom: LIST_GRID_BOTTOM_CLEARANCE }}>
        <ListGridHeader>
          <ListGridHeaderCell>{t(($) => $.page.table.name)}</ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            {t(($) => $.page.table.key)}
          </ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            {t(($) => $.page.table.version)}
          </ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            {t(($) => $.page.table.status)}
          </ListGridHeaderCell>
          <ListGridHeaderCell className="hidden @2xl:flex">
            {t(($) => $.page.table.updated)}
          </ListGridHeaderCell>
        </ListGridHeader>
        {workflows.map((wf) => (
          <ListGridRow
            key={wf.id}
            className="cursor-pointer"
            {...rowLink(p.workflowDetail(wf.id), wf.name)}
          >
            <ListGridCell>
              <div className="min-w-0 flex-1">
                <span className="block min-w-0 truncate text-body font-medium">{wf.name}</span>
                {wf.description ? (
                  <span className="block min-w-0 truncate text-caption text-muted-foreground">
                    {wf.description}
                  </span>
                ) : null}
              </div>
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
                {wf.key}
              </span>
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <Badge variant="outline" className="font-mono tabular-nums">
                {t(($) => $.history.version, { version: wf.latest_version })}
              </Badge>
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <WorkflowStatusBadge status={wf.status} />
            </ListGridCell>
            <ListGridCell className="hidden @2xl:flex">
              <span className="min-w-0 truncate text-caption text-muted-foreground">
                {wf.updated_at ? timeAgo(wf.updated_at) : ""}
              </span>
            </ListGridCell>
          </ListGridRow>
        ))}
      </ListGrid>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3.5 w-48 max-w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
