"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import type { StageType } from "@multica/core/workflows";
import { useT } from "../../i18n";
import { Plus, X } from "lucide-react";
import { MAX_BRANCHES } from "@multica/core/workflows";
import { PARALLEL, parallelGeometry, type StageNode } from "./flow";
import { StageIcon } from "./stage-icon";

type StageNodeProps = NodeProps<StageNode>;

const ACCENT: Record<StageType, string> = {
  agent: "border-l-brand",
  parallel: "border-l-brand",
  human_gate: "border-l-warning",
  condition: "border-l-info",
  end: "border-l-muted-foreground",
};

// A handle is a big enough target to hit with a mouse; its colour says what it does.
const HANDLE = "!size-3.5 !border-2 !border-background";

function useTypeLabel() {
  const { t } = useT("workflows");
  return (type: StageType) => {
    switch (type) {
      case "agent":
        return t(($) => $.designer.type.agent);
      case "parallel":
        return t(($) => $.designer.type.parallel);
      case "human_gate":
        return t(($) => $.designer.type.human_gate);
      case "condition":
        return t(($) => $.designer.type.condition);
      case "end":
        return t(($) => $.designer.type.end);
    }
  };
}

function Detail({ data }: { data: StageNodeProps["data"] }) {
  const { t } = useT("workflows");
  const { stage } = data;
  const extras: string[] = [];
  let detail = "";
  if (stage.type === "agent") detail = stage.agent;
  if (stage.type === "condition") detail = stage.when;
  if (stage.type === "human_gate") {
    detail = stage.approvers === "" ? "" : t(($) => $.designer.approvers, { group: stage.approvers });
    if (stage.max_rework !== undefined) extras.push(t(($) => $.designer.max_rework, { count: stage.max_rework }));
    if (stage.escalate_after_hours !== undefined) extras.push(t(($) => $.designer.escalates, { count: stage.escalate_after_hours }));
  }
  return (
    <>
      {detail !== "" ? (
        <div className={cn("truncate text-caption text-muted-foreground", stage.type !== "human_gate" && "font-mono")}>{detail}</div>
      ) : null}
      {extras.length > 0 ? <div className="truncate text-micro text-muted-foreground">{extras.join(" · ")}</div> : null}
    </>
  );
}

function Body({ data, selected }: { data: StageNodeProps["data"]; selected: boolean | undefined }) {
  const { t } = useT("workflows");
  const typeLabel = useTypeLabel();
  const { stage } = data;
  return (
    <div
      className={cn(
        "flex h-full flex-col justify-center gap-0.5 overflow-hidden rounded-xl border border-l-4 bg-card px-3 py-2 text-card-foreground shadow-xs",
        ACCENT[stage.type],
        data.problems > 0 && "border-destructive",
        selected === true && "ring-2 ring-ring",
      )}
      title={stage.name ?? stage.id}
    >
      <div className="flex items-center gap-1.5 text-micro uppercase tracking-wide text-muted-foreground">
        <StageIcon type={stage.type} />
        <span className="truncate">{typeLabel(stage.type)}</span>
        {data.isStart ? (
          <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-px font-medium normal-case text-brand">{t(($) => $.designer.start)}</span>
        ) : null}
        {data.problems > 0 ? (
          <span
            className="ml-auto shrink-0 rounded-full bg-destructive/10 px-1.5 py-px font-medium normal-case text-destructive"
            title={t(($) => $.designer.problems_on_stage, { count: data.problems })}
          >
            ! {data.problems}
          </span>
        ) : null}
      </div>
      <div className="truncate text-body font-medium">{stage.name ?? stage.id}</div>
      {stage.name !== undefined ? <div className="truncate text-micro text-muted-foreground">{stage.id}</div> : null}
      <Detail data={data} />
    </div>
  );
}

/**
 * A condition is a decision, so it is drawn as a diamond. The text sits in the wide middle
 * (a diamond is narrow near its points), the outline carries what the box's border carries
 * elsewhere: the accent, the problem state and the selection ring. The input is the top point;
 * the outcomes leave from the left point (then) and the right point (else), as in a flowchart.
 */
function DiamondBody({ data, selected }: { data: StageNodeProps["data"]; selected: boolean | undefined }) {
  const { t } = useT("workflows");
  const typeLabel = useTypeLabel();
  const { stage } = data;
  return (
    <div className="relative h-full" title={stage.name ?? stage.id} data-shape="diamond">
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible drop-shadow-xs" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon
          points="50,0 100,50 50,100 0,50"
          vectorEffect="non-scaling-stroke"
          strokeWidth={selected === true ? 3 : 1.5}
          strokeLinejoin="round"
          className={cn(
            "fill-card",
            data.problems > 0 ? "stroke-destructive" : selected === true ? "stroke-ring" : "stroke-info",
          )}
        />
      </svg>
      <div className="absolute inset-x-[24%] inset-y-[22%] flex flex-col items-center justify-center gap-0.5 overflow-hidden text-center text-card-foreground">
        <div className="flex max-w-full items-center gap-1 text-micro uppercase tracking-wide text-muted-foreground">
          <StageIcon type={stage.type} />
          <span className="truncate">{typeLabel(stage.type)}</span>
          {data.isStart ? (
            <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-px font-medium normal-case text-brand">{t(($) => $.designer.start)}</span>
          ) : null}
          {data.problems > 0 ? (
            <span
              className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px font-medium normal-case text-destructive"
              title={t(($) => $.designer.problems_on_stage, { count: data.problems })}
            >
              ! {data.problems}
            </span>
          ) : null}
        </div>
        <div className="max-w-full truncate text-body font-medium">{stage.name ?? stage.id}</div>
        {stage.type === "condition" && stage.when !== "" ? (
          <div className="max-w-full truncate font-mono text-caption text-muted-foreground">{stage.when}</div>
        ) : null}
      </div>
    </div>
  );
}

function In({ readOnly }: { readOnly: boolean }) {
  return (
    <Handle
      type="target"
      position={Position.Top}
      id="in"
      isConnectable={!readOnly}
      className={cn(HANDLE, "!bg-muted-foreground", readOnly && "!opacity-0")}
    />
  );
}

export function AgentNode({ data, selected }: StageNodeProps) {
  return (
    <>
      <In readOnly={data.readOnly} />
      <Body data={data} selected={selected} />
      <Handle type="source" position={Position.Bottom} id="next" isConnectable={!data.readOnly} className={cn(HANDLE, "!bg-muted-foreground", data.readOnly && "!opacity-0")} />
    </>
  );
}

/**
 * A parallel stage in the notation of a process diagram: a filled circle splits the flow, each
 * branch is a card, and a second circle waits for all of them. One node, one way in at the top and
 * one way out at the bottom, so the stage is wired like any other. In the editor a card selects its
 * branch (the panel shows it), a button next to the split adds one, and a cross on a card removes it.
 */
export function ParallelNode({ data, selected }: StageNodeProps) {
  const { t } = useT("workflows");
  const typeLabel = useTypeLabel();
  const { stage } = data;
  if (stage.type !== "parallel") return null;
  const g = parallelGeometry(stage.branches.length);
  const { gate, cardW, cardH, padX, padY, topRow } = PARALLEL;
  const lineClass = "stroke-muted-foreground";
  const editable = !data.readOnly;
  const canRemove = editable && stage.branches.length > 2;
  const path = (x: number, from: number, to: number) => {
    const mid = (from + to) / 2;
    return x === g.cx ? `M${String(g.cx)} ${String(from)} V${String(to)}` : `M${String(g.cx)} ${String(from)} V${String(mid)} H${String(x)} V${String(to)}`;
  };
  return (
    <>
      <In readOnly={data.readOnly} />
      <div
        className={cn(
          // A faint dashed frame ties the split, the cards and the join into one block.
          "relative h-full w-full rounded-xl border border-dashed border-border bg-muted/20",
          data.problems > 0 && "border-destructive",
          selected === true && "ring-2 ring-ring",
        )}
        title={stage.name ?? stage.id}
        data-shape="parallel"
      >
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-visible" width={g.width} height={g.height}>
          {stage.branches.length === 0 ? (
            <path d={`M${String(g.cx)} ${String(g.splitY + gate / 2)} V${String(g.joinY - gate / 2)}`} className={lineClass} fill="none" strokeWidth={1.5} />
          ) : (
            g.centers.map((x, i) => (
              <g key={i} className={lineClass} fill="none" strokeWidth={1.5} strokeLinejoin="round">
                <path d={path(x, g.splitY + gate / 2, g.cardTop)} />
                <path d={path(x, g.joinY - gate / 2, g.cardBottom)} />
              </g>
            ))
          )}
          {[g.splitY, g.joinY].map((y) => (
            <g key={y} data-gate="true">
              <circle cx={g.cx} cy={y} r={gate / 2} className={cn("fill-brand", data.problems > 0 && "fill-destructive")} />
              <path
                d={`M${String(g.cx - 6)} ${String(y)} H${String(g.cx + 6)} M${String(g.cx)} ${String(y - 6)} V${String(y + 6)}`}
                className="stroke-background"
                strokeWidth={2}
                strokeLinecap="round"
                fill="none"
              />
            </g>
          ))}
        </svg>

        <div className="absolute flex flex-col justify-center overflow-hidden" style={{ left: padX, top: padY, height: topRow, width: g.cx - gate / 2 - padX - 8 }}>
          <div className="flex items-center gap-1.5 text-micro uppercase tracking-wide text-muted-foreground">
            <StageIcon type="parallel" />
            <span className="truncate">{typeLabel("parallel")}</span>
            {data.isStart ? (
              <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-px font-medium normal-case text-brand">{t(($) => $.designer.start)}</span>
            ) : null}
            {data.problems > 0 ? (
              <span
                className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px font-medium normal-case text-destructive"
                title={t(($) => $.designer.problems_on_stage, { count: data.problems })}
              >
                ! {data.problems}
              </span>
            ) : null}
          </div>
          <div className="truncate text-body font-medium">{stage.name ?? stage.id}</div>
        </div>

        {stage.branches.length > 0 ? (
          <span
            className="pointer-events-none absolute whitespace-nowrap text-micro text-muted-foreground"
            style={{ left: g.cx + gate / 2 + 8, top: g.joinY - 8 }}
          >
            {t(($) => $.designer.waits_for_all, { count: stage.branches.length })}
          </span>
        ) : null}

        {editable && stage.branches.length < MAX_BRANCHES && data.onBranchAdd !== undefined ? (
          <button
            type="button"
            className="nodrag nopan absolute flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-caption text-muted-foreground shadow-xs hover:text-foreground"
            style={{ left: g.cx + gate / 2 + 8, top: g.splitY - 11 }}
            onClick={(e) => {
              e.stopPropagation();
              data.onBranchAdd?.();
            }}
          >
            <Plus aria-hidden="true" className="size-3" />
            {t(($) => $.properties.branch_add)}
          </button>
        ) : null}

        <ul className="contents" aria-label={t(($) => $.designer.branches)}>
          {stage.branches.map((branch, i) => {
            const title = branch.name !== undefined && branch.name !== "" ? branch.name : t(($) => $.properties.branch_title, { n: i + 1 });
            const picked = data.selectedBranch === i;
            return (
              // Branches have no id: they are edited by position, so the index is the identity of a row.
              <li key={i} className="group absolute" style={{ left: (g.centers[i] ?? 0) - cardW / 2, top: g.cardTop, width: cardW, height: cardH }}>
                <button
                  type="button"
                  aria-label={`${title}: ${branch.agent === "" ? t(($) => $.designer.branch_empty) : branch.agent}`}
                  aria-pressed={editable ? picked : undefined}
                  className={cn(
                    "flex h-full w-full flex-col justify-center gap-0.5 overflow-hidden rounded-lg border border-l-4 border-l-brand bg-card px-2.5 text-left text-card-foreground shadow-xs",
                    picked && "ring-2 ring-ring",
                  )}
                  onClick={() => data.onBranchSelect?.(i)}
                >
                  <span className="line-clamp-2 break-words text-caption font-medium leading-tight">{title}</span>
                  <span className={cn("truncate font-mono text-micro text-muted-foreground", branch.agent === "" && "italic")}>
                    {branch.agent === "" ? t(($) => $.designer.branch_empty) : branch.agent}
                  </span>
                </button>
                {canRemove && data.onBranchRemove !== undefined ? (
                  <button
                    type="button"
                    aria-label={t(($) => $.properties.branch_remove, { n: i + 1 })}
                    className={cn(
                      "nodrag nopan absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100",
                      picked && "opacity-100",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      data.onBranchRemove?.(i);
                    }}
                  >
                    <X aria-hidden="true" className="size-2.5" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <Handle type="source" position={Position.Bottom} id="next" isConnectable={!data.readOnly} className={cn(HANDLE, "!bg-muted-foreground", data.readOnly && "!opacity-0")} />
    </>
  );
}

export function GateNode({ data, selected }: StageNodeProps) {
  const { t } = useT("workflows");
  return (
    <>
      <In readOnly={data.readOnly} />
      <Body data={data} selected={selected} />
      <Handle
        type="source" position={Position.Bottom} id="approve" style={{ left: "50%" }} isConnectable={!data.readOnly}
        className={cn(HANDLE, "!bg-success", data.readOnly && "!opacity-0")} title={t(($) => $.designer.edge.approve)}
      />
      <Handle
        type="source" position={Position.Right} id="reject" isConnectable={!data.readOnly}
        className={cn(HANDLE, "!bg-warning", data.readOnly && "!opacity-0")} title={t(($) => $.designer.edge.reject)}
      />
    </>
  );
}

export function ConditionNode({ data, selected }: StageNodeProps) {
  const { t } = useT("workflows");
  return (
    <>
      <In readOnly={data.readOnly} />
      <DiamondBody data={data} selected={selected} />
      <Handle
        type="source" position={Position.Left} id="then" isConnectable={!data.readOnly}
        className={cn(HANDLE, "!bg-info", data.readOnly && "!opacity-0")} title={t(($) => $.designer.edge.then)}
      />
      <Handle
        type="source" position={Position.Right} id="else" isConnectable={!data.readOnly}
        className={cn(HANDLE, "!bg-muted-foreground", data.readOnly && "!opacity-0")} title={t(($) => $.designer.edge.else)}
      />
    </>
  );
}

export function EndNode({ data, selected }: StageNodeProps) {
  return (
    <>
      <In readOnly={data.readOnly} />
      <Body data={data} selected={selected} />
    </>
  );
}

export const nodeTypes = {
  agent: AgentNode,
  parallel: ParallelNode,
  human_gate: GateNode,
  condition: ConditionNode,
  end: EndNode,
};
