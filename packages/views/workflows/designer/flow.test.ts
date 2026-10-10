import { describe, expect, it } from "vitest";
import { addStage, connect, emptyDefinition, renameStage, updateMetadata, type WorkflowDefinition } from "@multica/core/workflows";
import { NODE_SIZE, PARALLEL, parallelGeometry, sizeOf, toFlowEdges } from "./flow";

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

const offsets = () => {
  const out: Record<string, number> = {};
  for (const e of toFlowEdges(chain(), true, () => undefined)) {
    out[e.id] = (e as unknown as { pathOptions: { offset: number } }).pathOptions.offset;
  }
  return out;
};

describe("toFlowEdges corridors", () => {
  it("sends each loop back through its own corridor, further out than a condition's side edges", () => {
    const o = offsets();

    const loops = [o["gate1:reject"]!, o["gate2:reject"]!];
    expect(new Set(loops).size).toBe(2);
    for (const loop of loops) expect(loop).toBeGreaterThan(Math.max(o["check:then"]!, o["check:else"]!));
  });

  it("is stable: the same workflow gives the same offsets", () => {
    expect(offsets()).toEqual(offsets());
  });

  it("gives the forward edges the short run", () => {
    const o = offsets();
    expect(o["work:next"]).toBe(o["check:else"]);
    expect(o["gate1:approve"]).toBe(o["check:then"]);
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
