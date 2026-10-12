import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { WorkflowInsights } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowInsightsPane } from "./workflow-insights-pane";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflowInsights: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));

const insights = (over: Partial<WorkflowInsights> = {}): WorkflowInsights => ({
  workflow_key: "sdlc-pilot",
  days: 30,
  runs: 4,
  finished: 3,
  open: 1,
  truncated: false,
  median_elapsed_seconds: 1800,
  p90_elapsed_seconds: 3000,
  median_agent_seconds: 1200,
  median_people_seconds: 540,
  median_handoff_seconds: 60,
  reworks: 2,
  bottleneck_stage_id: "build",
  stages: [
    { stage_id: "build", name: "Implementation", type: "agent", visits: 5, open_visits: 1, median_seconds: 800, p90_seconds: 1200, total_seconds: 4000, rejected: 0 },
    { stage_id: "review", name: "Code review", type: "human_gate", visits: 4, open_visits: 0, median_seconds: 230, p90_seconds: 400, total_seconds: 1000, rejected: 2 },
  ],
  agents: [{ agent: "dev-agent", runs: 5, median_seconds: 800, p90_seconds: 1200, total_seconds: 4000 }],
  approvers: [
    { ref: "user:u-ann", id: "u-ann", name: "Ann Lee", decisions: 3, median_seconds: 230, p90_seconds: 400, slowest_seconds: 400 },
    { ref: "user:gone", decisions: 1, median_seconds: 60, p90_seconds: 60, slowest_seconds: 60 },
  ],
  ...over,
});

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <WorkflowInsightsPane workflowId="wf-1" />
    </QueryClientProvider>,
  );
}

// Braces matter: an arrow that returns the mock makes vitest call it as a teardown, which rejects unhandled.
beforeEach(() => {
  vi.mocked(api.getWorkflowInsights).mockReset();
});
afterEach(cleanup);

describe("WorkflowInsightsPane", () => {
  it("summarises the runs, names the bottleneck, and lists time per stage, agent and approver", async () => {
    vi.mocked(api.getWorkflowInsights).mockResolvedValue(insights());
    renderPane();

    expect(await screen.findByText("3 finished, 1 running")).toBeInTheDocument();
    expect(screen.getByText("30m 0s")).toBeInTheDocument();
    expect(screen.getByText("slowest 10% take 50m 0s or more")).toBeInTheDocument();

    const stages = screen.getByRole("region", { name: "Time per stage" });
    const rows = within(stages).getAllByRole("row").slice(1);
    // The stage with most of the time is marked, its typical and slowest times are shown, and each has its share.
    expect(rows[0]).toHaveTextContent("Implementation");
    expect(rows[0]).toHaveTextContent("Bottleneck");
    expect(rows[0]).toHaveTextContent("13m 20s");
    expect(rows[0]).toHaveTextContent("80%");
    expect(rows[1]).toHaveTextContent("Code review");
    expect(rows[1]).toHaveTextContent("20%");
    expect(rows[1]?.lastElementChild).toHaveTextContent("2");

    expect(within(screen.getByRole("region", { name: "Agents" })).getByText("dev-agent")).toBeInTheDocument();
    const people = within(screen.getByRole("region", { name: "People at the gates" }));
    expect(people.getByText("Ann Lee")).toBeInTheDocument();
    expect(people.getByText("Someone outside this workspace")).toBeInTheDocument();
  });

  it("changes the window, asking the server for it", async () => {
    vi.mocked(api.getWorkflowInsights).mockResolvedValue(insights());
    renderPane();
    const user = userEvent.setup();
    await screen.findByText("3 finished, 1 running");
    expect(api.getWorkflowInsights).toHaveBeenLastCalledWith("wf-1", 30);

    await user.click(screen.getByRole("button", { name: "Last 7 days" }));

    await waitFor(() => expect(api.getWorkflowInsights).toHaveBeenLastCalledWith("wf-1", 7));
    expect(screen.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "false");
  });

  it("says so when there are no runs, and when no run has finished, and when the list was cut", async () => {
    vi.mocked(api.getWorkflowInsights).mockResolvedValue(insights({ runs: 0, finished: 0, open: 0, stages: [], agents: [], approvers: [] }));
    const first = renderPane();
    expect(await screen.findByText("No runs in the last 30 days.")).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getWorkflowInsights).mockResolvedValue(insights({ finished: 0, open: 4, median_elapsed_seconds: 0, truncated: true }));
    renderPane();
    expect(await screen.findByText("no run has finished yet")).toBeInTheDocument();
    expect(screen.getByText("Only the 500 newest runs in the window are measured.")).toBeInTheDocument();
  });

  it("shows a failure, not an empty page", async () => {
    vi.mocked(api.getWorkflowInsights).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPane();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the insights."));
  });
});
