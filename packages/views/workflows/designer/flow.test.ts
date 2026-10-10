import { describe, expect, it } from "vitest";
import { addStage, autoLayout, connect, emptyDefinition, renameStage, updateMetadata, type WorkflowDefinition } from "@multica/core/workflows";
import { LOOP_CORRIDOR_GAP, LOOP_CORRIDOR_STEP, NODE_SIZE, PARALLEL, loopCorridors, parallelGeometry, sizeOf, toFlowEdges } from "./flow";

// work -> gate1 -> check -> gate2 -> done, with each gate's reject looping back and the check's "else"
// leaving the same side as those loops.
function chain(): WorkflowDefinition {
  let d = updateMetadata(emptyDefinition(), { id: "demo" });
  const add = (type: Parameters<typeof addStage>[1], id: string) => {
    const a = addStage(d, type);
    const r = renameStage(a.definition, a.id, id);
    if (!r.ok) throw new Error(r.reason);
    d = r.definition;
  };
  add("agent", "work");
  add("human_gate", "gate1");
  add("condition", "check");
  add("human_gate", "gate2");
  add("end", "done");
  d = connect(d, "work", "next", "gate1");
  d = connect(d, "gate1", "approve", "check");
  d = connect(d, "gate1", "reject", "work");
  d = connect(d, "check", "then", "gate2");
  d = connect(d, "check", "else", "gate2");
  d = connect(d, "gate2", "approve", "done");
  d = connect(d, "gate2", "reject", "work");
  return d;
}

const layout = () => autoLayout(chain(), sizeOf);
const edgesWithLayout = () => toFlowEdges(chain(), true, () => undefined, null, layout());
const corridorOf = (id: string) => (edgesWithLayout().find((e) => e.id === id)?.data as { corridorX: number } | undefined)?.corridorX;

describe("toFlowEdges rework loops", () => {
  it("draws each reject as a loop edge that runs to the right of every stage", () => {
    const positions = layout();
    const right = Math.max(...chain().stages.map((s) => positions[s.id]!.x + sizeOf(s).width));
    for (const id of ["gate1:reject", "gate2:reject"]) {
      expect(edgesWithLayout().find((e) => e.id === id)?.type).toBe("loop");
      expect(corridorOf(id)!).toBeGreaterThanOrEqual(right + LOOP_CORRIDOR_GAP);
    }
  });

  it("gives loops that overlap in height their own corridors, the shorter one inside", () => {
    // gate1 -> work is shorter than gate2 -> work, and both start below work, so they overlap.
    const inner = corridorOf("gate1:reject")!;
    const outer = corridorOf("gate2:reject")!;
    expect(outer - inner).toBe(LOOP_CORRIDOR_STEP);
  });

  it("lets loops that do not overlap share a corridor", () => {
    const rect = (id: string) => ({ a: { x: 0, y: 0, width: 100, height: 50 }, b: { x: 0, y: 100, width: 100, height: 50 }, c: { x: 0, y: 300, width: 100, height: 50 }, d: { x: 0, y: 400, width: 100, height: 50 } })[id as "a"];
    const stage = (id: string) => ({ id, type: "human_gate" as const, approvers: "", on_approve: "", on_reject: "" });
    const corridors = loopCorridors([{ id: "b:reject", source: stage("b"), target: "a" }, { id: "d:reject", source: stage("d"), target: "c" }], rect, 500);
    expect(corridors.get("b:reject")).toBe(corridors.get("d:reject"));
  });

  it("never lets a loop cross a stage, even when one stage is much wider than the rest", () => {
    // The widest stage sets the right edge; the corridor is beyond it.
    let d = chain();
    d = addStage(d, "parallel").definition;
    const wide = d.stages.find((s) => s.type === "parallel")!;
    const positions = { ...autoLayout(d, sizeOf) };
    const right = Math.max(...d.stages.map((s) => positions[s.id]!.x + sizeOf(s).width));
    const loops = toFlowEdges(d, true, () => undefined, null, positions).filter((e) => e.type === "loop");
    expect(sizeOf(wide).width).toBeGreaterThan(sizeOf(d.stages[0]!).width);
    for (const e of loops) expect((e.data as { corridorX: number }).corridorX).toBeGreaterThan(right);
  });

  it("keeps the short default for a reject when there are no positions to route by", () => {
    const e = toFlowEdges(chain(), true, () => undefined).find((x) => x.id === "gate1:reject")!;
    expect(e.type).toBe("smoothstep");
  });

  it("is stable: the same workflow gives the same corridors", () => {
    expect(corridorOf("gate1:reject")).toBe(corridorOf("gate1:reject"));
    expect(edgesWithLayout().map((e) => e.id)).toEqual(edgesWithLayout().map((e) => e.id));
  });
});

describe("sizeOf and the parallel geometry", () => {
  const parallel = (n: number) => ({ id: "p", type: "parallel" as const, branches: Array.from({ length: n }, () => ({ agent: "a" })), next: "" });

  it("is the type's box, except that a parallel stage is as wide as its row of branches", () => {
    expect(sizeOf({ id: "a", type: "agent", agent: "", next: "" })).toEqual(NODE_SIZE.agent);
    expect(sizeOf(parallel(0)).width).toBe(PARALLEL.minWidth);
    expect(sizeOf(parallel(2)).width).toBe(2 * PARALLEL.cardW + PARALLEL.cardGap + 2 * PARALLEL.padX);
    expect(sizeOf(parallel(5)).width - sizeOf(parallel(4)).width).toBe(PARALLEL.cardW + PARALLEL.cardGap);
    expect(sizeOf(parallel(2)).height).toBe(sizeOf(parallel(8)).height);
  });

  it("puts the branch cards in one centred row between the two circles", () => {
    for (const n of [0, 1, 2, 3, 8]) {
      const g = parallelGeometry(n);
      expect(g.centers).toHaveLength(n);
      if (n > 0) expect((g.centers[0]! + g.centers[n - 1]!) / 2).toBeCloseTo(g.cx, 5);
      if (n > 1) expect(g.centers[1]! - g.centers[0]!).toBe(PARALLEL.cardW + PARALLEL.cardGap);
      expect(g.splitY).toBeLessThan(g.cardTop);
      expect(g.cardBottom).toBeLessThan(g.joinY);
      expect(g.height).toBeGreaterThan(g.joinY);
      expect(Math.min(...g.centers, g.cx) - PARALLEL.cardW / 2).toBeGreaterThanOrEqual(0);
    }
  });
});
