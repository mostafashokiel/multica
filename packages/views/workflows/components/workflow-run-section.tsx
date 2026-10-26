"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useFeatureEnabled } from "@multica/core/config";
import { WORKFLOWS_V1_FLAG } from "@multica/core/feature-flags";
import { formatDuration, workflowRunOptions } from "@multica/core/workflows";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { RunTimelineDialog } from "./run-timeline";
import { useNow } from "./use-now";

/**
 * On an issue that follows a workflow: how long its run has taken and where the time went, with a way into
 * the full timeline. It shows nothing for any other issue, and nothing at all (not even a request) while the
 * workflows flag is off.
 */
export function WorkflowRunSection({ issueId, title }: { issueId: string; title: string }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const enabled = useFeatureEnabled(WORKFLOWS_V1_FLAG, false);
  const run = useQuery(workflowRunOptions(wsId, issueId, enabled));
  const [open, setOpen] = useState(false);
  const live = run.data?.timeline.open === true;
  useNow(live ? 1000 : null);

  const tl = run.data?.timeline;
  if (!enabled || run.isError || tl === undefined || tl.visits.length === 0) return null;
  const parts = [
    { key: "agents", label: t(($) => $.timing.agents), seconds: tl.agent_seconds, className: "bg-brand" },
    { key: "people", label: t(($) => $.timing.people), seconds: tl.people_seconds, className: "bg-warning" },
    { key: "handoffs", label: t(($) => $.timing.handoffs), seconds: tl.handoff_seconds, className: "bg-muted-foreground/40" },
  ];
  return (
    <section aria-label={t(($) => $.timing.title)} className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Clock aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.timing.title)}</h3>
      </div>
      <p className="text-body font-medium tabular-nums">
        {tl.open ? t(($) => $.timing.total_so_far, { time: formatDuration(tl.elapsed_seconds) }) : t(($) => $.timing.total, { time: formatDuration(tl.elapsed_seconds) })}
      </p>
      <div aria-hidden="true" className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) => (p.seconds > 0 ? <span key={p.key} className={cn("h-full", p.className)} style={{ flexGrow: p.seconds, flexBasis: 0 }} /> : null))}
      </div>
      <ul className="flex flex-col gap-0.5 text-caption">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", p.className)} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="ml-auto tabular-nums">{formatDuration(p.seconds)}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="w-fit text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setOpen(true)}>
        {t(($) => $.timing.open_timeline)}
      </button>
      {open ? <RunTimelineDialog issueId={issueId} title={title} open={open} onOpenChange={setOpen} /> : null}
    </section>
  );
}
