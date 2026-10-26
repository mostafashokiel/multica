import { LineCounter, parseDocument, stringify, visit } from "yaml";
import { z } from "zod";
import { isBuiltInIssueStatus } from "../issue-statuses/queries";
import type { IssueStatusEntry } from "../types";
import type { IssueWorkflow, IssueWorkflowHandler, IssueWorkflowStep } from "../types";

/**
 * A workflow as text (MUL-7420), so it can move between workspaces and
 * environments and be reviewed in a pull request.
 *
 * Ids differ in every workspace, so the file names things instead: agents and
 * squads by name, members by email, statuses by key (with a name and category
 * for the ones a workspace may not have yet). Importing never writes anything:
 * it resolves the names against the workspace and hands the result to the
 * editor as a draft, so the usual save, checks and permissions still apply.
 *
 *   version: 1
 *   name: Delivery
 *   description: Build, review, then QA before done
 *   steps:
 *     - status: in_progress
 *       handler: { type: agent, name: Builder }
 *       instructions: Implement the change and open a PR.
 *       next: in_review
 *     - status: qa
 *       name: QA
 *       category: started
 *       handler: { type: member, email: ada@example.com }
 *       back: in_progress
 */

export const WORKFLOW_YAML_VERSION = 1;
/** An import larger than this is refused before it is parsed. */
export const WORKFLOW_YAML_MAX_BYTES = 256 * 1024;
const MAX_STEPS = 50;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 256;
const MAX_INSTRUCTIONS = 8000;

const FIXED_HEAD = ["backlog", "todo"];
const FIXED_TAIL = ["blocked", "done", "cancelled"];
const FIXED = new Set([...FIXED_HEAD, ...FIXED_TAIL]);
const ALWAYS_LISTED = new Set(["todo", "done", "cancelled"]);

const statusKey = z.string().min(1).max(64);

const handlerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent"), name: z.string().min(1) }),
  z.strictObject({ type: z.literal("squad"), name: z.string().min(1) }),
  z.strictObject({ type: z.literal("member"), email: z.string().min(1) }),
  z.strictObject({ type: z.literal("project_lead") }),
  z.strictObject({ type: z.literal("creator") }),
]);

const stepSchema = z.strictObject({
  status: statusKey,
  name: z.string().min(1).max(MAX_NAME).optional(),
  category: z.enum(["unstarted", "started", "done", "closed"]).optional(),
  handler: handlerSchema.optional(),
  instructions: z.string().max(MAX_INSTRUCTIONS).optional(),
  next: statusKey.optional(),
  back: statusKey.optional(),
});

const docSchema = z.strictObject({
  version: z.literal(WORKFLOW_YAML_VERSION),
  name: z.string().min(1).max(MAX_NAME),
  description: z.string().max(MAX_DESCRIPTION).optional(),
  steps: z.array(stepSchema).min(1).max(MAX_STEPS),
});

export type WorkflowYamlDoc = z.infer<typeof docSchema>;
export type WorkflowYamlStep = z.infer<typeof stepSchema>;

/** The workspace data names are resolved against. Archived entries are left out by the caller. */
export interface WorkflowYamlRefs {
  statuses: Pick<IssueStatusEntry, "key" | "name" | "category">[];
  agents: { id: string; name: string }[];
  squads: { id: string; name: string }[];
  members: { user_id: string; email: string }[];
}

// ---------------------------------------------------------------- export

/**
 * Writes a workflow as YAML. The bytes depend only on the workflow and the
 * names it refers to, so the same workflow always produces the same file.
 * `warnings` lists handlers whose agent, squad or member no longer exists:
 * they are written as no handoff rather than as an id nobody can resolve.
 */
export function exportWorkflowYaml(
  workflow: Pick<IssueWorkflow, "name" | "description" | "steps">,
  refs: WorkflowYamlRefs,
): { yaml: string; warnings: string[] } {
  const warnings: string[] = [];
  const statusByKey = new Map(refs.statuses.map((s) => [s.key, s]));

  const handlerOut = (step: IssueWorkflowStep): Record<string, string> | undefined => {
    const h: IssueWorkflowHandler = step.handler;
    switch (h.type) {
      case "agent": {
        const name = refs.agents.find((a) => a.id === h.id)?.name;
        if (name) return { type: "agent", name };
        break;
      }
      case "squad": {
        const name = refs.squads.find((s) => s.id === h.id)?.name;
        if (name) return { type: "squad", name };
        break;
      }
      case "member": {
        const email = refs.members.find((m) => m.user_id === h.id)?.email;
        if (email) return { type: "member", email };
        break;
      }
      case "project_lead":
      case "creator":
        return { type: h.type };
      default:
        return undefined;
    }
    warnings.push(step.status_key);
    return undefined;
  };

  const steps = workflow.steps.map((step) => {
    const out: Record<string, unknown> = { status: step.status_key };
    if (!isBuiltInIssueStatus(step.status_key)) {
      const entry = statusByKey.get(step.status_key);
      if (entry) {
        out.name = entry.name;
        out.category = entry.category;
      }
    }
    const handler = handlerOut(step);
    if (handler) {
      out.handler = handler;
      // Instructions and the next and back statuses only reach an agent's brief, so only an agent step has them.
      if (step.handler.type === "agent") {
        if (step.instructions) out.instructions = step.instructions;
        if (step.next_status_key) out.next = step.next_status_key;
        if (step.back_status_key) out.back = step.back_status_key;
      }
    }
    return out;
  });

  const doc: Record<string, unknown> = { version: WORKFLOW_YAML_VERSION, name: workflow.name };
  if (workflow.description) doc.description = workflow.description;
  doc.steps = steps;
  return { yaml: stringify(doc, { lineWidth: 0, blockQuote: "literal" }), warnings };
}

// ---------------------------------------------------------------- parse

export interface WorkflowYamlProblem {
  /** 1-based line in the text, when the problem has a place in it. */
  line?: number;
  message: string;
}

export type ParseWorkflowYamlResult =
  | { ok: true; doc: WorkflowYamlDoc }
  | { ok: false; problems: WorkflowYamlProblem[] };

/**
 * Reads and checks a workflow file. It reports every problem it finds, with
 * the line, instead of stopping at the first. Unknown keys are errors, so a
 * typo such as `instruction:` is caught instead of silently ignored.
 */
export function parseWorkflowYaml(text: string): ParseWorkflowYamlResult {
  if (new TextEncoder().encode(text).length > WORKFLOW_YAML_MAX_BYTES) {
    return { ok: false, problems: [{ message: `The file is larger than ${WORKFLOW_YAML_MAX_BYTES / 1024} KB.` }] };
  }
  if (text.trim() === "") return { ok: false, problems: [{ message: "The file is empty." }] };

  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (offset: number | undefined) => (offset === undefined ? undefined : lineCounter.linePos(offset).line);

  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((e) => ({ line: lineOf(e.pos[0]), message: e.message.split("\n")[0] ?? e.message })),
    };
  }

  // Anchors and aliases are not part of the format: a small file must not expand into a large one.
  const aliases: WorkflowYamlProblem[] = [];
  visit(document, {
    Alias(_key, node) {
      aliases.push({ line: lineOf(node.range?.[0]), message: "Aliases (*name) are not supported; write the value out." });
    },
  });
  if (aliases.length > 0) return { ok: false, problems: aliases };

  const parsed = docSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const path = issue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
      const node = document.getIn(path, true) as { range?: [number, number, number] } | undefined;
      const where = path.length ? path.join(".") : "(file)";
      return { line: lineOf(node?.range?.[0]), message: `${where}: ${issue.message}` };
    });
    return { ok: false, problems };
  }

  // Checks the schema cannot express.
  const problems: WorkflowYamlProblem[] = [];
  const seen = new Map<string, number>();
  const stepsNode = document.get("steps", true) as { items?: { range?: [number, number, number] }[] } | undefined;
  parsed.data.steps.forEach((step, i) => {
    const line = lineOf(stepsNode?.items?.[i]?.range?.[0]);
    if (seen.has(step.status)) {
      problems.push({ line, message: `steps.${i}.status: "${step.status}" is listed twice (first at step ${seen.get(step.status)! + 1}).` });
    }
    seen.set(step.status, i);
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, doc: parsed.data };
}

// ---------------------------------------------------------------- resolve

/** What entering a column does; the same shape the workflow editor keeps for a column. */
export type WorkflowDraftHandoff = Pick<IssueWorkflowStep, "handler" | "instructions" | "next_status_key" | "back_status_key">;

/** A middle column of a draft: a library status, or one to create on save. */
export type WorkflowDraftColumn =
  | { id: string; status_key: string }
  | { id: string; new_name: string; category?: "unstarted" | "started" };

/** A workflow in the shape the editor edits before it is saved. */
export interface WorkflowDraftSeed {
  name: string;
  description: string;
  backlog: boolean;
  blocked: boolean;
  middle: WorkflowDraftColumn[];
  handoffs: Record<string, WorkflowDraftHandoff>;
}

export type WorkflowImportNote =
  | { code: "status_matched_by_name"; step: string; detail: string }
  | { code: "status_will_be_created"; step: string }
  | { code: "category_adjusted"; step: string; detail: string }
  | { code: "handler_not_found"; step: string; kind: "agent" | "squad" | "member"; detail: string }
  | { code: "link_dropped"; step: string; detail: string }
  | { code: "link_to_new_status"; step: string; detail: string }
  | { code: "fields_ignored"; step: string }
  | { code: "step_duplicate"; step: string };

export interface ResolvedWorkflowImport {
  draft: WorkflowDraftSeed;
  /** Everything the import changed or could not carry over; shown before the editor opens. */
  notes: WorkflowImportNote[];
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Turns a parsed file into an editor draft for this workspace: statuses are
 * matched by key, then by name, and become new columns when nothing matches;
 * agents, squads and members are matched by name or email. Whatever cannot be
 * resolved is dropped and reported in `notes`, never guessed.
 */
export function resolveWorkflowImport(doc: WorkflowYamlDoc, refs: WorkflowYamlRefs): ResolvedWorkflowImport {
  const notes: WorkflowImportNote[] = [];
  const byKey = new Map(refs.statuses.map((s) => [s.key, s]));
  const keyOfName = new Map<string, string>();
  for (const s of refs.statuses) if (!keyOfName.has(lower(s.name))) keyOfName.set(lower(s.name), s.key);

  // The column id each file status becomes.
  const idOf = new Map<string, string>();
  const middle: WorkflowDraftColumn[] = [];
  const columnIds = new Set<string>();
  let backlog = false;
  let blocked = false;

  const kept: { step: WorkflowYamlStep; id: string }[] = [];
  for (const step of doc.steps) {
    let id: string | null = null;
    if (byKey.has(step.status) || FIXED.has(step.status)) {
      id = step.status;
    } else if (step.name && keyOfName.has(lower(step.name))) {
      id = keyOfName.get(lower(step.name))!;
      notes.push({ code: "status_matched_by_name", step: step.status, detail: id });
    } else {
      const name = step.name ?? step.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
      id = `new:${name}`;
      notes.push({ code: "status_will_be_created", step: step.status });
    }
    if (columnIds.has(id)) {
      notes.push({ code: "step_duplicate", step: step.status });
      continue;
    }
    columnIds.add(id);
    idOf.set(step.status, id);
    kept.push({ step, id });

    if (id === "backlog") backlog = true;
    else if (id === "blocked") blocked = true;
    else if (!FIXED.has(id)) {
      if (id.startsWith("new:")) {
        const wanted = step.category;
        const category = wanted === "unstarted" ? "unstarted" : "started";
        if (wanted === "done" || wanted === "closed") {
          notes.push({ code: "category_adjusted", step: step.status, detail: wanted });
        }
        middle.push({ id, new_name: id.slice(4), category });
      } else {
        middle.push({ id, status_key: id });
      }
    }
  }

  const resolveHandler = (step: WorkflowYamlStep): IssueWorkflowHandler => {
    const h = step.handler;
    if (!h) return { type: "none" };
    switch (h.type) {
      case "agent": {
        const found = refs.agents.find((a) => lower(a.name) === lower(h.name));
        if (found) return { type: "agent", id: found.id };
        notes.push({ code: "handler_not_found", step: step.status, kind: "agent", detail: h.name });
        return { type: "none" };
      }
      case "squad": {
        const found = refs.squads.find((s) => lower(s.name) === lower(h.name));
        if (found) return { type: "squad", id: found.id };
        notes.push({ code: "handler_not_found", step: step.status, kind: "squad", detail: h.name });
        return { type: "none" };
      }
      case "member": {
        const found = refs.members.find((m) => lower(m.email) === lower(h.email));
        if (found) return { type: "member", id: found.user_id };
        notes.push({ code: "handler_not_found", step: step.status, kind: "member", detail: h.email });
        return { type: "none" };
      }
      default:
        return { type: h.type };
    }
  };

  const handoffs: Record<string, WorkflowDraftHandoff> = {};
  for (const { step, id } of kept) {
    const handler = resolveHandler(step);
    const wasAgent = step.handler?.type === "agent";

    // Instructions and next/back only reach an agent's brief; the editor keeps them for agent steps alone.
    if (!wasAgent) {
      if (step.instructions || step.next || step.back) notes.push({ code: "fields_ignored", step: step.status });
      if (handler.type !== "none") handoffs[id] = { handler, instructions: "" };
      continue;
    }
    if (handler.type !== "agent") continue; // the agent is not here; the note says so

    const link = (field: "next" | "back"): string | undefined => {
      const target = step[field];
      if (!target) return undefined;
      // Todo, done and cancelled are in every workflow, listed in the file or not.
      const resolved = idOf.get(target) ?? (ALWAYS_LISTED.has(target) ? target : undefined);
      // The editor lets a link name only a status that exists before the save, so a link to one the
      // import will create has to be set afterwards.
      if (resolved?.startsWith("new:")) {
        notes.push({ code: "link_to_new_status", step: step.status, detail: target });
        return undefined;
      }
      if (resolved) return resolved;
      notes.push({ code: "link_dropped", step: step.status, detail: `${field} ${target}` });
      return undefined;
    };
    const next = link("next");
    const back = link("back");
    handoffs[id] = {
      handler,
      instructions: step.instructions ?? "",
      ...(next ? { next_status_key: next } : {}),
      ...(back ? { back_status_key: back } : {}),
    };
  }

  return {
    draft: { name: doc.name, description: doc.description ?? "", backlog, blocked, middle, handoffs },
    notes,
  };
}
