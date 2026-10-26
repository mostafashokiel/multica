"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { workflowTimelineOptions } from "@multica/core/issue-workflows";
import type { WorkflowTimeline, WorkflowVisit } from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { cn } from "@multica/ui/lib/utils";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";
import { useDurationFormat } from "./timing-format";

/** The colour of what a stretch of time was spent on. */
const AGENT_BAR = "bg-info";
const PERSON_BAR = "bg-warning";
const OTHER_BAR = "bg-muted-foreground/40";

const MIN_BAR_PERCENT = 0.8;

/**
 * How long one issue spent in each step of its project's workflow (MUL-7420):
 * the total split into agents working, people waiting and everything else,
 * then one row per visit to a step, drawn on a shared time axis. It is read
 * from the issue's own history, so it needs nothing the issue does not
 * already have.
 */
export function IssueTimingDialog({
  issueId,
  identifier,
  open,
  onOpenChange,
}: {
  issueId: string;
  identifier?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data, isLoading, isError } = useQuery({ ...workflowTimelineOptions(wsId, issueId), enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.timing.title)}</DialogTitle>
          {identifier && <DialogDescription>{identifier}</DialogDescription>}
        </DialogHeader>
        {isLoading ? (
          <p className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner className="size-3.5" />
            {t(($) => $.workflows.timing.loading)}
          </p>
        ) : isError || !data ? (
          <p className="text-body text-destructive">{t(($) => $.workflows.timing.error)}</p>
        ) : data.visits.length === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.workflows.timing.empty)}</p>
        ) : (
          <TimelineBody timeline={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TimelineBody({ timeline }: { timeline: WorkflowTimeline }) {
  const { t } = useT("issues");
  const format = useDurationFormat();
  const rows = timeline.visits.filter((v) => v.kind !== "end" && (v.elapsed_seconds > 0 || v.open));
  const total = Math.max(timeline.elapsed_seconds, 1);
  const parts = [
    { key: "agents", label: t(($) => $.workflows.timing.agents), seconds: timeline.agent_seconds, bar: AGENT_BAR },
    { key: "people", label: t(($) => $.workflows.timing.people), seconds: timeline.people_seconds, bar: PERSON_BAR },
    { key: "other", label: t(($) => $.workflows.timing.other), seconds: timeline.other_seconds, bar: OTHER_BAR },
  ];

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-title-lg font-semibold tabular-nums">
            {timeline.open ? t(($) => $.workflows.timing.total_so_far) : t(($) => $.workflows.timing.total)}{" "}
            {format(timeline.elapsed_seconds)}
          </span>
          {timeline.open && (
            <span className="text-caption text-warning">{t(($) => $.workflows.timing.still_running)}</span>
          )}
          {timeline.reworks > 0 && (
            <span className="text-caption text-muted-foreground">
              {t(($) => $.workflows.timing.reworks, { count: timeline.reworks })}
            </span>
          )}
        </div>
        <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((p) => `${p.label} ${format(p.seconds)}`).join(", ")}>
          {parts.map((p) => (
            <div key={p.key} className={p.bar} style={{ width: `${(p.seconds / total) * 100}%` }} />
          ))}
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-caption">
          {parts.map((p) => (
            <div key={p.key} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", p.bar)} />
              <dt className="truncate text-muted-foreground">{p.label}</dt>
              <dd className="ml-auto tabular-nums">{format(p.seconds)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <ol className="divide-y divide-surface-border rounded-lg border border-surface-border">
        {rows.map((visit) => (
          <VisitRow key={`${visit.status_key}-${visit.number}-${visit.entered_at}`} visit={visit} timeline={timeline} />
        ))}
      </ol>

      <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.timing.note)}</p>
    </div>
  );
}

function VisitRow({ visit, timeline }: { visit: WorkflowVisit; timeline: WorkflowTimeline }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { getActorName } = useActorName();
  const format = useDurationFormat();

  const span = Math.max(timeline.elapsed_seconds, 1);
  const startedAt = timeline.started_at ? new Date(timeline.started_at).getTime() : 0;
  const offset = Math.max(0, (new Date(visit.entered_at).getTime() - startedAt) / 1000);
  const left = Math.min((offset / span) * 100, 100 - MIN_BAR_PERCENT);
  const width = Math.max(Math.min((visit.elapsed_seconds / span) * 100, 100 - left), MIN_BAR_PERCENT);
  // A person's step shows the wait in colour and any time after their answer as plain time.
  const coloured = visit.kind === "person" ? visit.wait_seconds : visit.kind === "agent" ? visit.agent_seconds : 0;
  const colouredPercent = visit.elapsed_seconds > 0 ? Math.min((coloured / visit.elapsed_seconds) * 100, 100) : 0;
  const bar = visit.kind === "person" ? PERSON_BAR : AGENT_BAR;

  const who: string[] = [];
  if (visit.kind === "agent") who.push(...visit.agent_ids.map((id) => getActorName("agent", id)));
  if (visit.kind === "person" && visit.answered_by) {
    who.push(t(($) => $.workflows.timing.answered_by, { name: getActorName("member", visit.answered_by) }));
  }
  const outcome = visit.outcome ? t(($) => $.workflows.timing.outcome[visit.outcome as "passed" | "sent_back" | "blocked" | "waiting"]) : "";
  const kindKey = visit.kind === "end" ? null : visit.kind;
  const kind = kindKey ? t(($) => $.workflows.timing.kind[kindKey]) : "";

  return (
    <li className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_4.5rem] items-center gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <StatusIcon
            status={visit.status_key}
            category={catalog.categoryOf(visit.status_key)}
            color={catalog.colorOf(visit.status_key)}
            icon={catalog.iconOf(visit.status_key)}
            className="h-3.5 w-3.5 shrink-0"
          />
          <span className="truncate text-body font-medium">{labelOf(visit.status_key)}</span>
          {visit.number > 1 && (
            <span className="shrink-0 text-caption text-muted-foreground">
              {t(($) => $.workflows.timing.visit_again, { number: visit.number })}
            </span>
          )}
        </div>
        <p className="truncate text-caption text-muted-foreground">
          {[kind, ...who, outcome].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="relative h-2.5 rounded-full bg-muted" aria-hidden>
        <div
          className={cn("absolute inset-y-0 overflow-hidden rounded-full bg-muted-foreground/40", visit.open && "opacity-70")}
          style={{ left: `${left}%`, width: `${width}%` }}
        >
          <div className={cn("h-full", bar)} style={{ width: `${colouredPercent}%` }} />
        </div>
      </div>
      <span className={cn("text-right text-caption tabular-nums", visit.open && "text-warning")}>
        {format(visit.elapsed_seconds)}
        {visit.open ? "…" : ""}
      </span>
    </li>
  );
}
