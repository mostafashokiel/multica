"use client";

import { useId } from "react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";

/** One step of the workflow, with where an agent moves the issue from it. */
export interface DiagramNode {
  id: string;
  label: string;
  /** Who the step hands off to, when it does; shown under the name. */
  who?: string;
  /** Rendered at the start of the row: the status icon. */
  icon: React.ReactNode;
  /** Where the step's agent moves the issue when done; only agent steps have one. */
  next?: string;
  /** Where the step's agent sends the issue back; only agent steps have one. */
  back?: string;
  start?: boolean;
}

const NODE_H = 52;
const GAP = 28;
const ROW = NODE_H + GAP;
const LANE_W = 44;
const LANE_STEP = 9;

interface Edge {
  from: number;
  to: number;
  lane: number;
}

/**
 * Gives each edge a lane so edges that overlap in height do not run on top of
 * each other: edges are placed shortest first, each in the first lane free over
 * its whole span.
 */
function assignLanes(spans: { from: number; to: number }[]): Edge[] {
  const order = spans
    .map((s, i) => ({ ...s, i, lo: Math.min(s.from, s.to), hi: Math.max(s.from, s.to) }))
    .sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo);
  const lanes: { lo: number; hi: number }[][] = [];
  const out: Edge[] = new Array(spans.length);
  for (const e of order) {
    let lane = lanes.findIndex((used) => used.every((u) => e.hi < u.lo || e.lo > u.hi));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane]!.push({ lo: e.lo, hi: e.hi });
    out[e.i] = { from: e.from, to: e.to, lane };
  }
  return out;
}

const y = (index: number) => index * ROW + NODE_H / 2;

/**
 * A top-to-bottom picture of a workflow (MUL-7420): the steps in board order,
 * forward arrows on the right where an agent moves the issue on, dashed arrows
 * on the left where it sends the issue back. Steps handled by people have no
 * arrows: they move the issue by hand. Plain SVG and HTML, so it needs no
 * dependency; selecting a step is the same as selecting it in the list.
 */
export function WorkflowDiagram({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: DiagramNode[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useT("issues");
  const markerId = useId();
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  const forward = nodes.flatMap((n, from) => {
    const to = n.next ? index.get(n.next) : undefined;
    return to !== undefined && to !== from ? [{ from, to }] : [];
  });
  const back = nodes.flatMap((n, from) => {
    const to = n.back ? index.get(n.back) : undefined;
    return to !== undefined && to !== from ? [{ from, to }] : [];
  });
  const forwardEdges = assignLanes(forward);
  const backEdges = assignLanes(back);
  const height = nodes.length * ROW - GAP;

  /** A curve out of one node's edge and back into another's, bulging into the lane. */
  const path = (e: Edge, side: "right" | "left") => {
    const start = side === "right" ? 0 : LANE_W;
    const bulge = 14 + e.lane * LANE_STEP;
    const x = side === "right" ? bulge : LANE_W - bulge;
    // Land a little short of the node, where the arrowhead ends.
    const tip = side === "right" ? 1 : LANE_W - 1;
    return `M${start},${y(e.from)} C${x},${y(e.from)} ${x},${y(e.to)} ${tip},${y(e.to)}`;
  };

  return (
    <div>
      <div
        role="group"
        aria-label={t(($) => $.workflows.diagram.aria)}
        className="relative"
        style={{ height, paddingLeft: LANE_W, paddingRight: LANE_W }}
      >
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 overflow-visible text-warning"
          width={LANE_W}
          height={height}
        >
          <defs>
            <marker id={`${markerId}-back`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {backEdges.map((e, i) => (
            <path
              key={i}
              d={path(e, "left")}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              markerEnd={`url(#${markerId}-back)`}
            />
          ))}
        </svg>
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 overflow-visible text-muted-foreground"
          width={LANE_W}
          height={height}
        >
          <defs>
            <marker id={`${markerId}-next`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {forwardEdges.map((e, i) => (
            <path key={i} d={path(e, "right")} fill="none" stroke="currentColor" strokeWidth={1.5} markerEnd={`url(#${markerId}-next)`} />
          ))}
        </svg>

        {nodes.map((node, i) => {
          const selected = node.id === selectedId;
          return (
            <button
              key={node.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(node.id)}
              style={{ top: i * ROW, height: NODE_H, left: LANE_W, right: LANE_W }}
              className={cn(
                "absolute flex items-center gap-2 rounded-lg border px-2.5 text-left transition-colors",
                selected ? "border-foreground/20 bg-accent" : "border-surface-border bg-card hover:bg-accent/50",
              )}
            >
              <span className="shrink-0">{node.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{node.label}</span>
                {node.who && <span className="block truncate text-caption text-muted-foreground">{node.who}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="22" height="8" className="text-muted-foreground">
            <line x1="0" y1="4" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {t(($) => $.workflows.diagram.next)}
        </li>
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="22" height="8" className="text-warning">
            <line x1="0" y1="4" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          {t(($) => $.workflows.diagram.back)}
        </li>
      </ul>
      <p className="mt-1.5 text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.diagram.hint)}</p>
    </div>
  );
}
