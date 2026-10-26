// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { WorkflowInsights, WorkflowInsightsDays, WorkflowTimeline, WorkflowVisit } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { IssueTimingDialog } from "./issue-timing-dialog";
import { WorkflowInsightsDialog } from "./workflow-insights-dialog";

const getWorkflowTimeline = vi.fn<(issueId: string) => Promise<WorkflowTimeline>>();
const getWorkflowInsights = vi.fn<(workflowId: string, days: WorkflowInsightsDays) => Promise<WorkflowInsights>>();

vi.mock("@multica/core/api", () => ({
  api: {
    getWorkflowTimeline: (issueId: string) => getWorkflowTimeline(issueId),
    getWorkflowInsights: (workflowId: string, days: WorkflowInsightsDays) => getWorkflowInsights(workflowId, days),
  },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
const status = (key: string, name: string, category: string, position: number) => ({
  id: key, workspace_id: "ws-1", key, name, description: "", category, color: "#3b82f6",
  is_system: false, position, archived_at: null, created_at: "", updated_at: "",
});
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () =>
    buildIssueStatusCatalog([
      status("todo", "Todo", "unstarted", 1),
      status("in_progress", "In Progress", "started", 2),
      status("in_review", "In Review", "started", 3),
      status("done", "Done", "done", 4),
    ] as never),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => ({ "agent-1": "Forge", "user-1": "Alice" })[id] ?? "Unknown",
  }),
}));

function visit(over: Partial<WorkflowVisit>): WorkflowVisit {
  return {
    status_key: "in_progress", kind: "agent", handler: "agent", number: 1,
    entered_at: "2026-10-20T10:00:00Z", left_at: "2026-10-20T10:30:00Z", open: false,
    elapsed_seconds: 1800, agent_seconds: 1680, agent_ids: ["agent-1"], wait_seconds: 0,
    answered_at: null, answered_by: "", outcome: "passed", ...over,
  };
}

const finished: WorkflowTimeline = {
  started_at: "2026-10-20T10:00:00Z",
  ended_at: "2026-10-20T11:01:00Z",
  open: false,
  elapsed_seconds: 3660,
  agent_seconds: 1680,
  people_seconds: 1800,
  other_seconds: 180,
  reworks: 1,
  visits: [
    visit({}),
    visit({
      status_key: "in_review", kind: "person", handler: "member", entered_at: "2026-10-20T10:30:00Z",
      left_at: "2026-10-20T11:01:00Z", elapsed_seconds: 1860, agent_seconds: 0, agent_ids: [],
      wait_seconds: 1800, answered_by: "user-1", answered_at: "2026-10-20T11:00:00Z", outcome: "sent_back",
    }),
    visit({ status_key: "in_progress", number: 2, kind: "agent", entered_at: "2026-10-20T11:01:00Z", left_at: null, open: true, elapsed_seconds: 120, outcome: "waiting" }),
    visit({ status_key: "done", kind: "end", elapsed_seconds: 0, agent_seconds: 0, agent_ids: [], outcome: "" }),
  ],
};

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  getWorkflowTimeline.mockReset();
  getWorkflowInsights.mockReset();
});
afterEach(cleanup);

describe("IssueTimingDialog (MUL-7420)", () => {
  it("splits the total, names who worked or answered and how each visit ended", async () => {
    getWorkflowTimeline.mockResolvedValue(finished);
    renderIn(<IssueTimingDialog issueId="issue-1" identifier="MUL-1" open onOpenChange={() => {}} />);

    expect(await screen.findByText(/Total 1h 1m/)).toBeTruthy();
    expect(screen.getByText("Agents working")).toBeTruthy();
    expect(screen.getByText("Waiting on people")).toBeTruthy();
    expect(screen.getByText("28m")).toBeTruthy(); // the agent part
    expect(screen.getAllByText("30m").length).toBeGreaterThan(0); // the people part
    expect(screen.getByText("Sent back 1 time")).toBeTruthy();
    expect(screen.getByText(/answered by Alice/)).toBeTruthy();
    expect(screen.getAllByText(/Forge/).length).toBe(2); // both visits to the build step
    expect(screen.getByText("Visit 2")).toBeTruthy();
    // The end status has no row of its own.
    expect(screen.queryByText("Done")).toBeNull();
    expect(getWorkflowTimeline).toHaveBeenCalledWith("issue-1");
  });

  it("says an issue still going is running and counts it as so far", async () => {
    getWorkflowTimeline.mockResolvedValue({ ...finished, open: true, ended_at: null });
    renderIn(<IssueTimingDialog issueId="issue-1" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Total so far 1h 1m/)).toBeTruthy();
    expect(screen.getByText("still running")).toBeTruthy();
    expect(screen.getByText("2m…")).toBeTruthy();
  });

  it("says so when the issue has no history in the workflow", async () => {
    getWorkflowTimeline.mockResolvedValue({ ...finished, visits: [], elapsed_seconds: 0 });
    renderIn(<IssueTimingDialog issueId="issue-1" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/has not moved through its workflow/)).toBeTruthy();
  });

  it("reads nothing while closed and shows an error when the read fails", async () => {
    getWorkflowTimeline.mockRejectedValue(new Error("boom"));
    const { rerender } = renderIn(<IssueTimingDialog issueId="issue-1" open={false} onOpenChange={() => {}} />);
    expect(getWorkflowTimeline).not.toHaveBeenCalled();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <IssueTimingDialog issueId="issue-1" open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Could not read this issue's history/)).toBeTruthy();
  });
});

const insights: WorkflowInsights = {
  days: 30,
  runs: 3,
  finished: 2,
  open: 1,
  truncated: false,
  median_elapsed_seconds: 5400,
  p90_elapsed_seconds: 7200,
  median_agent_seconds: 1800,
  median_people_seconds: 3000,
  median_other_seconds: 600,
  sent_back: 2,
  bottleneck_status_key: "in_review",
  steps: [
    { status_key: "todo", kind: "other", visits: 3, open_visits: 0, median_seconds: 0, p90_seconds: 0, total_seconds: 0, sent_back: 0 },
    { status_key: "in_progress", kind: "agent", visits: 3, open_visits: 0, median_seconds: 1800, p90_seconds: 2400, total_seconds: 5400, sent_back: 0 },
    { status_key: "in_review", kind: "person", visits: 3, open_visits: 1, median_seconds: 3600, p90_seconds: 4500, total_seconds: 16200, sent_back: 2 },
  ],
  agents: [{ agent_id: "agent-1", visits: 3, median_seconds: 1800, p90_seconds: 2400, total_seconds: 5400 }],
  people: [{ user_id: "user-1", answers: 2, median_seconds: 3000, p90_seconds: 3600, slowest_seconds: 3600 }],
};

describe("WorkflowInsightsDialog (MUL-7420)", () => {
  it("shows the headline numbers, flags the bottleneck and names agents and people", async () => {
    getWorkflowInsights.mockResolvedValue(insights);
    renderIn(<WorkflowInsightsDialog workflowId="wf-1" open onOpenChange={() => {}} />);

    expect(await screen.findByText("2 finished, 1 running")).toBeTruthy();
    expect(screen.getAllByText("1h 30m").length).toBeGreaterThan(0); // typical total (and the build step's total)
    expect(screen.getAllByText("In Review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bottleneck").length).toBe(2); // the stat and the row's badge
    expect(screen.getByText("75%")).toBeTruthy(); // 16200 of 21600
    expect(screen.getByText("Forge")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(getWorkflowInsights).toHaveBeenCalledWith("wf-1", 30);
  });

  it("reads again for another period", async () => {
    getWorkflowInsights.mockResolvedValue(insights);
    renderIn(<WorkflowInsightsDialog workflowId="wf-1" open onOpenChange={() => {}} />);
    await screen.findByText("2 finished, 1 running");
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    await waitFor(() => expect(getWorkflowInsights).toHaveBeenCalledWith("wf-1", 90));
    expect(screen.getByRole("button", { name: "Last 90 days" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says so when no issue started in the period, and when the list was cut", async () => {
    getWorkflowInsights.mockResolvedValue({ ...insights, runs: 0, finished: 0, open: 0, steps: [], agents: [], people: [] });
    const first = renderIn(<WorkflowInsightsDialog workflowId="wf-1" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/No issue of this workflow was created in this period/)).toBeTruthy();
    first.unmount();

    getWorkflowInsights.mockResolvedValue({ ...insights, runs: 500, truncated: true });
    renderIn(<WorkflowInsightsDialog workflowId="wf-1" open onOpenChange={() => {}} />);
    expect(await screen.findByText("Showing the newest 500 issues.")).toBeTruthy();
  });
});
