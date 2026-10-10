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
  // Only the size of a parallel stage with no branches; sizeOf gives the real one.
  parallel: { width: 300, height: 164 },
  human_gate: { width: 232, height: 108 },
  // A diamond needs more height than a box for the same text: it is narrow near its points.
  condition: { width: 232, height: 128 },
  end: { width: 140, height: 52 },
};

/**
 * A parallel stage is drawn as a split circle, one card per branch side by side, and a join circle,
 * all inside one node. Every measure is here so the node, the layout and the tests agree on the size.
 */
export const PARALLEL = {
  padX: 12,
  padY: 4,
  /** The row with the label and the split circle. */
  topRow: 36,
  gate: 28,
  gapY: 20,
  cardW: 148,
  cardH: 60,
  cardGap: 14,
  minWidth: 300,
} as const;

export function parallelGeometry(count: number) {
  const { padX, padY, topRow, gate, gapY, cardW, cardH, cardGap, minWidth } = PARALLEL;
  const rowW = count * cardW + Math.max(0, count - 1) * cardGap;
  const width = Math.max(minWidth, rowW + 2 * padX);
  const cardTop = padY + topRow + gapY;
  const cardBottom = cardTop + cardH;
  const joinY = cardBottom + gapY + gate / 2;
  const left = (width - rowW) / 2;
  return {
    width,
    height: joinY + gate / 2 + padY,
    cx: width / 2,
    splitY: padY + topRow / 2,
    cardTop,
    cardBottom,
    joinY,
    centers: Array.from({ length: count }, (_, i) => left + i * (cardW + cardGap) + cardW / 2),
  };
}

export const sizeOf = (stage: Stage): Size => {
  if (stage.type === "parallel") {
    const { width, height } = parallelGeometry(stage.branches.length);
    return { width, height };
  }
  return NODE_SIZE[stage.type];
};

export interface StageNodeData extends Record<string, unknown> {
  stage: Stage;
  isStart: boolean;
  problems: number;
  readOnly: boolean;
  /** Parallel stages only: which branch is selected (the panel shows it), and the edits the node offers. */
  selectedBranch?: number | null;
  onBranchSelect?: (index: number) => void;
  onBranchAdd?: () => void;
  onBranchRemove?: (index: number) => void;
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
  /** What a parallel stage's node offers for editing its branches; given the stage's id. */
  branchEdit?: (stageId: string) => Pick<StageNodeData, "selectedBranch" | "onBranchSelect" | "onBranchAdd" | "onBranchRemove">,
): StageNode[] {
  return def.stages.map((stage, index) => ({
    id: stage.id,
    type: stage.type,
    position: positions[stage.id] ?? fallback(index),
    data: {
      stage,
      isStart: def.start === stage.id,
      problems: problemsByStage[stage.id] ?? 0,
      readOnly,
      ...(stage.type === "parallel" && branchEdit !== undefined ? branchEdit(stage.id) : {}),
    },
    // Known sizes let the first fit and the minimap work before anything has been measured.
    initialWidth: sizeOf(stage).width,
    initialHeight: sizeOf(stage).height,
    // A fixed box, so handles and edges line up whatever the text says.
    style: { width: sizeOf(stage).width, height: sizeOf(stage).height },
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

// An edge that leaves a stage sideways first runs a short way out before turning.
const SIDE_EDGE_OFFSET = 20;

// A rework loop (a gate's reject) goes back to an earlier stage. It is drawn by its own edge type: out of the
// side of the gate, along a corridor to the right of the whole diagram, up beside the stages in between, and
// into the top of the target from just above it. Running outside everything is what keeps it from crossing a
// stage, however wide one of them is (a parallel stage is much wider than the others). Loops that span
// different heights share a corridor; loops that overlap get one each, the shorter inside the longer.
export const LOOP_CORRIDOR_GAP = 36;
export const LOOP_CORRIDOR_STEP = 18;
/** How far above the target the loop turns toward it: inside the gap between two rows of stages. */
export const LOOP_HEAD_CLEARANCE = 18;

interface Loop {
  id: string;
  source: Stage;
  target: string;
}

/** The corridor x of each loop, by edge id. `rect` gives a stage's box on the canvas, or undefined when it has none. */
export function loopCorridors(
  loops: Loop[],
  rect: (id: string) => { x: number; y: number; width: number; height: number } | undefined,
  diagramRight: number,
): Map<string, number> {
  const spans = loops.flatMap((loop) => {
    const from = rect(loop.source.id);
    const to = rect(loop.target);
    if (from === undefined || to === undefined) return [];
    const ends = [from.y + from.height / 2, to.y];
    return [{ id: loop.id, top: Math.min(...ends), bottom: Math.max(...ends) }];
  });
  spans.sort((a, b) => a.bottom - a.top - (b.bottom - b.top) || a.top - b.top);
  const lanes: { top: number; bottom: number }[][] = [];
  const out = new Map<string, number>();
  for (const span of spans) {
    let lane = lanes.findIndex((taken) => taken.every((t) => span.bottom < t.top || span.top > t.bottom));
    if (lane === -1) lane = lanes.push([]) - 1;
    (lanes[lane] as { top: number; bottom: number }[]).push(span);
    out.set(span.id, diagramRight + LOOP_CORRIDOR_GAP + LOOP_CORRIDOR_STEP * lane);
  }
  return out;
}

/**
 * One edge per connected output whose target exists; dangling references are reported as problems instead.
 * With `positions`, rework loops are routed outside the diagram (see above); without them they take a short
 * default corridor, which is only right for a diagram whose stages are all the same width.
 */
export function toFlowEdges(
  def: WorkflowDefinition,
  readOnly: boolean,
  labelOf: (handle: Handle) => string | undefined,
  selectedEdgeId: string | null = null,
  positions?: Positions,
): Edge[] {
  const ids = new Set(def.stages.map((s) => s.id));
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const rect = (id: string) => {
    const stage = byId.get(id);
    const at = positions?.[id];
    if (stage === undefined || at === undefined) return undefined;
    const size = sizeOf(stage);
    return { x: at.x, y: at.y, width: size.width, height: size.height };
  };
  const loops: Loop[] = [];
  for (const stage of def.stages) {
    const target = handleTarget(stage, "reject");
    if (STAGE_HANDLES[stage.type].includes("reject") && target !== "" && ids.has(target)) {
      loops.push({ id: edgeId(stage.id, "reject"), source: stage, target });
    }
  }
  let diagramRight = -Infinity;
  for (const stage of def.stages) {
    const r = rect(stage.id);
    if (r !== undefined) diagramRight = Math.max(diagramRight, r.x + r.width);
  }
  const corridors = positions === undefined ? new Map<string, number>() : loopCorridors(loops, rect, diagramRight);

  const edges: Edge[] = [];
  for (const stage of def.stages) {
    for (const handle of STAGE_HANDLES[stage.type]) {
      const target = handleTarget(stage, handle);
      if (target === "" || !ids.has(target)) continue;
      const look = EDGE_STYLE[handle];
      const id = edgeId(stage.id, handle);
      const corridor = corridors.get(id);
      const common = {
        id,
        source: stage.id,
        sourceHandle: handle,
        target,
        targetHandle: "in",
        label: labelOf(handle),
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 11 },
        labelBgStyle: { fill: "var(--background)", fillOpacity: 0.9 },
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 4,
        selected: id === selectedEdgeId,
        deletable: !readOnly,
        selectable: !readOnly,
        focusable: !readOnly,
        style: { stroke: look.stroke, strokeWidth: 2, ...(look.dashed ? { strokeDasharray: "6 4" } : {}) },
        markerEnd: { type: "arrowclosed" as never, color: look.stroke },
      };
      if (corridor !== undefined) {
        edges.push({ ...common, type: "loop", data: { corridorX: corridor } });
        continue;
      }
      const offset = handle === "reject" ? 56 : SIDE_EDGE_OFFSET;
      const edge: Edge & { pathOptions: { offset: number; borderRadius: number } } = {
        ...common,
        type: "smoothstep",
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
    bottom = Math.max(bottom, p.y + sizeOf(stage).height);
  }
  return bottom === -Infinity ? 0 : bottom - top;
}
