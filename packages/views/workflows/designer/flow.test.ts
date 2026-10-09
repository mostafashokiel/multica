import { describe, expect, it } from "vitest";
import { addStage, connect, emptyDefinition, renameStage, updateMetadata, type WorkflowDefinition } from "@multica/core/workflows";
import { toFlowEdges } from "./flow";

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
