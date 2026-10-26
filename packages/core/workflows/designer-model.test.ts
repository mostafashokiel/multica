import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_BRANCHES, parseDefinitionText, type WorkflowDefinition } from "./definition";
import {
  addApproverGroup,
  addBranch,
  addStage,
  connect,
  disconnect,
  emptyDefinition,
  handleTarget,
  parseMembers,
  removeApproverGroup,
  removeBranch,
  removeStage,
  renameApproverGroup,
  renamePositions,
  renameStage,
  setApproverGroup,
  setStart,
  stageById,
  uniqueStageId,
  updateBranch,
  updateMetadata,
  updateStage,
} from "./designer-model";

const pilotText = readFileSync(
  new URL("../../../server/internal/workflow/testdata/pilot.canonical.yaml", import.meta.url),
  "utf8",
);
function pilot(): WorkflowDefinition {
  const result = parseDefinitionText(pilotText);
  if (!result.ok) throw new Error("pilot");
  return result.definition;
}
const handles = ["next", "approve", "reject", "then", "else"] as const;

describe("addStage", () => {
  it("adds blank stages with unique ids and makes the first one the start", () => {
    let d = emptyDefinition();
    const a = addStage(d, "agent");
    d = a.definition;
    const b = addStage(d, "agent");
    d = b.definition;
    const g = addStage(d, "human_gate");
    d = g.definition;
    expect([a.id, b.id, g.id]).toEqual(["agent-1", "agent-2", "gate-1"]);
    expect(d.start).toBe("agent-1");
    expect(stageById(d, "agent-2")).toEqual({ id: "agent-2", type: "agent", agent: "", next: "" });
  });

  it("fills gaps in the numbering and never reuses a taken id", () => {
    let d = addStage(emptyDefinition(), "end").definition;
    d = addStage(d, "end").definition;
    d = removeStage(d, "end-1");
    expect(uniqueStageId(d, "end")).toBe("end-1");
  });

  it("does not mutate its input", () => {
    const d = emptyDefinition();
    const before = structuredClone(d);
    addStage(d, "agent");
    expect(d).toEqual(before);
  });
});

describe("connect / disconnect", () => {
  const base = () => {
    let d = emptyDefinition();
    for (const type of ["agent", "human_gate", "condition", "end"] as const) d = addStage(d, type).definition;
    return d;
  };

  it("wires each kind of output", () => {
    let d = base();
    d = connect(d, "agent-1", "next", "gate-1");
    d = connect(d, "gate-1", "approve", "condition-1");
    d = connect(d, "gate-1", "reject", "agent-1");
    d = connect(d, "condition-1", "then", "end-1");
    d = connect(d, "condition-1", "else", "agent-1");
    expect(d.stages.map((s) => [s.id, ...handles.map((h) => handleTarget(s, h))])).toEqual([
      ["agent-1", "gate-1", "", "", "", ""],
      ["gate-1", "", "condition-1", "agent-1", "", ""],
      ["condition-1", "", "", "", "end-1", "agent-1"],
      ["end-1", "", "", "", "", ""],
    ]);
  });

  it("replaces the old target when an output is wired again", () => {
    let d = connect(base(), "agent-1", "next", "gate-1");
    d = connect(d, "agent-1", "next", "end-1");
    expect(handleTarget(stageById(d, "agent-1")!, "next")).toBe("end-1");
  });

  it("ignores outputs a stage does not have and targets that do not exist", () => {
    const d = base();
    expect(connect(d, "agent-1", "approve", "gate-1")).toEqual(d);
    expect(connect(d, "agent-1", "next", "nowhere")).toEqual(d);
    expect(connect(d, "end-1", "next", "gate-1")).toEqual(d);
  });

  it("disconnect clears an output", () => {
    const d = disconnect(connect(base(), "agent-1", "next", "gate-1"), "agent-1", "next");
    expect(handleTarget(stageById(d, "agent-1")!, "next")).toBe("");
  });
});

describe("removeStage", () => {
  it("clears every reference to the stage and the start", () => {
    const d = removeStage(pilot(), "br-review");
    expect(d.start).toBe("");
    expect(stageById(d, "br-review")).toBeUndefined();
    const gate = stageById(d, "br-approval");
    expect(gate && handleTarget(gate, "reject")).toBe("");
    expect(JSON.stringify(d)).not.toContain('"br-review"');
  });
});

describe("renameStage", () => {
  it("updates the stage, the start and all references", () => {
    const result = renameStage(pilot(), "br-review", "business-review");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.start).toBe("business-review");
    expect(JSON.stringify(result.definition)).not.toContain('"br-review"');
    const gate = stageById(result.definition, "br-approval");
    expect(gate && handleTarget(gate, "reject")).toBe("business-review");
  });

  it("refuses an empty or taken id, saying why, and changes nothing", () => {
    const d = pilot();
    expect(renameStage(d, "stories", "")).toEqual({ ok: false, reason: "empty" });
    expect(renameStage(d, "stories", "done")).toEqual({ ok: false, reason: "taken", name: "done" });
    expect(renameStage(d, "stories", "stories")).toEqual({ ok: true, definition: d });
  });

  it("moves the layout position with it", () => {
    expect(renamePositions({ a: { x: 1, y: 2 } }, "a", "b")).toEqual({ b: { x: 1, y: 2 } });
    expect(renamePositions({ a: { x: 1, y: 2 } }, "zzz", "b")).toEqual({ a: { x: 1, y: 2 } });
  });
});

describe("updateStage", () => {
  it("sets and clears optional fields (empty text means not set)", () => {
    let d = addStage(emptyDefinition(), "agent").definition;
    d = updateStage(d, "agent-1", { name: "Review", agent: "reviewer", skills: ["a", "b"], expected_output: "A report" });
    expect(stageById(d, "agent-1")).toEqual({
      id: "agent-1", type: "agent", name: "Review", agent: "reviewer", skills: ["a", "b"], expected_output: "A report", next: "",
    });
    d = updateStage(d, "agent-1", { name: "", skills: [], expected_output: "" });
    expect(stageById(d, "agent-1")).toEqual({ id: "agent-1", type: "agent", agent: "reviewer", next: "" });
    expect("name" in stageById(d, "agent-1")!).toBe(false);
  });

  it("edits gates and conditions, and ignores fields of another type", () => {
    let d = addStage(addStage(emptyDefinition(), "human_gate").definition, "condition").definition;
    d = updateStage(d, "gate-1", { approvers: "qa", max_rework: 3, escalate_after_hours: 24, agent: "ignored", when: "ignored" });
    d = updateStage(d, "condition-1", { when: 'has_label("x")', approvers: "ignored" });
    expect(stageById(d, "gate-1")).toEqual({
      id: "gate-1", type: "human_gate", approvers: "qa", on_approve: "", on_reject: "", max_rework: 3, escalate_after_hours: 24,
    });
    expect(stageById(d, "condition-1")).toMatchObject({ when: 'has_label("x")' });
    d = updateStage(d, "gate-1", { max_rework: undefined });
    expect("max_rework" in stageById(d, "gate-1")!).toBe(false);
  });
});

describe("metadata and approver groups", () => {
  it("edits metadata and the squad; empty values are removed rather than stored", () => {
    let d = updateMetadata(emptyDefinition(), { id: "x", owner: "me", description: "d", squadName: "S", squadLeader: "L" });
    expect(d.metadata).toEqual({ id: "x", version: 1, owner: "me", description: "d" });
    expect(d.target?.squad).toEqual({ name: "S", leader: "L" });
    d = updateMetadata(d, { description: "", owner: "" });
    expect("description" in d.metadata).toBe(false);
    expect("owner" in d.metadata).toBe(false);
    d = updateMetadata(d, { squadName: "", squadLeader: "" });
    expect("target" in d).toBe(false);
  });

  it("keeps the other half of the squad when one half changes", () => {
    const d = updateMetadata(updateMetadata(emptyDefinition(), { squadName: "S" }), { squadLeader: "L" });
    expect(d.target?.squad).toEqual({ name: "S", leader: "L" });
  });

  it("adds, edits, renames (updating gates) and removes groups", () => {
    let d = addStage(emptyDefinition(), "human_gate").definition;
    d = setApproverGroup(d, "qa", ["user:1"]);
    d = updateStage(d, "gate-1", { approvers: "qa" });
    const renamed = renameApproverGroup(d, "qa", "quality");
    expect(renamed.ok && renamed.definition.approvers).toEqual({ quality: ["user:1"] });
    expect(renamed.ok && stageById(renamed.definition, "gate-1")).toMatchObject({ approvers: "quality" });
    expect(renameApproverGroup(d, "qa", "")).toEqual({ ok: false, reason: "empty" });
    expect(renameApproverGroup(d, "qa", "__proto__")).toMatchObject({ ok: false, reason: "reserved" });
    expect(renameApproverGroup(setApproverGroup(d, "other", []), "qa", "other")).toMatchObject({ ok: false, reason: "taken" });
    expect(removeApproverGroup(d, "qa").approvers).toEqual({});
  });

  it("addApproverGroup refuses empty, reserved and used names", () => {
    const d = setApproverGroup(emptyDefinition(), "qa", []);
    expect(addApproverGroup(d, "")).toEqual({ ok: false, reason: "empty" });
    expect(addApproverGroup(d, "__proto__")).toMatchObject({ ok: false, reason: "reserved" });
    expect(addApproverGroup(d, "qa")).toMatchObject({ ok: false, reason: "taken" });
    const added = addApproverGroup(d, "po");
    expect(added.ok && added.definition.approvers).toEqual({ qa: [], po: [] });
    // A name that is a built-in object property is still just a name.
    const ok = addApproverGroup(emptyDefinition(), "constructor");
    expect(ok.ok && Object.hasOwn(ok.definition.approvers, "constructor")).toBe(true);
  });

  it("parses member text", () => {
    expect(parseMembers("user:1\n user:2 ,user:1,, \n")).toEqual(["user:1", "user:2"]);
    expect(parseMembers("")).toEqual([]);
  });
});

describe("building the pilot by hand gives the pilot", () => {
  it("the edits a person would make end equal to the definition the server stores", () => {
    let d = emptyDefinition();
    d = updateMetadata(d, {
      id: "sdlc-pilot", owner: "eng-director", description: "Phase 1 pilot", squadName: "Delivery - Pilot", squadLeader: "sdlc-orchestrator",
    });
    const add = (type: Parameters<typeof addStage>[1], finalId: string) => {
      const added = addStage(d, type);
      const renamed = renameStage(added.definition, added.id, finalId);
      if (!renamed.ok) throw new Error(renamed.reason);
      d = renamed.definition;
    };
    add("agent", "br-review");
    add("human_gate", "br-approval");
    add("agent", "stories");
    add("human_gate", "po-approval");
    add("agent", "architecture");
    add("condition", "pci-check");
    add("human_gate", "arch-approval");
    add("end", "done");
    for (const group of ["product", "po", "architects"]) d = setApproverGroup(d, group, ["user:<multica-user-id>"]);
    d = updateStage(d, "br-review", { name: "BR review", agent: "br-review-agent", skills: ["br-checklist"] });
    d = updateStage(d, "br-approval", { name: "BR approval", approvers: "product", max_rework: 3, escalate_after_hours: 24 });
    d = updateStage(d, "stories", { agent: "story-writer-agent" });
    d = updateStage(d, "po-approval", { approvers: "po", max_rework: 3 });
    d = updateStage(d, "architecture", { agent: "architect-agent" });
    d = updateStage(d, "pci-check", { when: 'has_label("pci-scope")' });
    d = updateStage(d, "arch-approval", { approvers: "architects", max_rework: 3 });
    for (const [from, handle, to] of [
      ["br-review", "next", "br-approval"], ["br-approval", "approve", "stories"], ["br-approval", "reject", "br-review"],
      ["stories", "next", "po-approval"], ["po-approval", "approve", "architecture"], ["po-approval", "reject", "stories"],
      ["architecture", "next", "pci-check"], ["pci-check", "then", "arch-approval"], ["pci-check", "else", "arch-approval"],
      ["arch-approval", "approve", "done"], ["arch-approval", "reject", "architecture"],
    ] as const) {
      d = connect(d, from, handle, to);
    }
    expect(d.start).toBe("br-review");
    expect(d).toEqual(pilot());
    expect(setStart(d, "nope")).toBe(d);
  });
});

describe("parallel stages", () => {
  const withParallel = () => addStage(addStage(emptyDefinition(), "parallel").definition, "end").definition;
  const branchesOf = (d: WorkflowDefinition) => {
    const stage = stageById(d, "parallel-1");
    if (stage?.type !== "parallel") throw new Error("not parallel");
    return stage.branches;
  };

  it("starts with two empty branches, the least a parallel stage can have", () => {
    const d = withParallel();
    expect(d.stages[0]).toEqual({ id: "parallel-1", type: "parallel", branches: [{ agent: "" }, { agent: "" }], next: "" });
    expect(d.start).toBe("parallel-1");
  });

  it("has one output, wired like an agent's", () => {
    let d = connect(withParallel(), "parallel-1", "next", "end-1");
    expect(handleTarget(stageById(d, "parallel-1")!, "next")).toBe("end-1");
    d = removeStage(d, "end-1");
    expect(handleTarget(stageById(d, "parallel-1")!, "next")).toBe("");
    const renamed = renameStage(connect(withParallel(), "parallel-1", "next", "end-1"), "end-1", "finish");
    expect(renamed.ok && handleTarget(stageById(renamed.definition, "parallel-1")!, "next")).toBe("finish");
  });

  it("adds, edits and removes branches by position without touching the input", () => {
    const before = withParallel();
    let d = updateBranch(before, "parallel-1", 0, { agent: "nyc", name: "New York", skills: ["clock"], expected_output: "the time" });
    d = updateBranch(d, "parallel-1", 1, { agent: "cairo" });
    d = addBranch(d, "parallel-1");
    expect(branchesOf(d)).toEqual([
      { agent: "nyc", name: "New York", skills: ["clock"], expected_output: "the time" },
      { agent: "cairo" },
      { agent: "" },
    ]);
    expect(branchesOf(before)).toEqual([{ agent: "" }, { agent: "" }]);
    d = removeBranch(d, "parallel-1", 0);
    expect(branchesOf(d).map((b) => b.agent)).toEqual(["cairo", ""]);
  });

  it("empty text clears an optional branch field instead of storing it", () => {
    let d = updateBranch(withParallel(), "parallel-1", 0, { agent: "a", name: "N", skills: ["s"], expected_output: "o" });
    d = updateBranch(d, "parallel-1", 0, { name: "", skills: [], expected_output: "" });
    expect(branchesOf(d)[0]).toEqual({ agent: "a" });
    expect(Object.keys(branchesOf(d)[0]!)).toEqual(["agent"]);
  });

  it("stops adding at the limit, and ignores stages of another type", () => {
    let d = withParallel();
    for (let i = 0; i < MAX_BRANCHES + 3; i++) d = addBranch(d, "parallel-1");
    expect(branchesOf(d)).toHaveLength(MAX_BRANCHES);
    expect(addBranch(d, "end-1")).toEqual(d);
    expect(updateBranch(d, "end-1", 0, { agent: "x" })).toEqual(d);
  });

  it("renames the stage through updateStage like any other", () => {
    const d = updateStage(withParallel(), "parallel-1", { name: "Checks" });
    expect(stageById(d, "parallel-1")).toMatchObject({ name: "Checks", branches: [{ agent: "" }, { agent: "" }] });
  });
});
