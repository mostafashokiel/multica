import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * The workflow definition as the designer edits it: the structure of the YAML the
 * server stores. The server is the authority on what is valid (it parses strictly and
 * validates); this module only reads the canonical text the server hands out into a
 * shape the editor can change, and writes it back as YAML for the server to
 * canonicalise. Nothing here decides validity.
 */

export const WORKFLOW_API_VERSION = "composer.noqodi/v1";
export const WORKFLOW_KIND = "Workflow";
/** The server refuses larger definitions; the editor refuses to read them. */
export const MAX_WORKFLOW_SOURCE_BYTES = 1 << 20;

export type StageType = "agent" | "parallel" | "human_gate" | "condition" | "end";

/** The most branches a parallel stage may have; the server refuses more. */
export const MAX_BRANCHES = 8;

interface StageBase {
  id: string;
  name?: string;
}
export interface AgentStage extends StageBase {
  type: "agent";
  agent: string;
  skills?: string[];
  expected_output?: string;
  next: string;
}
/** One piece of work a parallel stage hands to an agent. All branches run at the same time. */
export interface Branch {
  /** Optional; the sub-issue's title uses it, else the agent's name. */
  name?: string;
  agent: string;
  skills?: string[];
  expected_output?: string;
}
export interface ParallelStage extends StageBase {
  type: "parallel";
  branches: Branch[];
  next: string;
}
export interface HumanGateStage extends StageBase {
  type: "human_gate";
  approvers: string;
  on_approve: string;
  on_reject: string;
  max_rework?: number;
  escalate_after_hours?: number;
}
export interface ConditionStage extends StageBase {
  type: "condition";
  when: string;
  then: string;
  else: string;
}
export interface EndStage extends StageBase {
  type: "end";
}
export type Stage = AgentStage | ParallelStage | HumanGateStage | ConditionStage | EndStage;

export interface WorkflowDefinition {
  apiVersion: string;
  kind: string;
  metadata: { id: string; version: number; owner?: string; description?: string };
  /** Which squad the workflow was written for; informational. Absent when unset. */
  target?: { squad: { name: string; leader: string } };
  approvers: Record<string, string[]>;
  start: string;
  stages: Stage[];
}

// A reference may be empty while a workflow is being drawn, so every reference defaults
// to "" rather than failing; the server's validation is what reports it.
const ref = z.string().default("");
const stageBase = { id: z.string(), name: z.string().optional() };
const StageSchema = z.discriminatedUnion("type", [
  z.object({
    ...stageBase,
    type: z.literal("agent"),
    agent: ref,
    skills: z.array(z.string()).optional(),
    expected_output: z.string().optional(),
    next: ref,
  }),
  z.object({
    ...stageBase,
    type: z.literal("parallel"),
    branches: z
      .array(
        z.object({
          name: z.string().optional(),
          agent: ref,
          skills: z.array(z.string()).optional(),
          expected_output: z.string().optional(),
        }),
      )
      .default([]),
    next: ref,
  }),
  z.object({
    ...stageBase,
    type: z.literal("human_gate"),
    approvers: ref,
    on_approve: ref,
    on_reject: ref,
    max_rework: z.number().int().positive().optional(),
    escalate_after_hours: z.number().int().positive().optional(),
  }),
  z.object({ ...stageBase, type: z.literal("condition"), when: ref, then: ref, else: ref }),
  z.object({ ...stageBase, type: z.literal("end") }),
]);

const DefinitionSchema = z.object({
  apiVersion: z.string().default(WORKFLOW_API_VERSION),
  kind: z.string().default(WORKFLOW_KIND),
  metadata: z.object({
    id: z.string(),
    version: z.number().int().default(1),
    owner: z.string().optional(),
    description: z.string().optional(),
  }),
  target: z.object({ squad: z.object({ name: z.string().default(""), leader: z.string().default("") }) }).optional(),
  approvers: z.record(z.string(), z.array(z.string())).default({}),
  start: ref,
  stages: z.array(StageSchema).default([]),
});

export interface DefinitionIssue {
  message: string;
  /** Where in the definition, when known (for example `stages.2.type`). */
  path?: string;
  line?: number;
}

export type ParsedDefinition =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; issues: DefinitionIssue[] };

/**
 * Read definition text into the editor's shape. Meant for text the server produced, but
 * written defensively: oversized text, aliases, a second document and a group named
 * `__proto__` are refused rather than interpreted.
 */
export function parseDefinitionText(text: string): ParsedDefinition {
  if (new TextEncoder().encode(text).length > MAX_WORKFLOW_SOURCE_BYTES) {
    return { ok: false, issues: [{ message: `The definition is larger than ${MAX_WORKFLOW_SOURCE_BYTES} bytes` }] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    const line = typeof error === "object" && error !== null && "linePos" in error
      ? (error as { linePos?: [{ line: number }] }).linePos?.[0]?.line
      : undefined;
    const message = error instanceof Error ? error.message.split("\n")[0] ?? "Invalid YAML" : "Invalid YAML";
    return { ok: false, issues: [{ message, ...(line === undefined ? {} : { line }) }] };
  }
  // Checked on the raw value: the schema would drop the key without a word, and the group
  // would silently vanish from the editor.
  const rawApprovers = typeof raw === "object" && raw !== null ? (raw as { approvers?: unknown }).approvers : undefined;
  if (typeof rawApprovers === "object" && rawApprovers !== null && Object.hasOwn(rawApprovers, "__proto__")) {
    return { ok: false, issues: [{ message: 'An approver group cannot be named "__proto__"', path: "approvers" }] };
  }
  const result = DefinitionSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({ message: i.message, path: i.path.join(".") })),
    };
  }
  // fromEntries defines own properties, so a hostile key cannot reach a prototype.
  const approvers = Object.fromEntries(Object.entries(result.data.approvers));
  return { ok: true, definition: { ...result.data, approvers } as WorkflowDefinition };
}

function orderedBranch(branch: Branch): Record<string, unknown> {
  return {
    ...(branch.name === undefined ? {} : { name: branch.name }),
    agent: branch.agent,
    ...(branch.skills === undefined || branch.skills.length === 0 ? {} : { skills: branch.skills }),
    ...(branch.expected_output === undefined ? {} : { expected_output: branch.expected_output }),
  };
}

function orderedStage(stage: Stage): Record<string, unknown> {
  const head = { id: stage.id, type: stage.type, ...(stage.name === undefined ? {} : { name: stage.name }) };
  switch (stage.type) {
    case "agent":
      return {
        ...head,
        agent: stage.agent,
        ...(stage.skills === undefined || stage.skills.length === 0 ? {} : { skills: stage.skills }),
        ...(stage.expected_output === undefined ? {} : { expected_output: stage.expected_output }),
        next: stage.next,
      };
    case "parallel":
      return {
        ...head,
        branches: stage.branches.map(orderedBranch),
        next: stage.next,
      };
    case "human_gate":
      return {
        ...head,
        approvers: stage.approvers,
        on_approve: stage.on_approve,
        on_reject: stage.on_reject,
        ...(stage.max_rework === undefined ? {} : { max_rework: stage.max_rework }),
        ...(stage.escalate_after_hours === undefined ? {} : { escalate_after_hours: stage.escalate_after_hours }),
      };
    case "condition":
      return { ...head, when: stage.when, then: stage.then, else: stage.else };
    case "end":
      return head;
  }
}

/**
 * Write the definition as YAML text for the server, which parses it and stores its own
 * canonical form, so the key order and layout here are a courtesy for whoever reads a
 * request, not a contract. Every value is quoted or escaped by the YAML library; multi-line
 * text is double-quoted rather than block style, which is the least ambiguous.
 */
export function stringifyDefinition(def: WorkflowDefinition): string {
  const doc = {
    apiVersion: def.apiVersion,
    kind: def.kind,
    metadata: {
      id: def.metadata.id,
      version: def.metadata.version,
      ...(def.metadata.owner === undefined ? {} : { owner: def.metadata.owner }),
      ...(def.metadata.description === undefined ? {} : { description: def.metadata.description }),
    },
    ...(def.target === undefined ? {} : { target: { squad: { name: def.target.squad.name, leader: def.target.squad.leader } } }),
    approvers: def.approvers,
    start: def.start,
    stages: def.stages.map(orderedStage),
  };
  return stringifyYaml(doc, { indent: 2, lineWidth: 0, blockQuote: false, version: "1.1" });
}
