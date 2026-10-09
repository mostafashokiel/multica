"use client";

import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Send, Workflow } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentMember } from "@multica/core/permissions";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  workflowAuditOptions,
  workflowDetailOptions,
  workflowSquadsOptions,
  workflowVersionOptions,
  workflowVersionsOptions,
} from "@multica/core/workflows";
import { parseDefinitionText, resolvePositions } from "@multica/core/workflows";
import { sizeOf } from "../designer/flow";
import type {
  Workflow as WorkflowRecord,
  WorkflowAuditEntry,
  WorkflowIssue,
  WorkflowSquad,
  WorkflowVersion,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { CodeBlock } from "@multica/ui/markdown";
import { cn } from "@multica/ui/lib/utils";
import { LazyWorkflowDiagram } from "../designer/lazy-workflow-diagram";
import { ApplyWorkflowDialog } from "./apply-workflow-dialog";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { CollectionPageState } from "../../layout/collection-page";
import { PAGE_GUTTER, PAGE_RAIL } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";
import {
  WorkflowsDisabledState,
  WorkflowsErrorState,
  isWorkflowsDisabled,
} from "./workflow-state";
import { WorkflowStatusBadge } from "./workflow-status-badge";

type DetailTab = "diagram" | "definition" | "history" | "activity";

export function WorkflowDetailPage() {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const id = pathname.split("/").pop() ?? "";

  const [tab, setTab] = useState<DetailTab>("diagram");
  // null = the latest version; a number pins an older one for reading.
  const [pinned, setPinned] = useState<number | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const { role } = useCurrentMember(wsId);

  const detail = useQuery(workflowDetailOptions(wsId, id));
  const versions = useQuery({
    ...workflowVersionsOptions(wsId, id),
    enabled: id !== "" && tab === "history",
  });
  const audit = useQuery({
    ...workflowAuditOptions(wsId, id),
    enabled: id !== "" && tab === "activity",
  });

  const workflow = detail.data?.workflow;
  const latest = detail.data?.version ?? null;
  const pinnedOlder = pinned !== null && pinned !== latest?.version;
  const pinnedVersion = useQuery({
    ...workflowVersionOptions(wsId, id, pinned ?? 0),
    enabled: id !== "" && pinnedOlder,
  });
  const shown = pinnedOlder ? pinnedVersion.data ?? null : latest;
  // Applying rewrites who approves what: owners and admins only, only an active
  // workflow, only a version that passes validation (the server enforces all
  // three; the button just does not offer what would be refused).
  const canApply =
    (role === "owner" || role === "admin") &&
    workflow?.status === "active" &&
    shown !== null &&
    shown.definition !== undefined &&
    (shown.issues ?? []).length === 0;

  const pinnedBanner =
    pinned !== null && pinnedOlder ? (
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <span>{t(($) => $.detail.viewing_version, { version: pinned })}</span>
        <Button size="xs" variant="outline" onClick={() => setPinned(null)}>
          {t(($) => $.detail.back_to_latest)}
        </Button>
      </div>
    ) : null;

  const header = (
    <BreadcrumbHeader
      segments={[{ href: p.workflows(), label: t(($) => $.page.title) }]}
      leaf={
        <>
          <Workflow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-body font-medium text-foreground">{workflow?.name ?? ""}</h1>
        </>
      }
      actions={
        <>
          {canApply ? (
            <Button size="sm" variant="outline" onClick={() => setApplyOpen(true)}>
              <Send aria-hidden="true" className="size-3.5" />
              {t(($) => $.apply.button)}
            </Button>
          ) : null}
        </>
      }
    />
  );

  if (detail.error) {
    const error = detail.error;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {isWorkflowsDisabled(error) ? (
          <WorkflowsDisabledState />
        ) : error instanceof ApiError && error.status === 404 ? (
          <CollectionPageState
            icon={Workflow}
            title={t(($) => $.detail.not_found)}
            description={undefined}
          />
        ) : (
          <WorkflowsErrorState message={t(($) => $.detail.load_failed)} />
        )}
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className={cn(PAGE_GUTTER, "flex flex-col gap-3 py-6")} aria-hidden="true">
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(PAGE_RAIL, PAGE_GUTTER, "flex flex-col gap-4 py-6 md:grid md:grid-cols-[260px_minmax(0,1fr)] md:gap-6")}>
          <WorkflowInspector workflow={workflow} latest={latest} />
          <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="min-w-0">
            <TabsList>
              <TabsTrigger value="diagram">{t(($) => $.detail.tabs.diagram)}</TabsTrigger>
              <TabsTrigger value="definition">{t(($) => $.detail.tabs.definition)}</TabsTrigger>
              <TabsTrigger value="history">{t(($) => $.detail.tabs.history)}</TabsTrigger>
              <TabsTrigger value="activity">{t(($) => $.detail.tabs.activity)}</TabsTrigger>
            </TabsList>
            <TabsContent value="diagram" className="flex flex-col gap-4">
              {pinnedBanner}
              <DiagramPane
                version={shown}
                loading={pinnedOlder && pinnedVersion.isLoading}
                failed={pinnedOlder && pinnedVersion.isError}
              />
            </TabsContent>
            <TabsContent value="definition" className="flex flex-col gap-4">
              {pinnedBanner}
              <DefinitionPane
                version={shown}
                loading={pinnedOlder && pinnedVersion.isLoading}
                failed={pinnedOlder && pinnedVersion.isError}
              />
            </TabsContent>
            <TabsContent value="history">
              <VersionList
                versions={versions.data}
                loading={versions.isLoading}
                failed={versions.isError}
                latestVersion={workflow.latest_version}
                onView={(version) => {
                  setPinned(version);
                  setTab("definition");
                }}
              />
            </TabsContent>
            <TabsContent value="activity">
              <ActivityList entries={audit.data} loading={audit.isLoading} failed={audit.isError} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
      {canApply && shown ? (
        <ApplyWorkflowDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          workflowId={workflow.id}
          workflowKey={workflow.key}
          version={shown.version}
        />
      ) : null}
    </div>
  );
}

function WorkflowInspector({
  workflow,
  latest,
}: {
  workflow: WorkflowRecord;
  latest: WorkflowVersion | null;
}) {
  const { t } = useT("workflows");
  const timeAgo = useTimeAgo();
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-body font-medium">{t(($) => $.detail.owner_section)}</h2>
        <p
          className={cn(
            "text-caption",
            workflow.description ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {workflow.description || t(($) => $.detail.description_empty)}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
        <Field label={t(($) => $.detail.key)}>
          <span className="font-mono">{workflow.key}</span>
        </Field>
        <Field label={t(($) => $.page.table.status)}>
          <WorkflowStatusBadge status={workflow.status} />
        </Field>
        <Field label={t(($) => $.page.table.version)}>
          <span className="tabular-nums">{workflow.latest_version}</span>
        </Field>
        <Field label={t(($) => $.detail.revision)}>
          <span className="tabular-nums">{workflow.revision}</span>
        </Field>
        {latest?.content_hash ? (
          <Field label={t(($) => $.detail.hash)}>
            <span className="font-mono" title={latest.content_hash}>
              {latest.content_hash.slice(0, 12)}
            </span>
          </Field>
        ) : null}
        <Field label={t(($) => $.detail.created)}>
          {workflow.created_at ? timeAgo(workflow.created_at) : ""}
        </Field>
        <Field label={t(($) => $.detail.updated)}>
          {workflow.updated_at ? timeAgo(workflow.updated_at) : ""}
        </Field>
      </dl>
      <UsedBy workflowId={workflow.id} latestVersion={workflow.latest_version} />
    </section>
  );
}

/** The squads whose instructions carry this workflow, and whether each holds the newest version. */
function UsedBy({ workflowId, latestVersion }: { workflowId: string; latestVersion: number }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const squads = useQuery(workflowSquadsOptions(wsId, workflowId));
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-body font-medium">{t(($) => $.detail.used_by_title)}</h2>
      {squads.isError ? (
        <p role="alert" className="text-caption text-destructive">
          {t(($) => $.detail.used_by_failed)}
        </p>
      ) : squads.isLoading ? (
        <Skeleton className="h-8 w-full" aria-hidden="true" />
      ) : !squads.data || squads.data.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.detail.used_by_empty)}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {squads.data.map((squad: WorkflowSquad) => (
            <li key={squad.squad_id} className="flex min-w-0 flex-col text-caption">
              <AppLink href={p.squadDetail(squad.squad_id)} className="truncate font-medium hover:underline">
                {squad.name}
              </AppLink>
              <span className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
                <span className="tabular-nums">{t(($) => $.detail.used_by_version, { version: squad.version })}</span>
                <span aria-hidden="true">·</span>
                <span className={squad.up_to_date ? "text-success" : "text-warning"}>
                  {squad.up_to_date
                    ? t(($) => $.detail.used_by_current)
                    : t(($) => $.detail.used_by_behind, { latest: latestVersion })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

/** The picture of a version, read from its stored text and layout; problems are marked on their stages. */
function DiagramPane({
  version,
  loading,
  failed,
}: {
  version: WorkflowVersion | null;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useT("workflows");
  const drawn = useMemo(() => {
    if (!version?.definition) return null;
    const parsed = parseDefinitionText(version.definition);
    if (!parsed.ok) return { ok: false as const };
    const problems: Record<string, number> = {};
    for (const issue of version.issues ?? []) {
      if (issue.stage_id) problems[issue.stage_id] = (problems[issue.stage_id] ?? 0) + 1;
    }
    return {
      ok: true as const,
      definition: parsed.definition,
      positions: resolvePositions(parsed.definition, version.layout, sizeOf),
      problems,
    };
  }, [version]);

  if (failed) return <WorkflowsErrorState message={t(($) => $.detail.version_load_failed)} />;
  if (loading) return <Skeleton className="h-72 w-full" aria-hidden="true" />;
  if (!version?.definition) return <p className="text-body text-muted-foreground">{t(($) => $.detail.no_version)}</p>;
  if (drawn === null || !drawn.ok) return <p className="text-body text-muted-foreground">{t(($) => $.designer.cannot_draw)}</p>;
  if (drawn.definition.stages.length === 0) return <p className="text-body text-muted-foreground">{t(($) => $.designer.no_stages)}</p>;
  return (
    <>
      {(version.issues ?? []).length > 0 ? <ProblemsPanel issues={version.issues ?? []} /> : null}
      <LazyWorkflowDiagram definition={drawn.definition} positions={drawn.positions} problemsByStage={drawn.problems} />
    </>
  );
}

function DefinitionPane({
  version,
  loading,
  failed,
}: {
  version: WorkflowVersion | null;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useT("workflows");
  if (failed) return <WorkflowsErrorState message={t(($) => $.detail.version_load_failed)} />;
  if (loading) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (!version?.definition) {
    return <p className="text-body text-muted-foreground">{t(($) => $.detail.no_version)}</p>;
  }
  return (
    <>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono tabular-nums">
          {t(($) => $.detail.version_label, { version: version.version })}
        </Badge>
      </div>
      <ProblemsPanel issues={version.issues ?? []} />
      <CodeBlock code={version.definition} language="yaml" mode="full" />
    </>
  );
}

function ProblemsPanel({ issues }: { issues: WorkflowIssue[] }) {
  const { t } = useT("workflows");
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
        {t(($) => $.problems.none)}
      </p>
    );
  }
  return (
    <section role="alert" className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <h3 className="flex items-center gap-1.5 text-caption font-medium text-destructive">
        <CircleAlert aria-hidden="true" className="size-3.5" />
        {t(($) => $.problems.title, { count: issues.length })}
      </h3>
      <ul className="flex flex-col gap-1 text-caption">
        {issues.map((issue, i) => (
          <li key={`${issue.code ?? "parse"}-${issue.stage_id ?? ""}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            {issue.code ? <span className="font-mono text-muted-foreground">{issue.code}</span> : null}
            <span className="min-w-0 break-words">{issue.message}</span>
            {issue.stage_id ? (
              <span className="font-mono text-muted-foreground">
                {t(($) => $.problems.stage, { id: issue.stage_id })}
              </span>
            ) : null}
            {issue.line ? (
              <span className="text-muted-foreground">{t(($) => $.problems.line, { line: issue.line })}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function VersionList({
  versions,
  loading,
  failed,
  latestVersion,
  onView,
}: {
  versions: WorkflowVersion[] | undefined;
  loading: boolean;
  failed: boolean;
  latestVersion: number;
  onView: (version: number) => void;
}) {
  const { t } = useT("workflows");
  const timeAgo = useTimeAgo();
  if (failed) return <WorkflowsErrorState message={t(($) => $.detail.load_failed)} />;
  if (loading) return <Skeleton className="h-24 w-full" aria-hidden="true" />;
  if (!versions || versions.length === 0) {
    return <p className="text-body text-muted-foreground">{t(($) => $.history.empty)}</p>;
  }
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {versions.map((v) => (
        <li key={v.id} className="flex items-center gap-3 px-3 py-2.5">
          <Badge variant="outline" className="shrink-0 font-mono tabular-nums">
            {t(($) => $.history.version, { version: v.version })}
          </Badge>
          {v.version === latestVersion ? (
            <Badge variant="secondary" className="shrink-0">
              {t(($) => $.detail.latest_badge)}
            </Badge>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-body", !v.note && "text-muted-foreground")}>
              {v.note || t(($) => $.history.note_empty)}
            </p>
            <p className="truncate text-caption text-muted-foreground">
              {v.created_at ? timeAgo(v.created_at) : ""}
              {v.created_by_type === "agent"
                ? ` · ${t(($) => $.history.by_agent)}`
                : v.created_by_type === "member"
                  ? ` · ${t(($) => $.history.by_member)}`
                  : ""}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onView(v.version)}>
            {t(($) => $.history.view)}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({
  entries,
  loading,
  failed,
}: {
  entries: WorkflowAuditEntry[] | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useT("workflows");
  const timeAgo = useTimeAgo();
  if (failed) return <WorkflowsErrorState message={t(($) => $.detail.load_failed)} />;
  if (loading) return <Skeleton className="h-24 w-full" aria-hidden="true" />;
  if (!entries || entries.length === 0) {
    return <p className="text-body text-muted-foreground">{t(($) => $.activity.empty)}</p>;
  }
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {entries.map((entry, i) => (
        <li key={`${entry.created_at}-${entry.action}-${i}`} className="flex items-center gap-3 px-3 py-2.5 text-body">
          <span className="min-w-0 flex-1 truncate">{actionLabel(entry.action, t)}</span>
          {entry.version !== undefined ? (
            <Badge variant="outline" className="shrink-0 font-mono tabular-nums">
              {t(($) => $.activity.version, { version: entry.version })}
            </Badge>
          ) : null}
          <span className="shrink-0 text-caption text-muted-foreground">
            {entry.created_at ? timeAgo(entry.created_at) : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Audit actions are server-driven; one this client does not know reads as a
// generic "Changed" rather than leaking the raw code into the UI.
function actionLabel(action: string, t: ReturnType<typeof useT<"workflows">>["t"]): string {
  switch (action) {
    case "create":
      return t(($) => $.activity.actions.create);
    case "save":
      return t(($) => $.activity.actions.save);
    case "restore":
      return t(($) => $.activity.actions.restore);
    case "archive":
      return t(($) => $.activity.actions.archive);
    case "unarchive":
      return t(($) => $.activity.actions.unarchive);
    case "rename":
      return t(($) => $.activity.actions.rename);
    default:
      return t(($) => $.activity.unknown_action);
  }
}
