"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import type { StageType } from "@multica/core/workflows";
import { useT } from "../../i18n";
import type { StageNode } from "./flow";
import { StageIcon } from "./stage-icon";

type StageNodeProps = NodeProps<StageNode>;

const ACCENT: Record<StageType, string> = {
  agent: "border-l-brand",
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
  human_gate: GateNode,
  condition: ConditionNode,
  end: EndNode,
};
