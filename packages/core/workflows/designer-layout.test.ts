import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDefinitionText, type Stage, type StageType, type WorkflowDefinition } from "./definition";
import { autoLayout, readLayout, resolvePositions, type Size } from "./designer-layout";
import { addStage, connect, emptyDefinition, renameStage, setStart } from "./designer-model";

const size = (stage: Stage): Size =>
  stage.type === "end" ? { width: 80, height: 80 } : { width: 200, height: stage.type === "parallel" ? 70 + 20 * stage.branches.length : 70 };
const pilot = (): WorkflowDefinition => {
  const r = parseDefinitionText(
    readFileSync(new URL("../../../server/internal/workflow/testdata/pilot.canonical.yaml", import.meta.url), "utf8"),
  );
  if (!r.ok) throw new Error("pilot");
  return r.definition;
};

/** A definition from ids and edges, all agent stages unless said otherwise. */
function build(ids: string[], edges: [string, "next" | "approve" | "reject" | "then" | "else", string][], types: Record<string, StageType> = {}) {
  let d = emptyDefinition();
  for (const id of ids) {
    const added = addStage(d, types[id] ?? "agent");
    const renamed = renameStage(added.definition, added.id, id);
    if (!renamed.ok) throw new Error(renamed.reason);
    d = renamed.definition;
  }
  for (const [from, handle, to] of edges) d = connect(d, from, handle, to);
  return d;
}

describe("autoLayout", () => {
  it("places nothing for an empty definition", () => {
    expect(autoLayout(emptyDefinition(), size)).toEqual({});
  });

  it("stacks a chain top to bottom in order, centred", () => {
    const p = autoLayout(build(["a", "b", "c"], [["a", "next", "b"], ["b", "next", "c"]]), size);
    expect(p.a!.y).toBeLessThan(p.b!.y);
    expect(p.b!.y).toBeLessThan(p.c!.y);
    expect(new Set([p.a!.x, p.b!.x, p.c!.x]).size).toBe(1);
  });

  it("leaves room for a parallel stage's extra height, so the next stage does not overlap it", () => {
    const d = build(["p", "after"], [["p", "next", "after"]], { p: "parallel" });
    const p = autoLayout(d, size);
    const tall = size(d.stages[0]!).height;
    expect(tall).toBeGreaterThan(70);
    expect(p.after!.y).toBeGreaterThanOrEqual(p.p!.y + tall);
  });

  it("puts the two branches of a condition side by side with a gap, centred under it", () => {
    const d = build(["c", "yes", "no"], [["c", "then", "yes"], ["c", "else", "no"]], { c: "condition" });
    const p = autoLayout(d, size);
    expect(p.yes!.y).toBe(p.no!.y);
    expect(Math.abs(p.yes!.x - p.no!.x)).toBeGreaterThanOrEqual(200 + 56);
    expect(p.c!.x + 100).toBeCloseTo((p.yes!.x + p.no!.x + 200) / 2, 0);
  });

  it("does not let a rework loop push anything down", () => {
    const d = build(["work", "gate", "done"], [["work", "next", "gate"], ["gate", "approve", "done"], ["gate", "reject", "work"]], { gate: "human_gate", done: "end" });
    const p = autoLayout(d, size);
    expect(p.work!.y).toBeLessThan(p.gate!.y);
    expect(p.gate!.y).toBeLessThan(p.done!.y);
  });

  it("lays out the real pilot: every stage placed, none overlapping, start on top", () => {
    const d = pilot();
    const p = autoLayout(d, size);
    expect(Object.keys(p).sort()).toEqual(d.stages.map((s) => s.id).sort());
    const boxes = d.stages.map((s) => ({ id: s.id, ...p[s.id]!, ...size(s) }));
    for (const a of boxes) for (const b of boxes) {
      if (a.id >= b.id) continue;
      expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `${a.id} overlaps ${b.id}`).toBe(false);
    }
    expect(p[d.start]!.y).toBe(Math.min(...Object.values(p).map((v) => v.y)));
  });

  it("places stages the start cannot reach below the rest", () => {
    const p = autoLayout(build(["a", "b", "lost"], [["a", "next", "b"]]), size);
    expect(p.lost!.y).toBeGreaterThan(p.b!.y);
  });

  it("copes with cycles, self loops, a missing start and duplicate ids", () => {
    const cycle = build(["a", "b"], [["a", "next", "b"], ["b", "next", "a"]]);
    expect(autoLayout(cycle, size).b!.y).toBeGreaterThan(autoLayout(cycle, size).a!.y);
    const self = build(["a"], [["a", "next", "a"]]);
    expect(Object.keys(autoLayout(self, size))).toEqual(["a"]);
    const noStart = { ...build(["a", "b"], [["a", "next", "b"]]), start: "" };
    expect(autoLayout(noStart, size).a!.y).toBeLessThan(autoLayout(noStart, size).b!.y);
    const dup = build(["a", "b"], []);
    dup.stages.push({ ...(dup.stages[0] as (typeof dup.stages)[number]) });
    expect(Object.keys(autoLayout(dup, size)).sort()).toEqual(["a", "b"]);
  });

  it("is deterministic and honours the origin", () => {
    const d = pilot();
    expect(autoLayout(d, size)).toEqual(autoLayout(structuredClone(d), size));
    const moved = autoLayout(d, size, { originX: 500, originY: 700 });
    const base = autoLayout(d, size);
    for (const id of Object.keys(base)) {
      expect(moved[id]!.x - base[id]!.x).toBe(460);
      expect(moved[id]!.y - base[id]!.y).toBe(660);
    }
  });

  it("never overlaps boxes or produces a bad coordinate, whatever the graph", () => {
    let seed = 987654;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const types: StageType[] = ["agent", "parallel", "human_gate", "condition", "end"];
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rand() * 10);
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      const kinds = Object.fromEntries(ids.map((id) => [id, types[Math.floor(rand() * types.length)] as StageType]));
      let d = build(ids, [], kinds);
      for (const id of ids) {
        for (const h of ["next", "approve", "reject", "then", "else"] as const) {
          if (rand() < 0.4) d = connect(d, id, h, ids[Math.floor(rand() * n)] as string);
        }
      }
      d = setStart(d, ids[Math.floor(rand() * n)] as string);
      const p = autoLayout(d, size);
      expect(Object.keys(p)).toHaveLength(n);
      const boxes = d.stages.map((s) => ({ id: s.id, ...p[s.id]!, ...size(s) }));
      for (const b of boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
      for (const a of boxes) for (const b of boxes) {
        if (a.id >= b.id) continue;
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `round ${round}: ${a.id}/${b.id}`).toBe(false);
      }
    }
  });
});

describe("readLayout", () => {
  it("keeps finite positions and drops everything else", () => {
    expect(readLayout({ a: { x: 1, y: 2 }, b: { x: "1", y: 2 }, c: null, d: { x: 1 }, e: { x: Infinity, y: 0 }, f: 5 })).toEqual({ a: { x: 1, y: 2 } });
    for (const junk of [null, undefined, 5, "x", [], [{ x: 1, y: 2 }]]) expect(readLayout(junk)).toEqual({});
  });
});

describe("resolvePositions", () => {
  it("uses the saved positions when every stage has one", () => {
    const d = pilot();
    const saved = Object.fromEntries(d.stages.map((s, i) => [s.id, { x: i * 10, y: i * 20 }]));
    expect(resolvePositions(d, { ...saved, ghost: { x: 1, y: 1 } }, size)).toEqual(saved);
  });

  it("lays everything out afresh when any stage lacks a saved position", () => {
    const d = pilot();
    const partial = { [d.stages[0]!.id]: { x: 5, y: 5 } };
    expect(resolvePositions(d, partial, size)).toEqual(autoLayout(d, size));
    expect(resolvePositions(d, undefined, size)).toEqual(autoLayout(d, size));
  });
});
