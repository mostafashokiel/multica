import type { WorkflowRun } from "@multica/core/types";

/** A run that is still open at its last gate, with one parallel stage and one rework: enough to draw every part. */
export function runFixture(over: Partial<WorkflowRun["timeline"]> = {}): WorkflowRun {
  return {
    workflow: { id: "wf-1", key: "sdlc-pilot", name: "SDLC pilot" },
    issue: { id: "i-21", identifier: "ACME-21", title: "User management", status: "in_progress" },
    timeline: {
      started_at: "2026-10-10T20:55:01Z",
      open: true,
      elapsed_seconds: 2145,
      agent_seconds: 1515,
      people_seconds: 590,
      handoff_seconds: 40,
      reworks: 1,
      parallel_saved_seconds: 79,
      visits: [
        { stage_id: "requirements", name: "Requirements", type: "agent", number: 1, entered_at: "2026-10-10T20:55:01Z", left_at: "2026-10-10T20:55:40Z", open: false, elapsed_seconds: 39, agent: "PO_Agent", agent_seconds: 36, branches: [], wait_seconds: 0 },
        {
          stage_id: "review", name: "Requirements review", type: "human_gate", number: 1, entered_at: "2026-10-10T20:55:40Z", left_at: "2026-10-10T20:56:14Z", open: false,
          elapsed_seconds: 34, agent_seconds: 0, branches: [], wait_seconds: 28, decided_at: "2026-10-10T20:56:08Z", decided_by: { ref: "user:u-ann", id: "u-ann", name: "Ann Lee" }, outcome: "rejected",
        },
        { stage_id: "requirements", name: "Requirements", type: "agent", number: 2, entered_at: "2026-10-10T20:56:14Z", left_at: "2026-10-10T20:57:04Z", open: false, elapsed_seconds: 50, agent: "PO_Agent", agent_seconds: 45, branches: [], wait_seconds: 0 },
        {
          stage_id: "design", name: "Design", type: "parallel", number: 1, entered_at: "2026-10-10T20:57:04Z", left_at: "2026-10-10T20:58:10Z", open: false, elapsed_seconds: 66, agent_seconds: 60, wait_seconds: 0,
          branches: [
            { id: "c-1", identifier: "ACME-22", title: "Design: Solution architecture", agent: "Architect_Agent", status: "done", started_at: "2026-10-10T20:57:04Z", ended_at: "2026-10-10T20:58:04Z", work_seconds: 60, elapsed_seconds: 60, closed: true, cancelled: false },
            { id: "c-2", identifier: "ACME-23", title: "Design: Threat model", agent: "security-agent", status: "done", started_at: "2026-10-10T20:57:04Z", ended_at: "2026-10-10T20:57:49Z", work_seconds: 45, elapsed_seconds: 45, closed: true, cancelled: false },
          ],
        },
        { stage_id: "go-live", name: "Go-live approval", type: "human_gate", number: 1, entered_at: "2026-10-10T21:28:46Z", open: true, elapsed_seconds: 120, agent_seconds: 0, branches: [], wait_seconds: 120, outcome: "waiting" },
      ],
      ...over,
    },
  };
}
