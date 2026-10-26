import type { Stage, WorkflowDefinition } from "./definition";
import { STAGE_HANDLES, handleTarget, type Positions } from "./designer-model";

/**
 * Automatic placement of a workflow's stages for the canvas. A pure function of the
 * definition: the same workflow always gets the same positions, and it needs no graph
 * library.
 *
 * Stages flow top to bottom. A stage's layer is the longest forward path to it from the
 * start. An edge that leads back to the same layer or an earlier one (a rework loop) is
 * ignored when layering, so a loop never pushes anything down. Stages the start cannot
 * reach are placed below everything it can. Within a layer, stages keep the order they
 * are written in.
 */

export interface Size {
  width: number;
  height: number;
}

export interface LayoutOptions {
  gapX?: number;
  gapY?: number;
  /** Top-left corner of the whole layout. */
  originX?: number;
  originY?: number;
}

export function autoLayout(
  def: WorkflowDefinition,
  sizeOf: (stage: Stage) => Size,
  options: LayoutOptions = {},
): Positions {
  const { gapX = 56, gapY = 60, originX = 40, originY = 40 } = options;
  const stages = def.stages;
  if (stages.length === 0) return {};

  // First stage with an id wins; edges to anything else are dropped.
  const index = new Map<string, number>();
  stages.forEach((s, i) => {
    if (!index.has(s.id)) index.set(s.id, i);
  });
  const ids = [...index.keys()];
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const s of stages) {
    if (index.get(s.id) !== stages.indexOf(s)) continue;
    for (const handle of STAGE_HANDLES[s.type]) {
      const to = handleTarget(s, handle);
      if (index.has(to)) out.get(s.id)?.push(to);
    }
  }

  // ---- Depth-first search from the start: which edges close a cycle, what is reachable ----
  const root = index.has(def.start) ? def.start : (ids[0] as string);
  const state = new Map<string, 0 | 1 | 2>();
  const reachable = new Set<string>();
  const closing = new Set<string>(); // "from>to"
  const visit = (start: string, mark: boolean) => {
    if (state.get(start)) return;
    state.set(start, 1);
    if (mark) reachable.add(start);
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; next: number };
      const outs = out.get(top.id) ?? [];
      if (top.next >= outs.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = outs[top.next++] as string;
      const s = state.get(to) ?? 0;
      if (s === 1) closing.add(`${top.id}>${to}`);
      else if (s === 0) {
        state.set(to, 1);
        if (mark) reachable.add(to);
        stack.push({ id: to, next: 0 });
      }
    }
  };
  visit(root, true);
  for (const id of ids) visit(id, false);

  // ---- Layers: longest path over the edges that do not close a cycle ----
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, tos] of out) {
    for (const to of tos) {
      if (closing.has(`${from}>${to}`)) continue;
      forward.get(from)?.push(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    for (const to of forward.get(id) ?? []) {
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  let deepest = -1;
  for (const id of ids) if (reachable.has(id)) deepest = Math.max(deepest, layer.get(id) ?? 0);
  for (const id of ids) if (!reachable.has(id)) layer.set(id, (layer.get(id) ?? 0) + deepest + 1);

  // ---- Coordinates ----
  const layerCount = Math.max(...ids.map((id) => layer.get(id) ?? 0)) + 1;
  const rows: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) (rows[layer.get(id) ?? 0] as string[]).push(id);
  const sizes = new Map(ids.map((id) => [id, sizeOf(stages[index.get(id) as number] as Stage)]));
  const rowWidth = (row: string[]) => row.reduce((sum, id) => sum + (sizes.get(id)?.width ?? 0), 0) + Math.max(0, row.length - 1) * gapX;
  const widest = Math.max(...rows.map(rowWidth));

  const positions: Positions = {};
  let y = originY;
  for (const row of rows) {
    const rowHeight = Math.max(0, ...row.map((id) => sizes.get(id)?.height ?? 0));
    let x = originX + (widest - rowWidth(row)) / 2;
    for (const id of row) {
      const size = sizes.get(id) as Size;
      // Shorter nodes sit on the row's vertical centre so handles line up.
      positions[id] = { x: Math.round(x), y: Math.round(y + (rowHeight - size.height) / 2) };
      x += size.width + gapX;
    }
    y += rowHeight + gapY;
  }
  return positions;
}

/**
 * Read a version's stored layout (opaque JSON to the server) into positions, ignoring
 * anything that is not a finite `{x, y}` for a string key.
 */
export function readLayout(layout: unknown): Positions {
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) return {};
  const out: Positions = {};
  for (const [id, point] of Object.entries(layout)) {
    if (typeof point !== "object" || point === null) continue;
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      out[id] = { x, y };
    }
  }
  return out;
}

/**
 * Where to draw each stage of a loaded version: the saved positions when every stage has
 * one, otherwise a fresh automatic layout of the whole thing. Mixing the two would let a
 * newly added stage land on top of a saved one.
 */
export function resolvePositions(
  def: WorkflowDefinition,
  layout: unknown,
  sizeOf: (stage: Stage) => Size,
): Positions {
  const saved = readLayout(layout);
  if (def.stages.length > 0 && def.stages.every((s) => saved[s.id] !== undefined)) {
    return Object.fromEntries(def.stages.map((s) => [s.id, saved[s.id] as { x: number; y: number }]));
  }
  return autoLayout(def, sizeOf);
}
