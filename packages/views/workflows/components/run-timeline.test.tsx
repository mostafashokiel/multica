import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { runFixture } from "./run-fixture";
import { RunTimeline, RunTimelineDialog } from "./run-timeline";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflowRun: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));

beforeEach(() => {
  vi.mocked(api.getWorkflowRun).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T21:30:46Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunTimeline", () => {
  it("says the total so far, and where the time went, with each part's share", () => {
    renderWithI18n(<RunTimeline run={runFixture()} />);

    const summary = screen.getByRole("region", { name: "Where the time went" });
    expect(within(summary).getByText("Total so far 35m 45s")).toBeInTheDocument();
    expect(within(summary).getByText("still running")).toBeInTheDocument();
    expect(within(summary).getByText("Sent back for rework: 1")).toBeInTheDocument();
    // 1515 / 590 / 40 of 2145 seconds.
    expect(within(summary).getByText("Agents working").parentElement).toHaveTextContent("25m 15s71%");
    expect(within(summary).getByText("Waiting on people").parentElement).toHaveTextContent("9m 50s28%");
    expect(within(summary).getByText("Handoffs").parentElement).toHaveTextContent("40s2%");
  });

  it("lists the stages in order, the revisit of a stage marked, a gate's answer and its wait, and the open one counting", () => {
    renderWithI18n(<RunTimeline run={runFixture()} />);

    const stages = screen.getByRole("region", { name: "Stages in order" });
    const rows = within(stages).getAllByRole("listitem");
    const names = rows.map((r) => r.textContent ?? "");
    expect(names[0]).toContain("Requirements");
    expect(names[0]).toContain("PO_Agent");
    expect(names[0]).toContain("39s");
    // A gate: its wait (not its stay), what happened, and who answered.
    expect(names[1]).toContain("Requirements review");
    expect(names[1]).toContain("28s");
    expect(names[1]).toContain("Sent back · answered by Ann Lee");
    // The second visit to a stage after a rework.
    expect(names[2]).toContain("Requirements");
    expect(names[2]).toContain("×2");
    // The gate nobody has answered is still counting.
    expect(names[names.length - 1]).toContain("Go-live approval");
    expect(names[names.length - 1]).toContain("2m 0s…");
    expect(names[names.length - 1]).toContain("Waiting");
  });

  it("breaks a parallel stage into its branches, named without the stage's prefix, and says what parallel saved", () => {
    renderWithI18n(<RunTimeline run={runFixture()} />);

    const stages = screen.getByRole("region", { name: "Stages in order" });
    const rows = within(stages).getAllByRole("listitem").map((r) => r.textContent ?? "");
    expect(rows.some((r) => r.includes("Design") && r.includes("2 in parallel"))).toBe(true);
    const architecture = rows.find((r) => r.includes("Solution architecture")) ?? "";
    expect(architecture).toContain("Architect_Agent");
    expect(architecture).toContain("1m 0s");
    expect(architecture).not.toContain("Design:");
    expect(screen.getByText("Run one after another, the parallel branches would have taken 1m 19s longer.")).toBeInTheDocument();
  });

  it("says plainly when nothing was recorded, and explains how the figures are made", () => {
    const { unmount } = renderWithI18n(<RunTimeline run={runFixture({ visits: [] })} />);
    expect(screen.getByText("No timing has been recorded for this issue yet.")).toBeInTheDocument();
    unmount();

    renderWithI18n(<RunTimeline run={runFixture({ open: false, ended_at: "2026-10-10T21:45:00Z", reworks: 0, parallel_saved_seconds: 0 })} />);
    expect(screen.getByText("Total 35m 45s")).toBeInTheDocument();
    expect(screen.queryByText("still running")).toBeNull();
    expect(screen.queryByText(/Sent back for rework/)).toBeNull();
    expect(screen.queryByText(/parallel branches would have taken/)).toBeNull();
    expect(screen.getByText(/Agent time is the work on the critical path/)).toBeInTheDocument();
  });

  it("draws server text as text, never as markup", () => {
    const run = runFixture();
    run.timeline.visits[0]!.name = '<img src=x onerror="alert(1)">';
    const { container } = renderWithI18n(<RunTimeline run={run} />);
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <RunTimelineDialog issueId="i-21" title="ACME-21 User management" open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("RunTimelineDialog", () => {
  it("loads the issue's run and shows it under the issue's name", async () => {
    vi.mocked(api.getWorkflowRun).mockResolvedValue(runFixture());
    renderDialog();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("ACME-21 User management")).toBeInTheDocument();
    expect(await within(dialog).findByText("Total so far 35m 45s")).toBeInTheDocument();
    expect(api.getWorkflowRun).toHaveBeenCalledWith("i-21");
  });

  it("says when the issue follows no workflow, and when the timeline could not be loaded", async () => {
    vi.mocked(api.getWorkflowRun).mockRejectedValue(new ApiError("no", 404, "Not Found", { code: "not_in_workflow" }));
    const { unmount } = renderDialog();
    expect(await screen.findByText("This issue does not follow a workflow.")).toBeInTheDocument();
    unmount();

    vi.mocked(api.getWorkflowRun).mockRejectedValue(new Error("offline"));
    renderDialog();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the timeline."));
  });
});

