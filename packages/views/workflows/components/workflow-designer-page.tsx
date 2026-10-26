"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { Lock, Workflow } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentMember } from "@multica/core/permissions";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  emptyDefinition,
  parseDefinitionText,
  resolvePositions,
  workflowDetailOptions,
} from "@multica/core/workflows";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { CollectionPageState } from "../../layout/collection-page";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { sizeOf } from "../designer/flow";
import type { DesignerInitial } from "../designer/workflow-designer";
import { WorkflowsDisabledState, WorkflowsErrorState, isWorkflowsDisabled } from "./workflow-state";

// The canvas library is large and only the designer needs it.
const WorkflowDesigner = lazy(() => import("../designer/workflow-designer"));

/** `/{slug}/workflows/new` or `/{slug}/workflows/{id}/edit`. */
function useDesignerRoute(): { mode: "new" } | { mode: "edit"; id: string } {
  const { pathname } = useNavigation();
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] === "edit" ? { mode: "edit", id: segments[segments.length - 2] ?? "" } : { mode: "new" };
}

/** Create a workflow, or change one. Owners and admins only. */
export function WorkflowDesignerPage() {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const route = useDesignerRoute();
  const { role, isLoading: roleLoading } = useCurrentMember(wsId);
  const canEdit = role === "owner" || role === "admin";

  const id = route.mode === "edit" ? route.id : "";
  const detail = useQuery({ ...workflowDetailOptions(wsId, id), enabled: id !== "" && canEdit });
  const workflow = detail.data?.workflow;

  const header = (
    <BreadcrumbHeader
      segments={[
        { href: p.workflows(), label: t(($) => $.page.title) },
        ...(workflow ? [{ href: p.workflowDetail(workflow.id), label: workflow.name }] : []),
      ]}
      leaf={
        <>
          <Workflow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-body font-medium text-foreground">
            {route.mode === "new" ? t(($) => $.editor.title_new) : t(($) => $.editor.title_edit)}
          </h1>
        </>
      }
    />
  );

  const shell = (body: React.ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {body}
    </div>
  );

  if (roleLoading) return shell(<Skeleton className="m-4 h-64" aria-hidden="true" />);
  if (!canEdit) {
    return shell(
      <CollectionPageState icon={Lock} title={t(($) => $.editor.not_allowed_title)} description={t(($) => $.editor.not_allowed_description)} />,
    );
  }
  if (route.mode === "new") return shell(<DesignerLoaded workflowId={null} />);

  if (detail.error) {
    const error = detail.error;
    if (isWorkflowsDisabled(error)) return shell(<WorkflowsDisabledState />);
    if (error instanceof ApiError && error.status === 404) {
      return shell(<CollectionPageState icon={Workflow} title={t(($) => $.detail.not_found)} />);
    }
    return shell(<WorkflowsErrorState message={t(($) => $.detail.load_failed)} />);
  }
  if (!detail.data || !workflow) return shell(<Skeleton className="m-4 h-64" aria-hidden="true" />);
  if (workflow.status !== "active") {
    return shell(<CollectionPageState icon={Lock} title={t(($) => $.editor.archived)} />);
  }
  return shell(<DesignerLoaded workflowId={workflow.id} loaded={detail.data} />);
}

/**
 * Hands the designer what was loaded, once. The designer owns the edits from then on, so a
 * refetch of the workflow (after a save, or a realtime event) must not reset it: the state is
 * built the first time and kept.
 */
function DesignerLoaded({
  workflowId,
  loaded,
}: {
  workflowId: string | null;
  loaded?: { workflow: { id: string }; version: { version: number; definition?: string; layout?: unknown } | null };
}) {
  const { t } = useT("workflows");
  const p = useWorkspacePaths();
  const { replace, searchParams } = useNavigation();
  // The list page sends people here with ?tab=yaml to import a workflow from text.
  const initialTab = workflowId === null && searchParams.get("tab") === "yaml" ? "yaml" : undefined;
  const [initial] = useState<DesignerInitial | "unreadable">(() => {
    if (loaded === undefined) return { definition: emptyDefinition(), positions: {}, version: 0 };
    if (loaded.version === null || loaded.version.definition === undefined) {
      return { definition: emptyDefinition(), positions: {}, version: 0 };
    }
    const parsed = parseDefinitionText(loaded.version.definition);
    if (!parsed.ok) return "unreadable";
    return {
      definition: parsed.definition,
      positions: resolvePositions(parsed.definition, loaded.version.layout, sizeOf),
      version: loaded.version.version,
    };
  });
  // Stable for the life of this component, whatever the parent re-renders with.
  const stable = useMemo(() => initial, [initial]);

  if (stable === "unreadable") {
    return <CollectionPageState icon={Workflow} title={t(($) => $.editor.unreadable)} />;
  }
  return (
    <>
      <p className="border-b bg-muted/30 px-4 py-2 text-caption text-muted-foreground md:hidden">{t(($) => $.editor.needs_wider)}</p>
      <Suspense fallback={<Skeleton className="m-4 h-64" role="status" aria-label={t(($) => $.designer.loading)} />}>
        <WorkflowDesigner
          workflowId={workflowId}
          initial={stable}
          onCreated={(id) => replace(p.workflowEdit(id))}
          {...(initialTab === undefined ? {} : { initialTab })}
        />
      </Suspense>
    </>
  );
}
