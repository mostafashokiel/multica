// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IssueWorkflow } from "../types";
import {
  WORKFLOW_YAML_MAX_BYTES,
  exportWorkflowYaml,
  parseWorkflowYaml,
  resolveWorkflowImport,
  type WorkflowYamlRefs,
} from "./yaml";

const refs: WorkflowYamlRefs = {
  statuses: [
    { key: "backlog", name: "Backlog", category: "unstarted" },
    { key: "todo", name: "Todo", category: "unstarted" },
    { key: "in_progress", name: "In Progress", category: "started" },
    { key: "in_review", name: "In Review", category: "started" },
    { key: "qa", name: "QA", category: "started" },
    { key: "deploy", name: "Deploy", category: "started" },
    { key: "blocked", name: "Blocked", category: "started" },
    { key: "done", name: "Done", category: "done" },
    { key: "cancelled", name: "Cancelled", category: "closed" },
  ],
  agents: [
    { id: "agent-1", name: "Builder" },
    { id: "agent-2", name: "Reviewer" },
  ],
  squads: [{ id: "squad-1", name: "Delivery Squad" }],
  members: [{ user_id: "user-1", email: "Ada@Example.com" }],
};

const workflow: Pick<IssueWorkflow, "name" | "description" | "steps"> = {
  name: "Delivery",
  description: "Build, review, then QA",
  steps: [
    { status_key: "backlog", handler: { type: "none" }, instructions: "" },
    { status_key: "todo", handler: { type: "none" }, instructions: "" },
    {
      status_key: "in_progress",
      handler: { type: "agent", id: "agent-1" },
      instructions: "Implement it.\nOpen a PR.",
      next_status_key: "in_review",
    },
    {
      status_key: "in_review",
      handler: { type: "agent", id: "agent-2" },
      instructions: "Review it.",
      next_status_key: "qa",
      back_status_key: "in_progress",
    },
    { status_key: "qa", handler: { type: "member", id: "user-1" }, instructions: "" },
    { status_key: "deploy", handler: { type: "squad", id: "squad-1" }, instructions: "" },
    { status_key: "blocked", handler: { type: "none" }, instructions: "" },
    { status_key: "done", handler: { type: "none" }, instructions: "" },
    { status_key: "cancelled", handler: { type: "none" }, instructions: "" },
  ],
};

function parsed(text: string) {
  const r = parseWorkflowYaml(text);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.doc;
}

describe("exportWorkflowYaml", () => {
  it("names agents, squads and members instead of writing their ids", () => {
    const { yaml, warnings } = exportWorkflowYaml(workflow, refs);
    expect(warnings).toEqual([]);
    expect(yaml).toContain("name: Builder");
    expect(yaml).toContain("name: Reviewer");
    expect(yaml).toContain("name: Delivery Squad");
    expect(yaml).toContain("email: Ada@Example.com");
    expect(yaml).not.toMatch(/agent-1|squad-1|user-1/);
    // Built-in statuses carry no name; custom ones carry theirs so another workspace can create them.
    expect(yaml).toMatch(/status: qa\n\s+name: QA\n\s+category: started/);
    expect(yaml).not.toMatch(/status: in_progress\n\s+name:/);
  });

  it("writes multi-line instructions as a block and is byte-stable", () => {
    const a = exportWorkflowYaml(workflow, refs).yaml;
    const b = exportWorkflowYaml(structuredClone(workflow), refs).yaml;
    expect(a).toBe(b);
    expect(a).toContain("instructions: |-\n      Implement it.\n      Open a PR.");
  });

  it("writes a handler whose target is gone as no handoff and says which step", () => {
    const gone = { ...workflow, steps: workflow.steps.map((s) => (s.status_key === "in_progress" ? { ...s, handler: { type: "agent" as const, id: "deleted" } } : s)) };
    const { yaml, warnings } = exportWorkflowYaml(gone, refs);
    expect(warnings).toEqual(["in_progress"]);
    expect(yaml).not.toContain("Implement it.");
  });
});

describe("parseWorkflowYaml", () => {
  it("round-trips an export", () => {
    const { yaml } = exportWorkflowYaml(workflow, refs);
    const doc = parsed(yaml);
    expect(doc.name).toBe("Delivery");
    expect(doc.steps.map((s) => s.status)).toEqual(workflow.steps.map((s) => s.status_key));
  });

  it("reports yaml syntax errors with a line", () => {
    const r = parseWorkflowYaml("version: 1\nname: [oops\nsteps: []\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]?.line).toBeGreaterThan(0);
  });

  it("reports every schema problem with the line it is on", () => {
    const r = parseWorkflowYaml(
      ["version: 2", "name: X", "steps:", "  - status: in_progress", "    instruction: typo", "  - status: done", "    handler: { type: robot }"].join("\n"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.problems.map((p) => p.message).join("\n");
    expect(messages).toContain("version");
    expect(messages).toMatch(/steps\.0/); // the unknown key
    expect(r.problems.every((p) => p.line === undefined || p.line >= 1)).toBe(true);
    expect(r.problems.find((p) => p.message.startsWith("steps.0"))?.line).toBe(4);
  });

  it("rejects a step listed twice, an empty file, an oversized file and aliases", () => {
    const twice = parseWorkflowYaml("version: 1\nname: X\nsteps:\n  - status: qa\n  - status: qa\n");
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.problems[0]).toMatchObject({ line: 5 });

    expect(parseWorkflowYaml("   \n").ok).toBe(false);
    expect(parseWorkflowYaml("x".repeat(WORKFLOW_YAML_MAX_BYTES + 1)).ok).toBe(false);

    const alias = parseWorkflowYaml("version: 1\nname: &n X\ndescription: *n\nsteps:\n  - status: qa\n");
    expect(alias.ok).toBe(false);
  });

  it("needs at least one step and a version", () => {
    expect(parseWorkflowYaml("version: 1\nname: X\nsteps: []\n").ok).toBe(false);
    expect(parseWorkflowYaml("name: X\nsteps:\n  - status: qa\n").ok).toBe(false);
  });
});

describe("resolveWorkflowImport", () => {
  it("rebuilds the same draft in the workspace the file came from", () => {
    const { yaml } = exportWorkflowYaml(workflow, refs);
    const { draft, notes } = resolveWorkflowImport(parsed(yaml), refs);
    expect(notes).toEqual([]);
    expect(draft).toMatchObject({ name: "Delivery", backlog: true, blocked: true });
    expect(draft.middle.map((c) => c.id)).toEqual(["in_progress", "in_review", "qa", "deploy"]);
    expect(draft.handoffs.in_progress).toEqual({
      handler: { type: "agent", id: "agent-1" },
      instructions: "Implement it.\nOpen a PR.",
      next_status_key: "in_review",
    });
    expect(draft.handoffs.in_review).toEqual({
      handler: { type: "agent", id: "agent-2" },
      instructions: "Review it.",
      next_status_key: "qa",
      back_status_key: "in_progress",
    });
    // Emails match whatever the case.
    expect(draft.handoffs.qa).toEqual({ handler: { type: "member", id: "user-1" }, instructions: "" });
    expect(draft.handoffs.deploy?.handler).toEqual({ type: "squad", id: "squad-1" });
  });

  it("maps the names to another workspace's ids and creates a missing status", () => {
    const other: WorkflowYamlRefs = {
      statuses: refs.statuses.filter((s) => s.key !== "qa"),
      agents: [
        { id: "x-builder", name: "builder" },
        { id: "x-reviewer", name: "Reviewer" },
      ],
      squads: [],
      members: [{ user_id: "x-ada", email: "ada@example.com" }],
    };
    const { yaml } = exportWorkflowYaml(workflow, refs);
    const { draft, notes } = resolveWorkflowImport(parsed(yaml), other);
    expect(draft.handoffs.in_progress?.handler).toEqual({ type: "agent", id: "x-builder" });
    expect(draft.handoffs["new:QA"]?.handler).toEqual({ type: "member", id: "x-ada" });
    expect(draft.middle.find((c) => c.id === "new:QA")).toEqual({ id: "new:QA", new_name: "QA", category: "started" });
    expect(notes).toContainEqual({ code: "status_will_be_created", step: "qa" });
    // The squad is not in this workspace: its step is imported without a handoff.
    expect(notes).toContainEqual({ code: "handler_not_found", step: "deploy", kind: "squad", detail: "Delivery Squad" });
    expect(draft.handoffs.deploy).toBeUndefined();
    // A link to a status that does not exist yet cannot be saved with the workflow, so it is reported instead.
    expect(notes).toContainEqual({ code: "link_to_new_status", step: "in_review", detail: "qa" });
    expect(draft.handoffs.in_review).toEqual({ handler: { type: "agent", id: "x-reviewer" }, instructions: "Review it.", back_status_key: "in_progress" });
  });

  it("drops instructions and links on a step that is not an agent's, and says so", () => {
    const doc = parsed(
      "version: 1\nname: X\nsteps:\n  - status: qa\n    handler: { type: member, email: ada@example.com }\n    instructions: Try it.\n    back: in_progress\n  - status: in_progress\n    instructions: Free text on a step with no handler.\n",
    );
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.handoffs.qa).toEqual({ handler: { type: "member", id: "user-1" }, instructions: "" });
    expect(draft.handoffs.in_progress).toBeUndefined();
    expect(notes).toEqual([
      { code: "fields_ignored", step: "qa" },
      { code: "fields_ignored", step: "in_progress" },
    ]);
  });

  it("imports nothing for an agent step whose agent is missing, and says which agent", () => {
    const doc = parsed("version: 1\nname: X\nsteps:\n  - status: in_progress\n    handler: { type: agent, name: Ghost }\n    instructions: Build.\n    next: in_review\n");
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.handoffs).toEqual({});
    expect(notes).toEqual([{ code: "handler_not_found", step: "in_progress", kind: "agent", detail: "Ghost" }]);
  });

  it("matches a status by name when its key is not in the workspace", () => {
    const doc = parsed("version: 1\nname: X\nsteps:\n  - status: sign_off\n    name: qa\n    category: started\n");
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.middle).toEqual([{ id: "qa", status_key: "qa" }]);
    expect(notes).toEqual([{ code: "status_matched_by_name", step: "sign_off", detail: "qa" }]);
  });

  it("makes a done or closed custom status a started one and says so", () => {
    const doc = parsed("version: 1\nname: X\nsteps:\n  - status: shipped\n    name: Shipped\n    category: done\n");
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.middle).toEqual([{ id: "new:Shipped", new_name: "Shipped", category: "started" }]);
    expect(notes).toContainEqual({ code: "category_adjusted", step: "shipped", detail: "done" });
  });

  it("keeps links to todo, done and cancelled even when the file does not list them, and drops unknown ones", () => {
    const doc = parsed("version: 1\nname: X\nsteps:\n  - status: in_progress\n    handler: { type: agent, name: Builder }\n    next: done\n    back: nowhere\n");
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.handoffs.in_progress).toEqual({ handler: { type: "agent", id: "agent-1" }, instructions: "", next_status_key: "done" });
    expect(notes).toEqual([{ code: "link_dropped", step: "in_progress", detail: "back nowhere" }]);
  });

  it("collapses two steps that become the same column", () => {
    const doc = parsed("version: 1\nname: X\nsteps:\n  - status: in_review\n  - status: review\n    name: in review\n");
    const { draft, notes } = resolveWorkflowImport(doc, refs);
    expect(draft.middle).toEqual([{ id: "in_review", status_key: "in_review" }]);
    expect(notes).toEqual([
      { code: "status_matched_by_name", step: "review", detail: "in_review" },
      { code: "step_duplicate", step: "review" },
    ]);
  });

  it("leaves backlog and blocked off unless the file lists them", () => {
    const { draft } = resolveWorkflowImport(parsed("version: 1\nname: X\nsteps:\n  - status: in_progress\n"), refs);
    expect(draft).toMatchObject({ backlog: false, blocked: false, description: "" });
  });
});
