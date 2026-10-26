"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { workflowInsightsOptions } from "@multica/core/issue-workflows";
import type { WorkflowInsights, WorkflowInsightsDays } from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import { Button } from "@multica/ui/components/ui/button";
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

const PERIODS: WorkflowInsightsDays[] = [7, 30, 90];

/**
 * Where the time goes across the issues of one workflow (MUL-7420): how many
 * issues, the typical total, how often a step sent work back, the step that
 * holds the largest share of the time, and per-step, per-agent and per-person
 * tables. Read from the issues' own history, for issues created in the period.
 */
export function WorkflowInsightsDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const [days, setDays] = useState<WorkflowInsightsDays>(30);
  const { data, isLoading, isError } = useQuery({ ...workflowInsightsOptions(wsId, workflowId, days), enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.insights.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.workflows.insights.description)}</DialogDescription>
        </DialogHeader>
        <div role="group" aria-label={t(($) => $.workflows.insights.period)} className="flex gap-1">
          {PERIODS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === days ? "secondary" : "ghost"}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {t(($) => $.workflows.insights[`days_${d}` as "days_7" | "days_30" | "days_90"])}
            </Button>
          ))}
        </div>
        {isLoading ? (
          <p className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner className="size-3.5" />
            {t(($) => $.workflows.timing.loading)}
          </p>
        ) : isError || !data ? (
          <p className="text-body text-destructive">{t(($) => $.workflows.insights.error)}</p>
        ) : data.runs === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.workflows.insights.empty)}</p>
        ) : (
          <InsightsBody insights={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <div className="rounded-lg border border-surface-border p-3">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-title-lg font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-caption leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

const TH = "px-2 py-1.5 text-left text-caption font-normal text-muted-foreground";
const TD = "px-2 py-1.5 text-body tabular-nums";

function InsightsBody({ insights }: { insights: WorkflowInsights }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { getActorName } = useActorName();
  const format = useDurationFormat();
  const dash = "—";
  const typical = (seconds: number) => (seconds > 0 ? format(seconds) : dash);

  // Parked time (the backlog) is not work, so it takes no share.
  const timed = insights.steps.filter((s) => s.kind !== "parked");
  const totalTime = timed.reduce((sum, s) => sum + s.total_seconds, 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t(($) => $.workflows.insights.runs)}
          value={insights.runs}
          detail={t(($) => $.workflows.insights.runs_detail, { finished: insights.finished, open: insights.open })}
        />
        <Stat
          label={t(($) => $.workflows.insights.typical_total)}
          value={typical(insights.median_elapsed_seconds)}
          detail={insights.finished === 0 ? t(($) => $.workflows.insights.typical_none) : ""}
        />
        <Stat
          label={t(($) => $.workflows.insights.sent_back)}
          value={insights.sent_back}
          detail={t(($) => $.workflows.insights.sent_back_detail)}
        />
        <Stat
          label={t(($) => $.workflows.insights.bottleneck)}
          value={insights.bottleneck_status_key ? labelOf(insights.bottleneck_status_key) : dash}
          detail={
            insights.bottleneck_status_key
              ? t(($) => $.workflows.insights.bottleneck_detail)
              : t(($) => $.workflows.insights.bottleneck_none)
          }
        />
      </div>
      {insights.truncated && (
        <p className="text-caption text-muted-foreground">
          {t(($) => $.workflows.insights.truncated, { count: insights.runs })}
        </p>
      )}

      <section aria-labelledby="insights-steps">
        <h3 id="insights-steps" className="mb-1 text-body font-medium">
          {t(($) => $.workflows.insights.steps)}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead>
              <tr className="border-b border-surface-border">
                <th className={TH}>{t(($) => $.workflows.insights.step)}</th>
                <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.visits)}</th>
                <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.typical)}</th>
                <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.slowest)}</th>
                <th className={TH}>{t(($) => $.workflows.insights.share)}</th>
                <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.step_sent_back)}</th>
              </tr>
            </thead>
            <tbody>
              {insights.steps.map((step) => {
                const share = step.kind !== "parked" && totalTime > 0 ? step.total_seconds / totalTime : 0;
                const isBottleneck = step.status_key === insights.bottleneck_status_key;
                return (
                  <tr key={step.status_key} className={cn("border-b border-surface-border last:border-0", isBottleneck && "bg-warning/10")}>
                    <td className={cn(TD, "tabular-nums")}>
                      <span className="flex items-center gap-1.5">
                        <StatusIcon
                          status={step.status_key}
                          category={catalog.categoryOf(step.status_key)}
                          color={catalog.colorOf(step.status_key)}
                          icon={catalog.iconOf(step.status_key)}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="truncate">{labelOf(step.status_key)}</span>
                        {isBottleneck && (
                          <span className="shrink-0 rounded bg-warning/20 px-1 text-caption text-warning">
                            {t(($) => $.workflows.insights.bottleneck_badge)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={cn(TD, "text-right")}>{step.visits}</td>
                    <td className={cn(TD, "text-right")}>{typical(step.median_seconds)}</td>
                    <td className={cn(TD, "text-right text-muted-foreground")}>{typical(step.p90_seconds)}</td>
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className="block h-full bg-warning" style={{ width: `${share * 100}%` }} />
                        </span>
                        <span className="text-caption text-muted-foreground">{Math.round(share * 100)}%</span>
                      </span>
                    </td>
                    <td className={cn(TD, "text-right")}>{step.sent_back || dash}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {(insights.agents.length > 0 || insights.people.length > 0) && (
        <div className="grid gap-5 md:grid-cols-2">
          {insights.agents.length > 0 && (
            <section aria-labelledby="insights-agents">
              <h3 id="insights-agents" className="mb-1 text-body font-medium">
                {t(($) => $.workflows.insights.agents)}
              </h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className={TH}>{t(($) => $.workflows.insights.agent)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.visits)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.typical)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.total)}</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.agents.map((a) => (
                    <tr key={a.agent_id} className="border-b border-surface-border last:border-0">
                      <td className={cn(TD, "max-w-40 truncate")}>{getActorName("agent", a.agent_id)}</td>
                      <td className={cn(TD, "text-right")}>{a.visits}</td>
                      <td className={cn(TD, "text-right")}>{typical(a.median_seconds)}</td>
                      <td className={cn(TD, "text-right text-muted-foreground")}>{format(a.total_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {insights.people.length > 0 && (
            <section aria-labelledby="insights-people">
              <h3 id="insights-people" className="mb-1 text-body font-medium">
                {t(($) => $.workflows.insights.people)}
              </h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-surface-border">
                    <th className={TH}>{t(($) => $.workflows.insights.person)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.answers)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.typical_wait)}</th>
                    <th className={cn(TH, "text-right")}>{t(($) => $.workflows.insights.slowest)}</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.people.map((p) => (
                    <tr key={p.user_id} className="border-b border-surface-border last:border-0">
                      <td className={cn(TD, "max-w-40 truncate")}>{getActorName("member", p.user_id)}</td>
                      <td className={cn(TD, "text-right")}>{p.answers}</td>
                      <td className={cn(TD, "text-right")}>{typical(p.median_seconds)}</td>
                      <td className={cn(TD, "text-right text-muted-foreground")}>{typical(p.p90_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
