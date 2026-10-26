import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { runFixture } from "./run-fixture";
import { WorkflowRunSection } from "./workflow-run-section";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflowRun: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@multica/core/config", () => ({ useFeatureEnabled: () => flag.on }));

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <WorkflowRunSection issueId="i-21" title="ACME-21 User management" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  flag.on = true;
  vi.mocked(api.getWorkflowRun).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T21:30:46Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkflowRunSection", () => {
  it("shows the total and its split on an issue that follows a workflow, and opens the full timeline", async () => {
    vi.mocked(api.getWorkflowRun).mockResolvedValue(runFixture());
    renderSection();
    const user = userEvent.setup();

    const section = await screen.findByRole("region", { name: "Run timeline" });
    expect(within(section).getByText("Total so far 35m 45s")).toBeInTheDocument();
    expect(within(section).getByText("Agents working").parentElement).toHaveTextContent("25m 15s");
    expect(within(section).getByText("Waiting on people").parentElement).toHaveTextContent("9m 50s");

    await user.click(within(section).getByRole("button", { name: "Timeline" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("ACME-21 User management")).toBeInTheDocument();
  });

  it("shows nothing for an issue that follows no workflow, or has no timing yet", async () => {
    vi.mocked(api.getWorkflowRun).mockRejectedValue(new ApiError("no", 404, "Not Found", { code: "not_in_workflow" }));
    const { container, unmount } = renderSection();
    await waitFor(() => expect(api.getWorkflowRun).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
    unmount();

    vi.mocked(api.getWorkflowRun).mockResolvedValue(runFixture({ visits: [] }));
    const second = renderSection();
    await waitFor(() => expect(api.getWorkflowRun).toHaveBeenCalledTimes(2));
    expect(second.container.querySelector("section")).toBeNull();
  });

  it("makes no request and shows nothing while the workflows flag is off", () => {
    flag.on = false;
    const { container } = renderSection();
    expect(api.getWorkflowRun).not.toHaveBeenCalled();
    expect(container.querySelector("section")).toBeNull();
  });
});
