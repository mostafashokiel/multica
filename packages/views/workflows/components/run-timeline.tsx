"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { formatDuration, workflowRunOptions } from "@multica/core/workflows";
import type { WorkflowRun, WorkflowRunBranch, WorkflowRunVisit } from "@multica/core/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { StageIcon } from "../designer/stage-icon";
import { workflowErrorCode } from "./workflow-state";
import { useNow } from "./use-now";

type TFn = ReturnType<typeof useT<"workflows">>["t"];

const isStageType = (type: string): type is "agent" | "parallel" | "human_gate" | "condition" | "end" =>
  type === "agent" || type === "parallel" || type === "human_gate" || type === "condition" || type === "end";

/** A share of a total as a whole percentage; 0 when there is no total. */
function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * The bars are placed on one shared time axis, from the run's start to its end. While a run is still going, the
 * axis ends just after the last finished stage instead of at now: a stage that has been waiting for a day would
 * otherwise squeeze every earlier bar to a hairline. The open stage's bar runs off the end of the track, which
 * reads as "still going"; its duration is written beside it.
 */
export function axis(run: WorkflowRun): { start: number; span: number } {
  const tl = run.timeline;
  const start = Date.parse(tl.started_at ?? "");
  if (Number.isNaN(start)) return { start: 0, span: 1 };
  let end: number;
  if (tl.ended_at !== undefined) {
    end = Date.parse(tl.ended_at);
  } else {
    const reached = tl.visits.flatMap((v) => [v.open ? v.entered_at : v.left_at]).map((iso) => Date.parse(iso ?? "")).filter((ms) => !Number.isNaN(ms));
    const last = reached.length > 0 ? Math.max(...reached) : start;
    // A little room for the open stage's bar, in proportion to what has happened so far.
    end = last + Math.max(last - start, 60_000) * 0.12;
  }
  return Number.isNaN(end) || end <= start ? { start: 0, span: 1 } : { start, span: end - start };
}

function place(startIso: string, seconds: number, ax: { start: number; span: number }): { left: string; width: string } {
  const from = Date.parse(startIso);
  const left = Number.isNaN(from) ? 0 : Math.min(100, Math.max(0, ((from - ax.start) / ax.span) * 100));
  // Even a few seconds stay visible, and a bar never runs past the end of the track.
  const width = Math.min(100 - left, Math.max(0.8, ((seconds * 1000) / ax.span) * 100));
  return { left: `${left.toFixed(2)}%`, width: `${width.toFixed(2)}%` };
}

function outcomeText(t: TFn, outcome: string | undefined): string | null {
  switch (outcome) {
    case "approved":
      return t(($) => $.timing.outcome_approved);
    case "rejected":
      return t(($) => $.timing.outcome_rejected);
    case "waiting":
      return t(($) => $.timing.outcome_waiting);
    default:
      return null;
  }
}

/** The headline: the whole run, split into what agents did, what people took, and the handoffs between. */
function Summary({ run }: { run: WorkflowRun }) {
  const { t } = useT("workflows");
  const tl = run.timeline;
  const parts = [
    { key: "agents", label: t(($) => $.timing.agents), seconds: tl.agent_seconds, className: "bg-brand" },
    { key: "people", label: t(($) => $.timing.people), seconds: tl.people_seconds, className: "bg-warning" },
    { key: "handoffs", label: t(($) => $.timing.handoffs), seconds: tl.handoff_seconds, className: "bg-muted-foreground/40" },
  ];
  return (
    <section aria-label={t(($) => $.timing.summary)} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-title font-medium tabular-nums">
          {tl.open ? t(($) => $.timing.total_so_far, { time: formatDuration(tl.elapsed_seconds) }) : t(($) => $.timing.total, { time: formatDuration(tl.elapsed_seconds) })}
        </p>
        {tl.open ? <span className="text-caption text-warning">{t(($) => $.timing.still_running)}</span> : null}
        {tl.reworks > 0 ? <span className="text-caption text-muted-foreground">{t(($) => $.timing.reworks, { count: tl.reworks })}</span> : null}
      </div>
      <div aria-hidden="true" className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) =>
          p.seconds > 0 ? <span key={p.key} className={cn("h-full", p.className)} style={{ flexGrow: p.seconds, flexBasis: 0 }} /> : null,
        )}
      </div>
      <ul className="grid gap-x-6 gap-y-1 text-caption sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", p.className)} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="ml-auto font-medium tabular-nums">{formatDuration(p.seconds)}</span>
            <span className="w-9 text-right tabular-nums text-muted-foreground">{percent(p.seconds, tl.elapsed_seconds)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function barClass(type: string, open: boolean): string {
  const base = type === "human_gate" ? "bg-warning" : "bg-brand";
  return cn(base, open && "opacity-70 [background-image:repeating-linear-gradient(135deg,transparent_0_6px,rgba(255,255,255,0.35)_6px_12px)]");
}

function VisitRow({ visit, ax, nowMs }: { visit: WorkflowRunVisit; ax: { start: number; span: number }; nowMs: number }) {
  const { t } = useT("workflows");
  const gate = visit.type === "human_gate";
  // A gate's bar is the wait for its approver; an agent or parallel stage's bar is its stay.
  const seconds = gate ? visit.wait_seconds : visit.elapsed_seconds;
  const outcome = outcomeText(t, visit.outcome);
  const slowest = visit.branches.reduce((m, b) => Math.max(m, b.work_seconds > 0 ? b.work_seconds : b.elapsed_seconds), 0);
  void nowMs;
  return (
    <Fragment>
      <li className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_4.5rem] items-center gap-3 py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-start gap-1.5 text-body">
            {isStageType(visit.type) ? <StageIcon type={visit.type} /> : null}
            <span className="break-words leading-snug">{visit.name}</span>
            {visit.number > 1 ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-micro text-muted-foreground">×{visit.number}</span> : null}
          </span>
          {gate ? (
            <span className="break-words pl-5 text-micro text-muted-foreground">
              {[outcome, visit.decided_by?.name !== undefined ? t(($) => $.timing.answered_by, { name: visit.decided_by.name }) : null].filter(Boolean).join(" · ")}
            </span>
          ) : visit.type === "parallel" ? (
            <span className="pl-5 text-micro text-muted-foreground">{t(($) => $.timing.in_parallel, { count: visit.branches.length })}</span>
          ) : visit.agent ? (
            <span className="truncate pl-5 font-mono text-micro text-muted-foreground">{visit.agent}</span>
          ) : null}
        </div>
        <div aria-hidden="true" className="relative h-4 rounded-sm bg-muted/50">
          {visit.type !== "end" ? (
            <span className={cn("absolute inset-y-0 rounded-sm", barClass(visit.type, visit.open))} style={place(visit.entered_at, seconds, ax)} />
          ) : (
            <span className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: place(visit.entered_at, 0, ax).left }} />
          )}
        </div>
        <span className={cn("text-right text-caption tabular-nums", visit.open && "font-medium text-warning")}>
          {visit.type === "end" ? "" : formatDuration(seconds)}
          {visit.open ? "…" : ""}
        </span>
      </li>
      {visit.branches.map((b) => (
        <BranchRow key={b.id} branch={b} stageName={visit.name} slowest={slowest} ax={ax} />
      ))}
    </Fragment>
  );
}

function BranchRow({ branch, stageName, slowest, ax }: { branch: WorkflowRunBranch; stageName: string; slowest: number; ax: { start: number; span: number } }) {
  const { t } = useT("workflows");
  const seconds = branch.work_seconds > 0 ? branch.work_seconds : branch.elapsed_seconds;
  const label = branch.title.startsWith(`${stageName}: `) ? branch.title.slice(stageName.length + 2) : branch.title;
  return (
    <li className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_4.5rem] items-center gap-3 py-0.5 text-caption">
      <span className="flex min-w-0 flex-col pl-7">
        <span className="break-words leading-snug">{label}</span>
        {branch.agent ? <span className="truncate font-mono text-micro text-muted-foreground">{branch.agent}</span> : null}
      </span>
      <div aria-hidden="true" className="relative h-2.5 rounded-sm bg-muted/40">
        <span
          className={cn("absolute inset-y-0 rounded-sm", branch.cancelled ? "bg-warning/70" : branch.closed ? "bg-brand/70" : "bg-brand/40")}
          style={place(branch.started_at, branch.elapsed_seconds, ax)}
        />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">
        {formatDuration(seconds)}
        {!branch.closed ? "…" : ""}
        {branch.closed && seconds === slowest && slowest > 0 ? <span className="sr-only"> {t(($) => $.timing.slowest)}</span> : null}
      </span>
    </li>
  );
}

/** One run as a waterfall: the stages in the order they were visited, on a shared time axis. */
export function RunTimeline({ run }: { run: WorkflowRun }) {
  const { t } = useT("workflows");
  const nowMs = useNow(run.timeline.open ? 1000 : null);
  const ax = axis(run);
  const tl = run.timeline;
  if (tl.visits.length === 0) {
    return <p className="text-body text-muted-foreground">{t(($) => $.timing.no_data)}</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      <Summary run={run} />
      <section aria-label={t(($) => $.timing.stages)}>
        <ol className="flex flex-col divide-y divide-border/60">
          {tl.visits.map((v, i) => (
            <VisitRow key={`${v.stage_id}-${String(i)}`} visit={v} ax={ax} nowMs={nowMs} />
          ))}
        </ol>
      </section>
      {tl.parallel_saved_seconds > 0 ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-caption text-muted-foreground">
          {t(($) => $.timing.parallel_saved, { time: formatDuration(tl.parallel_saved_seconds) })}
        </p>
      ) : null}
      <p className="text-micro text-muted-foreground">{t(($) => $.timing.how_measured)}</p>
    </div>
  );
}

/** Loads one issue's run and draws it, or says why there is nothing to draw. */
export function RunTimelineLoader({ issueId }: { issueId: string }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const run = useQuery(workflowRunOptions(wsId, issueId));
  if (run.isError) {
    const notInWorkflow = workflowErrorCode(run.error) === "not_in_workflow";
    return (
      <p role={notInWorkflow ? "status" : "alert"} className={cn("text-body", notInWorkflow ? "text-muted-foreground" : "text-destructive")}>
        {notInWorkflow ? t(($) => $.timing.not_in_workflow) : t(($) => $.timing.load_failed)}
      </p>
    );
  }
  if (!run.data) return <Skeleton className="h-48 w-full" aria-hidden="true" />;
  return <RunTimeline run={run.data} />;
}

/** The timeline in a dialog: opened from a Pipeline card or from the issue. */
export function RunTimelineDialog({
  issueId,
  title,
  open,
  onOpenChange,
}: {
  issueId: string;
  /** The issue, as it should be named in the heading (identifier and title). */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("workflows");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
            {t(($) => $.timing.title)}
          </DialogTitle>
          <DialogDescription className="break-words">{title}</DialogDescription>
        </DialogHeader>
        {open ? <RunTimelineLoader issueId={issueId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
