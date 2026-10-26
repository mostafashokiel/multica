// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  EMPTY_ISSUE_WORKFLOW_DRY_RUN,
  EMPTY_LIST_ISSUE_WORKFLOWS_RESPONSE,
  IssueWorkflowDryRunResponseSchema,
  IssueWorkflowSchema,
  ListIssueWorkflowsResponseSchema,
  WorkflowHandoffPreviewSchema,
  EMPTY_WORKFLOW_HANDOFF_PREVIEW,
  WorkflowTimelineSchema,
  EMPTY_WORKFLOW_TIMELINE,
  WorkflowInsightsSchema,
  EMPTY_WORKFLOW_INSIGHTS,
} from "../api/schemas";

const baseWorkflow = {
  id: "wf-1",
  workspace_id: "ws-1",
  name: "Delivery",
  description: "",
  is_default: false,
  steps: [
    { status_key: "todo", handler: { type: "none" }, instructions: "" },
    {
      status_key: "code_review",
      handler: { type: "agent", id: "agent-1" },
      instructions: "Review the PR.",
      next_status_key: "done",
      back_status_key: "todo",
    },
  ],
  project_ids: ["project-1"],
  created_at: "2026-09-24T00:00:00Z",
  updated_at: "2026-09-24T00:00:00Z",
};

describe("workflow schemas (MUL-7420)", () => {
  it("parses a workflow list", () => {
    const parsed = ListIssueWorkflowsResponseSchema.parse({ workflows: [baseWorkflow], total: 1 });
    expect(parsed.workflows[0]?.steps[1]?.handler).toEqual({ type: "agent", id: "agent-1" });
    expect(parsed.workflows[0]?.project_ids).toEqual(["project-1"]);
  });

  it("falls back to an empty list on a malformed response", () => {
    const parsed = parseWithFallback(
      { workflows: "nope" },
      ListIssueWorkflowsResponseSchema,
      EMPTY_LIST_ISSUE_WORKFLOWS_RESPONSE,
      { endpoint: "GET /api/issue-workflows" },
    );
    expect(parsed).toEqual(EMPTY_LIST_ISSUE_WORKFLOWS_RESPONSE);
  });

  it("degrades an unknown handler type to a manual step", () => {
    const parsed = IssueWorkflowSchema.parse({
      ...baseWorkflow,
      steps: [{ status_key: "todo", handler: { type: "robot", id: "x" } }],
    });
    expect(parsed.steps[0]?.handler.type).toBe("none");
    expect(parsed.steps[0]?.instructions).toBe("");
  });

  it("defaults the optional fields an older server may omit", () => {
    const { description: _d, project_ids: _p, ...minimal } = baseWorkflow;
    const parsed = IssueWorkflowSchema.parse({ ...minimal, steps: [{ status_key: "todo" }] });
    expect(parsed.description).toBe("");
    expect(parsed.project_ids).toEqual([]);
    expect(parsed.steps[0]?.handler.type).toBe("none");
  });

  it("reads a workflow row's status-only steps as manual columns", () => {
    const parsed = IssueWorkflowSchema.parse({ ...baseWorkflow, is_default: true, steps: [{ status_key: "todo" }] });
    expect(parsed.is_default).toBe(true);
    expect(parsed.steps[0]).toEqual({ status_key: "todo", handler: { type: "none" }, instructions: "" });
  });

  it("falls back to an empty plan on a malformed dry run", () => {
    const parsed = parseWithFallback(
      { plan: { required: 5 } },
      IssueWorkflowDryRunResponseSchema,
      EMPTY_ISSUE_WORKFLOW_DRY_RUN,
      { endpoint: "POST /api/projects/{id}/workflow (dry run)" },
    );
    expect(parsed).toEqual(EMPTY_ISSUE_WORKFLOW_DRY_RUN);
  });

  it("parses a handoff preview and degrades an unknown handler type", () => {
    const parsed = WorkflowHandoffPreviewSchema.parse({
      handoff: true,
      workflow_name: "Delivery",
      from_status: "implement",
      to_status: "code_review",
      handler_type: "agent",
      handler_id: "agent-2",
      previous_assignee_type: "agent",
      previous_assignee_id: "agent-1",
      previous_runs: [{ task_id: "t1", agent_id: "agent-1", status: "running", started_at: "2026-09-24T00:00:00Z" }],
      brief: "This project's workflow — Delivery",
    });
    expect(parsed.handler_type).toBe("agent");
    expect(parsed.previous_runs).toHaveLength(1);
    expect(WorkflowHandoffPreviewSchema.parse({ handoff: true, handler_type: "robot" }).handler_type).toBeNull();
  });

  it("treats a malformed handoff preview as no handoff", () => {
    const parsed = parseWithFallback(
      { handoff: "yes", previous_runs: 3 },
      WorkflowHandoffPreviewSchema,
      EMPTY_WORKFLOW_HANDOFF_PREVIEW,
      { endpoint: "GET /api/issues/{id}/workflow-handoff" },
    );
    expect(parsed).toEqual(EMPTY_WORKFLOW_HANDOFF_PREVIEW);
  });

  describe("timing", () => {
    const visit = {
      status_key: "in_review",
      kind: "person",
      handler: "member",
      number: 1,
      entered_at: "2026-10-20T10:00:00Z",
      left_at: null,
      open: true,
      elapsed_seconds: 120,
      agent_seconds: 0,
      agent_ids: [],
      wait_seconds: 120,
      answered_at: null,
      answered_by: "",
      outcome: "waiting",
    };

    it("parses a timeline", () => {
      const raw = { ...EMPTY_WORKFLOW_TIMELINE, started_at: "2026-10-20T09:00:00Z", open: true, elapsed_seconds: 3600, visits: [visit] };
      const parsed = parseWithFallback(raw, WorkflowTimelineSchema, EMPTY_WORKFLOW_TIMELINE, { endpoint: "test" });
      expect(parsed.elapsed_seconds).toBe(3600);
      expect(parsed.visits[0]).toMatchObject({ status_key: "in_review", kind: "person", outcome: "waiting", wait_seconds: 120 });
    });

    it("reads an unknown visit kind or outcome as a neutral value, and a missing number as zero", () => {
      const raw = { visits: [{ ...visit, kind: "robot", outcome: "teleported", elapsed_seconds: "soon" }] };
      const parsed = parseWithFallback(raw, WorkflowTimelineSchema, EMPTY_WORKFLOW_TIMELINE, { endpoint: "test" });
      expect(parsed.visits[0]).toMatchObject({ kind: "other", outcome: "", elapsed_seconds: 0 });
      expect(parsed.elapsed_seconds).toBe(0);
    });

    it("falls back to an empty timeline on a malformed response", () => {
      const parsed = parseWithFallback("nope", WorkflowTimelineSchema, EMPTY_WORKFLOW_TIMELINE, { endpoint: "test" });
      expect(parsed).toEqual(EMPTY_WORKFLOW_TIMELINE);
    });

    it("parses insights and tolerates lists a server leaves out", () => {
      const raw = {
        days: 30,
        runs: 2,
        finished: 2,
        median_elapsed_seconds: 600,
        bottleneck_status_key: "in_review",
        steps: [{ status_key: "in_review", kind: "person", visits: 2, median_seconds: 300 }],
      };
      const parsed = parseWithFallback(raw, WorkflowInsightsSchema, EMPTY_WORKFLOW_INSIGHTS, { endpoint: "test" });
      expect(parsed.steps[0]).toMatchObject({ status_key: "in_review", visits: 2, median_seconds: 300, p90_seconds: 0 });
      expect(parsed.agents).toEqual([]);
      expect(parsed.people).toEqual([]);
      expect(parsed.truncated).toBe(false);
    });

    it("falls back to empty insights on a malformed response", () => {
      const parsed = parseWithFallback(null, WorkflowInsightsSchema, EMPTY_WORKFLOW_INSIGHTS, { endpoint: "test" });
      expect(parsed).toEqual(EMPTY_WORKFLOW_INSIGHTS);
    });
  });
});
