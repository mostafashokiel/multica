import type { Branch, Stage, StageType, WorkflowDefinition } from "./definition";
import { MAX_BRANCHES, WORKFLOW_API_VERSION, WORKFLOW_KIND } from "./definition";

/**
 * Editing of a workflow definition for the designer. Every function returns a new
 * definition and none mutates its input, so history can keep snapshots by reference.
 */

/** An output of a stage that can be wired to another stage. */
export type Handle = "next" | "approve" | "reject" | "then" | "else";

export const STAGE_HANDLES: Record<StageType, readonly Handle[]> = {
  agent: ["next"],
  parallel: ["next"],
  human_gate: ["approve", "reject"],
  condition: ["then", "else"],
  end: [],
};

export const STAGE_TYPES: readonly StageType[] = ["agent", "parallel", "human_gate", "condition", "end"];

const ID_PREFIX: Record<StageType, string> = {
  agent: "agent",
  parallel: "parallel",
  human_gate: "gate",
  condition: "condition",
  end: "end",
};

/** Node positions by stage id, as the server stores them in a version's layout. */
export type Positions = Record<string, { x: number; y: number }>;

export function emptyDefinition(): WorkflowDefinition {
  return {
    apiVersion: WORKFLOW_API_VERSION,
    kind: WORKFLOW_KIND,
    metadata: { id: "", version: 1 },
    approvers: {},
    start: "",
    stages: [],
  };
}

export function stageById(def: WorkflowDefinition, id: string): Stage | undefined {
  return def.stages.find((stage) => stage.id === id);
}

/** Where a handle currently points ("" when unconnected). */
export function handleTarget(stage: Stage, handle: Handle): string {
  switch (stage.type) {
    case "agent":
    case "parallel":
      return handle === "next" ? stage.next : "";
    case "human_gate":
      return handle === "approve" ? stage.on_approve : handle === "reject" ? stage.on_reject : "";
    case "condition":
      return handle === "then" ? stage.then : handle === "else" ? stage.else : "";
    case "end":
      return "";
  }
}

function withHandleTarget(stage: Stage, handle: Handle, target: string): Stage {
  switch (stage.type) {
    case "agent":
    case "parallel":
      return handle === "next" ? { ...stage, next: target } : stage;
    case "human_gate":
      if (handle === "approve") return { ...stage, on_approve: target };
      if (handle === "reject") return { ...stage, on_reject: target };
      return stage;
    case "condition":
      if (handle === "then") return { ...stage, then: target };
      if (handle === "else") return { ...stage, else: target };
      return stage;
    case "end":
      return stage;
  }
}

function mapStages(def: WorkflowDefinition, fn: (stage: Stage) => Stage): WorkflowDefinition {
  return { ...def, stages: def.stages.map(fn) };
}

/** Every reference to `from`, in any stage and in `start`, rewritten to `to` ("" clears it). */
function retarget(def: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  const stages = def.stages.map((stage) => {
    let next = stage;
    for (const handle of STAGE_HANDLES[stage.type]) {
      if (handleTarget(next, handle) === from) next = withHandleTarget(next, handle, to);
    }
    return next;
  });
  return { ...def, stages, start: def.start === from ? to : def.start };
}

export function uniqueStageId(def: WorkflowDefinition, type: StageType): string {
  const taken = new Set(def.stages.map((s) => s.id));
  for (let n = 1; ; n++) {
    const id = `${ID_PREFIX[type]}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

function blankStage(type: StageType, id: string): Stage {
  switch (type) {
    case "agent":
      return { id, type, agent: "", next: "" };
    case "parallel":
      // Two empty branches: fewer is not a parallel stage, and the server asks for at least two.
      return { id, type, branches: [{ agent: "" }, { agent: "" }], next: "" };
    case "human_gate":
      return { id, type, approvers: "", on_approve: "", on_reject: "" };
    case "condition":
      return { id, type, when: "", then: "", else: "" };
    case "end":
      return { id, type };
  }
}

/** Add a stage of `type`. The first stage added becomes the start stage. */
export function addStage(def: WorkflowDefinition, type: StageType): { definition: WorkflowDefinition; id: string } {
  const id = uniqueStageId(def, type);
  const stages = [...def.stages, blankStage(type, id)];
  const start = def.stages.length === 0 || def.start === "" ? id : def.start;
  return { definition: { ...def, stages, start }, id };
}

/** Remove a stage and clear every reference to it (those outputs become unconnected). */
export function removeStage(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const cleared = retarget(def, id, "");
  return { ...cleared, stages: cleared.stages.filter((stage) => stage.id !== id) };
}

/** Why an edit was refused; the UI turns it into words in the user's language. */
export type EditRefusal =
  | { reason: "empty" }
  | { reason: "taken"; name: string }
  | { reason: "reserved"; name: string };

export type EditResult = { ok: true; definition: WorkflowDefinition } | ({ ok: false } & EditRefusal);

/** Change a stage id and every reference to it. Refuses an empty or already used id. */
export function renameStage(def: WorkflowDefinition, from: string, to: string): EditResult {
  if (from === to) return { ok: true, definition: def };
  if (to === "") return { ok: false, reason: "empty" };
  if (def.stages.some((stage) => stage.id === to)) return { ok: false, reason: "taken", name: to };
  const retargeted = retarget(def, from, to);
  return {
    ok: true,
    definition: mapStages(retargeted, (stage) => (stage.id === from ? { ...stage, id: to } : stage)),
  };
}

export function renamePositions(positions: Positions, from: string, to: string): Positions {
  const point = positions[from];
  if (point === undefined || from === to) return positions;
  const { [from]: _removed, ...rest } = positions;
  return { ...rest, [to]: point };
}

/** Wire an output to a stage. An output has one target: wiring it again replaces the old one. */
export function connect(def: WorkflowDefinition, sourceId: string, handle: Handle, targetId: string): WorkflowDefinition {
  if (!def.stages.some((s) => s.id === targetId)) return def;
  return mapStages(def, (stage) =>
    stage.id === sourceId && STAGE_HANDLES[stage.type].includes(handle) ? withHandleTarget(stage, handle, targetId) : stage,
  );
}

export function disconnect(def: WorkflowDefinition, sourceId: string, handle: Handle): WorkflowDefinition {
  return mapStages(def, (stage) => (stage.id === sourceId ? withHandleTarget(stage, handle, "") : stage));
}

export function setStart(def: WorkflowDefinition, id: string): WorkflowDefinition {
  return def.stages.some((s) => s.id === id) ? { ...def, start: id } : def;
}

/** Fields of a stage the properties panel edits. Empty text clears an optional field. */
export interface StageEdit {
  name?: string;
  agent?: string;
  skills?: string[] | undefined;
  expected_output?: string;
  approvers?: string;
  max_rework?: number | undefined;
  escalate_after_hours?: number | undefined;
  when?: string;
}

function optionalText(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function updateStage(def: WorkflowDefinition, id: string, edit: StageEdit): WorkflowDefinition {
  return mapStages(def, (stage) => {
    if (stage.id !== id) return stage;
    const common = "name" in edit ? { name: optionalText(edit.name ?? "") } : {};
    switch (stage.type) {
      case "agent":
        return omitUndefined({
          ...stage,
          ...common,
          ...(edit.agent === undefined ? {} : { agent: edit.agent }),
          ...("skills" in edit ? { skills: edit.skills === undefined || edit.skills.length === 0 ? undefined : edit.skills } : {}),
          ...("expected_output" in edit ? { expected_output: optionalText(edit.expected_output ?? "") } : {}),
        });
      case "parallel":
        return omitUndefined({ ...stage, ...common });
      case "human_gate":
        return omitUndefined({
          ...stage,
          ...common,
          ...(edit.approvers === undefined ? {} : { approvers: edit.approvers }),
          ...("max_rework" in edit ? { max_rework: edit.max_rework } : {}),
          ...("escalate_after_hours" in edit ? { escalate_after_hours: edit.escalate_after_hours } : {}),
        });
      case "condition":
        return omitUndefined({ ...stage, ...common, ...(edit.when === undefined ? {} : { when: edit.when }) });
      case "end":
        return omitUndefined({ ...stage, ...common });
    }
  });
}

/** Fields of one branch of a parallel stage. Empty text clears an optional field. */
export interface BranchEdit {
  name?: string;
  agent?: string;
  skills?: string[] | undefined;
  expected_output?: string;
}

function withBranches(def: WorkflowDefinition, id: string, fn: (branches: Branch[]) => Branch[]): WorkflowDefinition {
  return mapStages(def, (stage) => (stage.id === id && stage.type === "parallel" ? { ...stage, branches: fn(stage.branches) } : stage));
}

/** Add an empty branch at the end. Refused (nothing changes) at the limit. */
export function addBranch(def: WorkflowDefinition, id: string): WorkflowDefinition {
  return withBranches(def, id, (branches) => (branches.length >= MAX_BRANCHES ? branches : [...branches, { agent: "" }]));
}

export function removeBranch(def: WorkflowDefinition, id: string, index: number): WorkflowDefinition {
  return withBranches(def, id, (branches) => branches.filter((_, i) => i !== index));
}

export function updateBranch(def: WorkflowDefinition, id: string, index: number, edit: BranchEdit): WorkflowDefinition {
  return withBranches(def, id, (branches) =>
    branches.map((branch, i) => {
      if (i !== index) return branch;
      return omitUndefined({
        ...branch,
        ...("name" in edit ? { name: optionalText(edit.name ?? "") } : {}),
        ...(edit.agent === undefined ? {} : { agent: edit.agent }),
        ...("skills" in edit ? { skills: edit.skills === undefined || edit.skills.length === 0 ? undefined : edit.skills } : {}),
        ...("expected_output" in edit ? { expected_output: optionalText(edit.expected_output ?? "") } : {}),
      });
    }),
  );
}

export interface MetadataEdit {
  id?: string;
  owner?: string;
  description?: string;
  squadName?: string;
  squadLeader?: string;
}

/** Empty owner, description and squad fields are removed rather than stored as "". */
export function updateMetadata(def: WorkflowDefinition, edit: MetadataEdit): WorkflowDefinition {
  const metadata = { ...def.metadata };
  if (edit.id !== undefined) metadata.id = edit.id;
  if (edit.owner !== undefined) {
    const owner = optionalText(edit.owner);
    if (owner === undefined) delete metadata.owner;
    else metadata.owner = owner;
  }
  if (edit.description !== undefined) {
    const description = optionalText(edit.description);
    if (description === undefined) delete metadata.description;
    else metadata.description = description;
  }
  const next: WorkflowDefinition = { ...def, metadata };
  if (edit.squadName !== undefined || edit.squadLeader !== undefined) {
    const name = edit.squadName ?? def.target?.squad.name ?? "";
    const leader = edit.squadLeader ?? def.target?.squad.leader ?? "";
    if (name === "" && leader === "") delete next.target;
    else next.target = { squad: { name, leader } };
  }
  return next;
}

export function setApproverGroup(def: WorkflowDefinition, name: string, members: string[]): WorkflowDefinition {
  return { ...def, approvers: { ...def.approvers, [name]: members } };
}

export function removeApproverGroup(def: WorkflowDefinition, name: string): WorkflowDefinition {
  const { [name]: _removed, ...rest } = def.approvers;
  return { ...def, approvers: rest };
}

/** Rename a group and every gate that uses it. Refuses an empty, reserved or used name. */
export function renameApproverGroup(def: WorkflowDefinition, from: string, to: string): EditResult {
  if (from === to) return { ok: true, definition: def };
  if (to === "") return { ok: false, reason: "empty" };
  if (to === "__proto__") return { ok: false, reason: "reserved", name: to };
  if (Object.hasOwn(def.approvers, to)) return { ok: false, reason: "taken", name: to };
  const approvers: WorkflowDefinition["approvers"] = {};
  for (const [name, members] of Object.entries(def.approvers)) approvers[name === from ? to : name] = members;
  return {
    ok: true,
    definition: mapStages({ ...def, approvers }, (stage) =>
      stage.type === "human_gate" && stage.approvers === from ? { ...stage, approvers: to } : stage,
    ),
  };
}

/** Add an empty approver group. Refuses an empty, reserved or used name. */
export function addApproverGroup(def: WorkflowDefinition, name: string): EditResult {
  if (name === "") return { ok: false, reason: "empty" };
  if (name === "__proto__") return { ok: false, reason: "reserved", name };
  if (Object.hasOwn(def.approvers, name)) return { ok: false, reason: "taken", name };
  return { ok: true, definition: setApproverGroup(def, name, []) };
}

/** One member per line or comma separated; blanks dropped; duplicates removed. */
export function parseMembers(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((m) => m.trim()).filter((m) => m !== ""))];
}
