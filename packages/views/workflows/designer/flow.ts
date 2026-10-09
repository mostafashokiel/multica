import type { Edge, Node } from "@xyflow/react";
import {
  STAGE_HANDLES,
  handleTarget,
  type Handle,
  type Positions,
  type Size,
  type Stage,
  type StageType,
  type WorkflowDefinition,
} from "@multica/core/workflows";

/** Drawn size of each stage type; also the layout's idea of a node and the size before it is measured. */
export const NODE_SIZE: Record<StageType, Size> = {
  agent: { width: 232, height: 90 },
  human_gate: { width: 232, height: 108 },
  // A diamond needs more height than a box for the same text: it is narrow near its points.
  condition: { width: 232, height: 128 },
  end: { width: 140, height: 52 },
};

export const sizeOf = (type: StageType): Size => NODE_SIZE[type];

export interface StageNodeData extends Record<string, unknown> {
  stage: Stage;
  isStart: boolean;
  problems: number;
  readOnly: boolean;
}

export type StageNode = Node<StageNodeData>;

/** Fallback position for a stage that has none: a column, so nothing overlaps. */
function fallback(index: number): { x: number; y: number } {
  return { x: 40, y: 40 + index * 120 };
}

export function toFlowNodes(
  def: WorkflowDefinition,
  positions: Positions,
  problemsByStage: Readonly<Record<string, number>>,
  readOnly: boolean,
  selectedId: string | null = null,
): StageNode[] {
  return def.stages.map((stage, index) => ({
    id: stage.id,
    type: stage.type,
    position: positions[stage.id] ?? fallback(index),
    data: { stage, isStart: def.start === stage.id, problems: problemsByStage[stage.id] ?? 0, readOnly },
    // Known sizes let the first fit and the minimap work before anything has been measured.
    initialWidth: NODE_SIZE[stage.type].width,
    initialHeight: NODE_SIZE[stage.type].height,
    // A fixed box, so handles and edges line up whatever the text says.
    style: { width: NODE_SIZE[stage.type].width, height: NODE_SIZE[stage.type].height },
    selected: stage.id === selectedId,
    draggable: !readOnly,
    deletable: !readOnly,
    selectable: !readOnly,
    focusable: true,
  }));
}

export const edgeId = (source: string, handle: Handle): string => `${source}:${handle}`;

const HANDLES: readonly string[] = ["next", "approve", "reject", "then", "else"];

export function parseEdgeId(id: string): { source: string; handle: Handle } | undefined {
  const at = id.lastIndexOf(":");
  if (at < 1) return undefined;
  const handle = id.slice(at + 1);
  return HANDLES.includes(handle) ? { source: id.slice(0, at), handle: handle as Handle } : undefined;
}

// Colours come from the theme's variables, so the canvas follows light and dark.
const EDGE_STYLE: Record<Handle, { stroke: string; dashed?: boolean }> = {
  next: { stroke: "var(--muted-foreground)" },
  approve: { stroke: "var(--success)" },
  reject: { stroke: "var(--warning)", dashed: true },
  then: { stroke: "var(--info)" },
  else: { stroke: "var(--muted-foreground)", dashed: true },
};

// Edges that leave a stage sideways first run a short way out before turning. If they all ran the same
// distance, a loop back to an earlier stage (reject) and the "else" of a condition above it would share
// one vertical corridor and draw over each other. The loops get their own corridors, further out and
// staggered, one per loop in the order the workflow lists them.
const SIDE_EDGE_OFFSET = 20;
const LOOP_EDGE_OFFSET = 40;
const LOOP_EDGE_STEP = 16;

/** One edge per connected output whose target exists; dangling references are reported as problems instead. */
export function toFlowEdges(
  def: WorkflowDefinition,
  readOnly: boolean,
  labelOf: (handle: Handle) => string | undefined,
  selectedEdgeId: string | null = null,
): Edge[] {
  const ids = new Set(def.stages.map((s) => s.id));
  const edges: Edge[] = [];
  let loops = 0;
  for (const stage of def.stages) {
    for (const handle of STAGE_HANDLES[stage.type]) {
      const target = handleTarget(stage, handle);
      if (target === "" || !ids.has(target)) continue;
      const look = EDGE_STYLE[handle];
      const id = edgeId(stage.id, handle);
      const offset = handle === "reject" ? LOOP_EDGE_OFFSET + LOOP_EDGE_STEP * loops++ : SIDE_EDGE_OFFSET;
      const edge: Edge & { pathOptions: { offset: number; borderRadius: number } } = {
        id,
        source: stage.id,
        sourceHandle: handle,
        target,
        targetHandle: "in",
        type: "smoothstep",
        label: labelOf(handle),
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 11 },
        labelBgStyle: { fill: "var(--background)", fillOpacity: 0.9 },
        labelBgPadding: [5, 2],
        labelBgBorderRadius: 4,
        selected: id === selectedEdgeId,
        deletable: !readOnly,
        selectable: !readOnly,
        focusable: !readOnly,
        style: { stroke: look.stroke, strokeWidth: 2, ...(look.dashed ? { strokeDasharray: "6 4" } : {}) },
        markerEnd: { type: "arrowclosed" as never, color: look.stroke },
        pathOptions: { offset, borderRadius: 8 },
      };
      edges.push(edge);
    }
  }
  return edges;
}

/** The height the stages occupy, so a view can be as tall as its content (to a limit) instead of squeezing a long chain into a short box. */
export function contentHeight(def: WorkflowDefinition, positions: Positions): number {
  let top = Infinity;
  let bottom = -Infinity;
  for (const stage of def.stages) {
    const p = positions[stage.id];
    if (p === undefined) continue;
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y + NODE_SIZE[stage.type].height);
  }
  return bottom === -Infinity ? 0 : bottom - top;
}
