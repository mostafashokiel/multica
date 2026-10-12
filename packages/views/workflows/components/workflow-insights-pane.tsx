"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { formatDuration, workflowInsightsOptions } from "@multica/core/workflows";
import type { WorkflowInsights } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { StageIcon } from "../designer/stage-icon";

const WINDOWS = [7, 30, 90] as const;

const isStageType = (type: string): type is "agent" | "parallel" | "human_gate" | "condition" | "end" =>
  type === "agent" || type === "parallel" || type === "human_gate" || type === "condition" || type === "end";

/** Where the time goes across the runs of a workflow: per stage, per agent and per approver. */
export function WorkflowInsightsPane({ workflowId }: { workflowId: string }) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const [days, setDays] = useState<number>(30);
  const insights = useQuery(workflowInsightsOptions(wsId, workflowId, days));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted-foreground">{t(($) => $.insights.hint)}</p>
        <div role="group" aria-label={t(($) => $.insights.window)} className="flex gap-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-caption",
                days === d ? "border-foreground/30 bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {t(($) => $.insights.last_days, { days: d })}
            </button>
          ))}
        </div>
      </div>
      {insights.isError ? (
        <p role="alert" className="text-body text-destructive">
          {t(($) => $.insights.load_failed)}
        </p>
      ) : !insights.data ? (
        <Skeleton className="h-48 w-full" aria-hidden="true" />
      ) : insights.data.runs === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-body font-medium">{t(($) => $.insights.empty, { days })}</p>
          <p className="text-caption text-muted-foreground">{t(($) => $.insights.empty_hint)}</p>
        </div>
      ) : (
        <InsightsBody data={insights.data} />
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-muted/40 p-3">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="text-title font-medium tabular-nums">{value}</span>
      {hint !== undefined ? <span className="text-micro text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function InsightsBody({ data }: { data: WorkflowInsights }) {
  const { t } = useT("workflows");
  const totalStageTime = data.stages.reduce((sum, s) => sum + s.total_seconds, 0);
  const split = [
    { key: "agents", label: t(($) => $.timing.agents), seconds: data.median_agent_seconds, className: "bg-brand" },
    { key: "people", label: t(($) => $.timing.people), seconds: data.median_people_seconds, className: "bg-warning" },
    { key: "handoffs", label: t(($) => $.timing.handoffs), seconds: data.median_handoff_seconds, className: "bg-muted-foreground/40" },
  ];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t(($) => $.insights.runs)} value={String(data.runs)} hint={t(($) => $.insights.runs_hint, { finished: data.finished, open: data.open })} />
        <Metric
          label={t(($) => $.insights.median_total)}
          value={data.finished > 0 ? formatDuration(data.median_elapsed_seconds) : "—"}
          hint={data.finished > 0 ? t(($) => $.insights.slowest_hint, { time: formatDuration(data.p90_elapsed_seconds) }) : t(($) => $.insights.none_finished)}
        />
        <Metric label={t(($) => $.insights.reworks)} value={String(data.reworks)} hint={t(($) => $.insights.reworks_hint)} />
        <Metric
          label={t(($) => $.insights.bottleneck)}
          value={data.stages.find((s) => s.stage_id === data.bottleneck_stage_id)?.name ?? "—"}
          hint={t(($) => $.insights.bottleneck_hint)}
        />
      </div>

      {data.finished > 0 ? (
        <section aria-label={t(($) => $.insights.split_title)} className="flex flex-col gap-2">
          <h3 className="text-body font-medium">{t(($) => $.insights.split_title)}</h3>
          <div aria-hidden="true" className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
            {split.map((p) => (p.seconds > 0 ? <span key={p.key} className={cn("h-full", p.className)} style={{ flexGrow: p.seconds, flexBasis: 0 }} /> : null))}
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-caption">
            {split.map((p) => (
              <li key={p.key} className="flex items-center gap-2">
                <span aria-hidden="true" className={cn("size-2 rounded-full", p.className)} />
                <span className="text-muted-foreground">{p.label}</span>
                <span className="font-medium tabular-nums">{formatDuration(p.seconds)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={t(($) => $.insights.stages_title)} className="flex flex-col gap-2">
        <h3 className="text-body font-medium">{t(($) => $.insights.stages_title)}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-caption">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-normal">{t(($) => $.insights.col_stage)}</th>
                <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_visits)}</th>
                <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_typical)}</th>
                <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_slowest)}</th>
                <th className="px-3 py-1.5 font-normal">{t(($) => $.insights.col_share)}</th>
                <th className="py-1.5 pl-3 text-right font-normal">{t(($) => $.insights.col_sent_back)}</th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((s) => {
                const share = totalStageTime > 0 ? Math.round((s.total_seconds / totalStageTime) * 100) : 0;
                const bottleneck = s.stage_id === data.bottleneck_stage_id;
                return (
                  <tr key={s.stage_id} className={cn("border-b border-border/60", bottleneck && "bg-warning/5")}>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1.5 text-body">
                        {isStageType(s.type) ? <StageIcon type={s.type} /> : null}
                        <span className="truncate">{s.name}</span>
                        {bottleneck ? <span className="shrink-0 rounded-full bg-warning/10 px-1.5 text-micro text-warning">{t(($) => $.insights.bottleneck)}</span> : null}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{s.visits}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{s.visits > s.open_visits ? formatDuration(s.median_seconds) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{s.visits > s.open_visits ? formatDuration(s.p90_seconds) : "—"}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                          <span className={cn("block h-full", s.type === "human_gate" ? "bg-warning" : "bg-brand")} style={{ width: `${String(share)}%` }} />
                        </span>
                        <span className="tabular-nums text-muted-foreground">{share}%</span>
                      </span>
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{s.rejected > 0 ? s.rejected : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label={t(($) => $.insights.agents_title)} className="flex flex-col gap-2">
          <h3 className="text-body font-medium">{t(($) => $.insights.agents_title)}</h3>
          {data.agents.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.insights.none)}</p>
          ) : (
            <table className="w-full text-caption">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-normal">{t(($) => $.insights.col_agent)}</th>
                  <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_runs)}</th>
                  <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_typical)}</th>
                  <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_slowest)}</th>
                  <th className="py-1.5 pl-3 text-right font-normal">{t(($) => $.insights.col_total)}</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.agent} className="border-b border-border/60">
                    <td className="truncate py-1.5 pr-3 font-mono">{a.agent}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{a.runs}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(a.median_seconds)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatDuration(a.p90_seconds)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{formatDuration(a.total_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section aria-label={t(($) => $.insights.approvers_title)} className="flex flex-col gap-2">
          <h3 className="text-body font-medium">{t(($) => $.insights.approvers_title)}</h3>
          {data.approvers.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.insights.none)}</p>
          ) : (
            <table className="w-full text-caption">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-normal">{t(($) => $.insights.col_person)}</th>
                  <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_decisions)}</th>
                  <th className="px-3 py-1.5 text-right font-normal">{t(($) => $.insights.col_response)}</th>
                  <th className="py-1.5 pl-3 text-right font-normal">{t(($) => $.insights.col_slowest)}</th>
                </tr>
              </thead>
              <tbody>
                {data.approvers.map((a) => (
                  <tr key={a.ref} className="border-b border-border/60">
                    <td className="truncate py-1.5 pr-3">{a.name ?? t(($) => $.insights.unknown_person)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{a.decisions}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(a.median_seconds)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-muted-foreground">{formatDuration(a.slowest_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {data.truncated ? <p className="text-caption text-muted-foreground">{t(($) => $.insights.truncated)}</p> : null}
    </>
  );
}
