"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { STAGE_TYPES, branchLabel, branchProgress, currentBranches, workflowPipelineOptions, type StageType } from "@multica/core/workflows";
import { useActorName } from "@multica/core/workspace/hooks";
import type { WorkflowPipelineApprover, WorkflowPipelineChild, WorkflowPipelineIssue, WorkflowPipelineStage } from "@multica/core/types";
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

      <div className="-mx-1 flex items-stretch gap-3 overflow-x-auto px-1 pb-2">
        {data.stages.map((stage, index) => (
          <StageColumn key={stage.id} stage={stage} step={index + 1} />
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

// The server sends the stage type as text; one this build does not know is shown as written.
const isStageType = (value: string): value is StageType => (STAGE_TYPES as readonly string[]).includes(value);

// The colour of the strip across the top of a lane says what kind of stage it is, as on the designer's canvas.
const LANE_BAR: Record<StageType, string> = {
  agent: "bg-brand",
  parallel: "bg-brand",
  human_gate: "bg-warning",
  condition: "bg-info",
  end: "bg-muted-foreground",
};

/**
 * One stage as a lane. The lane is a column with its own header (step number, name, kind, how many issues, and
 * who a gate waits for) over a tinted floor; the issues are white cards that stand on that floor, so a card is
 * never mistaken for a lane. A lane with nothing in it shrinks, so the lanes that hold work stand out.
 */
function StageColumn({ stage, step }: { stage: WorkflowPipelineStage; step: number }) {
  const { t } = useT("workflows");
  const known = isStageType(stage.type);
  const type = known ? t(($) => $.designer.type[stage.type as StageType]) : stage.type;
  const waiting = waitingFor(t, stage.approvers);
  const count = stage.issues.length;
  return (
    <section
      aria-label={stage.name}
      data-empty={count === 0 || undefined}
      className={cn("flex shrink-0 flex-col overflow-hidden rounded-xl border bg-muted/40", count === 0 ? "w-48" : "w-72")}
    >
      <div aria-hidden="true" className={cn("h-1 shrink-0", known ? LANE_BAR[stage.type as StageType] : "bg-muted-foreground")} />
      <header className="flex flex-col gap-1.5 border-b bg-background px-3 py-2.5">
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span
            aria-hidden="true"
            className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-micro font-medium tabular-nums"
          >
            {step}
          </span>
          {isStageType(stage.type) ? <StageIcon type={stage.type} /> : null}
          <span className="min-w-0 flex-1 truncate">{type}</span>
          <span
            className={cn(
              "min-w-6 shrink-0 rounded-full px-1.5 text-center tabular-nums",
              count > 0 ? "bg-brand/10 font-medium text-brand" : "text-muted-foreground",
            )}
          >
            {count}
          </span>
        </div>
        <h3 className="break-words text-body font-medium leading-snug">{stage.name}</h3>
        {stage.type === "human_gate" ? (
          <p
            className={cn(
              "w-fit max-w-full rounded-md px-1.5 py-0.5 text-caption",
              waiting.registered ? "bg-warning/10 text-foreground" : "bg-warning/10 text-warning",
            )}
          >
            {waiting.text}
          </p>
        ) : null}
      </header>
      {count === 0 ? (
        <div className="min-h-16 flex-1 p-2">
          <div aria-hidden="true" className="h-full min-h-12 rounded-lg border border-dashed border-border/70" />
          <p className="sr-only">{t(($) => $.pipeline.stage_empty)}</p>
        </div>
      ) : (
        <ul className="flex flex-1 flex-col gap-2 p-2">
          {stage.issues.map((issue) => (
            <li key={issue.id}>
              <IssueCard issue={issue} {...(stage.type === "parallel" ? { branchesOf: stage.name } : {})} />
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
            <IssueCard issue={issue} showPhases />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * An issue as a card: a raised box with the issue's own link on top and, in a parallel stage, how far its
 * branches are below. The branch rows are links of their own, so they sit beside the issue's link rather than
 * inside it.
 */
function IssueCard({ issue, showPhases = false, branchesOf }: { issue: WorkflowPipelineIssue; showPhases?: boolean; branchesOf?: string }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const statusLabel = useStatusLabel(wsId);
  const { getActorName } = useActorName();
  const assignee = issue.assignee_type && issue.assignee_id ? getActorName(issue.assignee_type, issue.assignee_id) : "";
  const branches = branchesOf === undefined ? [] : currentBranches(issue.children ?? [], branchesOf);
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card shadow-sm transition-colors hover:border-ring/50">
      <AppLink href={p.issueDetail(issue.id)} className="flex flex-col gap-2 rounded-lg p-2.5 text-left transition-colors hover:bg-accent/40">
        <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <StatusIcon status={issue.status} className="size-3.5 shrink-0" />
          <span className="font-mono">{issue.identifier}</span>
          <span className="min-w-0 flex-1 truncate">{statusLabel(issue.status)}</span>
        </span>
        <span className="line-clamp-3 break-words text-body font-medium leading-snug">{issue.title}</span>
        {showPhases && issue.phases && issue.phases.length > 0 ? (
          <span className="break-all font-mono text-caption text-muted-foreground">
            {t(($) => $.pipeline.labels, { labels: issue.phases.join(", ") })}
          </span>
        ) : null}
        <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
          {issue.assignee_type && issue.assignee_id ? (
            <ActorAvatar actorType={issue.assignee_type as "member" | "agent"} actorId={issue.assignee_id} size="sm" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {assignee ? `${assignee} · ` : ""}
            {timeAgo(issue.updated_at)}
          </span>
        </span>
      </AppLink>
      {branches.length > 0 && branchesOf !== undefined ? <BranchProgress branches={branches} stageName={branchesOf} /> : null}
    </div>
  );
}

/** How far the branches of a parallel stage are: a segment each, a count, and one row per branch. */
function BranchProgress({ branches, stageName }: { branches: WorkflowPipelineChild[]; stageName: string }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const statusLabel = useStatusLabel(wsId);
  const { getActorName } = useActorName();
  const progress = branchProgress(branches);
  return (
    <div className="flex flex-col gap-2 border-t bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-caption">
        <span className="font-medium">{t(($) => $.pipeline.branches_progress, { done: progress.closed, total: progress.total })}</span>
        {progress.cancelled > 0 ? <span className="text-warning">{t(($) => $.pipeline.branches_cancelled, { count: progress.cancelled })}</span> : null}
      </div>
      <div aria-hidden="true" className="flex gap-0.5">
        {branches.map((b) => (
          <span
            key={b.id}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              b.cancelled ? "bg-warning" : b.closed ? "bg-success" : b.status === "in_progress" ? "bg-brand/70" : "bg-muted-foreground/25",
            )}
          />
        ))}
      </div>
      <ul className="flex flex-col" aria-label={t(($) => $.pipeline.branches)}>
        {branches.map((b) => {
          const who = b.assignee_type && b.assignee_id ? getActorName(b.assignee_type, b.assignee_id) : "";
          return (
            <li key={b.id}>
              <AppLink
                href={p.issueDetail(b.id)}
                title={`${branchLabel(b, stageName)} · ${b.identifier} · ${statusLabel(b.status)}`}
                className="flex items-center gap-1.5 rounded-md px-1 py-1 text-caption hover:bg-accent/60"
              >
                <StatusIcon status={b.status} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{branchLabel(b, stageName)}</span>
                {who ? <span className="max-w-[40%] shrink-0 truncate font-mono text-micro text-muted-foreground">{who}</span> : null}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
