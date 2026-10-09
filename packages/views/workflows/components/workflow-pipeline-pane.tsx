"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { workflowPipelineOptions } from "@multica/core/workflows";
import { useActorName } from "@multica/core/workspace/hooks";
import type { WorkflowPipelineApprover, WorkflowPipelineIssue, WorkflowPipelineStage } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { StatusIcon } from "../../issues/components/status-icon";
import { useStatusLabel } from "../../issues/utils/status-label";
import { AppLink } from "../../navigation";
import { StageIcon } from "../designer/stage-icon";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";

/** Where the issues that follow a workflow stand: one column per stage, read from the leader's labels. */
export function WorkflowPipelinePane({
  workflowId,
  workflowKey,
  squad = "",
}: {
  workflowId: string;
  workflowKey: string;
  /** Only the issues assigned to this squad id, or "none" for those assigned to no squad; "" for all. */
  squad?: string;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const pipeline = useQuery(workflowPipelineOptions(wsId, workflowId, { squad }));

  if (pipeline.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        {t(($) => $.pipeline.load_failed)}
      </p>
    );
  }
  if (!pipeline.data) return <Skeleton className="h-40 w-full" aria-hidden="true" />;

  const data = pipeline.data;
  if (data.total === 0) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-dashed p-6 text-center">
        <p className="text-body font-medium">{squad === "" ? t(($) => $.pipeline.empty) : t(($) => $.pipeline.empty_filtered)}</p>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.pipeline.empty_hint, { label: `wf:${workflowKey}` })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-body font-medium">{t(($) => $.pipeline.summary, { count: data.total })}</p>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.pipeline.refresh_hint)}
          {data.truncated ? ` ${t(($) => $.pipeline.truncated, { count: data.total })}` : ""}
        </p>
      </div>

      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {data.stages.map((stage) => (
          <StageColumn key={stage.id} stage={stage} />
        ))}
      </div>

      <Outside title={t(($) => $.pipeline.no_stage_title)} hint={t(($) => $.pipeline.no_stage_hint)} issues={data.no_stage} />
      <Outside
        title={t(($) => $.pipeline.conflicting_title)}
        hint={t(($) => $.pipeline.conflicting_hint)}
        issues={data.conflicting}
        attention
      />
      <Outside
        title={t(($) => $.pipeline.unknown_title)}
        hint={t(($) => $.pipeline.unknown_hint, { version: data.version })}
        issues={data.unknown_stage}
        attention
      />
    </div>
  );
}

function StageColumn({ stage }: { stage: WorkflowPipelineStage }) {
  const { t } = useT("workflows");
  const type =
    stage.type === "agent" || stage.type === "human_gate" || stage.type === "end" || stage.type === "condition"
      ? t(($) => $.designer.type[stage.type as "agent" | "human_gate" | "end" | "condition"])
      : stage.type;
  const waiting = waitingFor(t, stage.approvers);
  return (
    <section
      aria-label={stage.name}
      className="flex w-60 shrink-0 flex-col gap-2 rounded-lg border bg-muted/20 p-2"
    >
      <header className="flex items-baseline gap-2 px-1">
        <h3 className="min-w-0 flex-1 truncate text-body font-medium">{stage.name}</h3>
        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{stage.issues.length}</span>
      </header>
      <p className="flex items-center gap-1.5 px-1 text-caption text-muted-foreground">
        {stage.type === "agent" || stage.type === "human_gate" || stage.type === "condition" || stage.type === "end" ? (
          <StageIcon type={stage.type} />
        ) : null}
        {type}
      </p>
      {stage.type === "human_gate" ? (
        <p className={cn("px-1 text-caption", waiting.registered ? "text-foreground" : "text-warning")}>{waiting.text}</p>
      ) : null}
      {stage.issues.length === 0 ? (
        <p className="px-1 py-2 text-caption text-muted-foreground">{t(($) => $.pipeline.stage_empty)}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {stage.issues.map((issue) => (
            <li key={issue.id}>
              <IssueCard issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type TFn = ReturnType<typeof useT<"workflows">>["t"];

/** "Waiting for Ann, Bob" using only names; entries that are not registered members are counted, never shown as ids. */
function waitingFor(t: TFn, approvers: WorkflowPipelineApprover[]): { text: string; registered: boolean } {
  const names = approvers.flatMap((a) => (a.name ? [a.name] : []));
  const unregistered = approvers.length - names.length;
  if (names.length === 0) return { text: t(($) => $.pipeline.waiting_nobody), registered: false };
  const text = t(($) => $.pipeline.waiting_for, { names: names.join(", ") });
  return unregistered === 0
    ? { text, registered: true }
    : { text: `${text} ${t(($) => $.pipeline.waiting_unregistered, { count: unregistered })}`, registered: true };
}

function Outside({
  title,
  hint,
  issues,
  attention = false,
}: {
  title: string;
  hint: string;
  issues: WorkflowPipelineIssue[];
  attention?: boolean;
}) {
  if (issues.length === 0) return null;
  return (
    <section aria-label={title} className={cn("flex flex-col gap-2 rounded-lg border p-3", attention && "border-warning/40 bg-warning/5")}>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-body font-medium">
          {title} <span className="tabular-nums text-muted-foreground">({issues.length})</span>
        </h3>
        <p className="text-caption text-muted-foreground">{hint}</p>
      </header>
      <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {issues.map((issue) => (
          <li key={issue.id}>
            <IssueCard issue={issue} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssueCard({ issue }: { issue: WorkflowPipelineIssue }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const statusLabel = useStatusLabel(wsId);
  const { getActorName } = useActorName();
  const assignee = issue.assignee_type && issue.assignee_id ? getActorName(issue.assignee_type, issue.assignee_id) : "";
  return (
    <AppLink
      href={p.issueDetail(issue.id)}
      className="flex flex-col gap-1 rounded-md border bg-background p-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <StatusIcon status={issue.status} className="size-3.5" />
        <span className="font-mono">{issue.identifier}</span>
        <span className="min-w-0 flex-1 truncate">{statusLabel(issue.status)}</span>
        {issue.assignee_type && issue.assignee_id ? (
          <ActorAvatar actorType={issue.assignee_type as "member" | "agent"} actorId={issue.assignee_id} size="sm" />
        ) : null}
      </span>
      <span className="line-clamp-2 break-words text-body">{issue.title}</span>
      {issue.phases && issue.phases.length > 0 ? (
        <span className="break-all font-mono text-caption text-muted-foreground">
          {t(($) => $.pipeline.labels, { labels: issue.phases.join(", ") })}
        </span>
      ) : null}
      <span className="truncate text-caption text-muted-foreground">
        {assignee ? `${assignee} · ` : ""}
        {timeAgo(issue.updated_at)}
      </span>
    </AppLink>
  );
}
