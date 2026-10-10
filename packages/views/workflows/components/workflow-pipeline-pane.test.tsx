import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { WorkflowPipeline, WorkflowPipelineIssue } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowPipelinePane } from "./workflow-pipeline-pane";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflowPipeline: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
// Status names and avatars have their own tests; here the card's own content matters.
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (key: string) => `status:${key}` }));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => (type === "member" && id === "u-ann" ? "Ann Lee" : `${type} ${id}`) }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="avatar">{`${actorType}:${actorId}`}</span>
  ),
}));

const issue = (id: string, title: string, over: Partial<WorkflowPipelineIssue> = {}): WorkflowPipelineIssue => ({
  id,
  identifier: `ACM-${id}`,
  title,
  status: "in_progress",
  updated_at: "2026-01-02T00:00:00Z",
  ...over,
});

const empty: WorkflowPipeline = {
  workflow_key: "sdlc-pilot",
  version: 2,
  stages: [],
  no_stage: [],
  conflicting: [],
  unknown_stage: [],
  total: 0,
  truncated: false,
};

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider
        value={{
          pathname: "/acme/workflows/wf-1",
          searchParams: new URLSearchParams(),
          hash: "",
          push: vi.fn(),
          replace: vi.fn(),
          back: vi.fn(),
          getShareableUrl: (v) => v,
        }}
      >
        <WorkflowPipelinePane workflowId="wf-1" workflowKey="sdlc-pilot" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getWorkflowPipeline).mockReset();
});
afterEach(cleanup);

describe("WorkflowPipelinePane", () => {
  it("puts each issue in its stage's column with a link, status, assignee and the count", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 3,
      stages: [
        { id: "build", name: "Build", type: "agent", approvers: [], issues: [issue("1", "Do the thing", { assignee_type: "agent", assignee_id: "a-1" }), issue("2", "Another")] },
        { id: "checks", name: "Checks", type: "parallel", approvers: [], issues: [] },
        { id: "review", name: "Review", type: "human_gate", approvers: [], issues: [] },
        { id: "done", name: "done", type: "end", approvers: [], issues: [issue("3", "Finished", { status: "done" })] },
      ],
    });
    renderPane();

    const build = await screen.findByRole("region", { name: "Build" });
    expect(within(build).getByText("2")).toBeInTheDocument();
    const link = within(build).getByRole("link", { name: /Do the thing/ });
    expect(link).toHaveAttribute("href", "/acme/issues/1");
    expect(within(link).getByText("ACM-1")).toBeInTheDocument();
    expect(within(link).getByText("status:in_progress")).toBeInTheDocument();
    expect(within(link).getByTestId("avatar")).toHaveTextContent("agent:a-1");
    expect(within(screen.getByRole("region", { name: "Review" })).getByText("Nothing here")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "done" })).getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("3 issues follow this workflow")).toBeInTheDocument();
    expect(within(build).getByText("Agent")).toBeInTheDocument();
    expect(build.querySelector('[data-stage-icon="agent"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: "Review" }).querySelector('[data-stage-icon="human_gate"]')).not.toBeNull();
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("Parallel")).toBeInTheDocument();
    expect(checks.querySelector('[data-stage-icon="parallel"]')).not.toBeNull();
    expect(within(screen.getByRole("region", { name: "Review" })).getByText("Human gate")).toBeInTheDocument();
  });

  it("numbers the lanes in order, shrinks the empty ones, and counts what the others hold", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 2,
      stages: [
        { id: "a", name: "Plan", type: "agent", approvers: [], issues: [] },
        { id: "b", name: "Build", type: "agent", approvers: [], issues: [issue("1", "One"), issue("2", "Two")] },
        { id: "c", name: "Checks", type: "parallel", approvers: [], issues: [] },
      ],
    });
    renderPane();

    const plan = await screen.findByRole("region", { name: "Plan" });
    const build = screen.getByRole("region", { name: "Build" });
    // Lanes with work are wide and say how many; empty ones are narrow and marked, with no placeholder text on screen.
    expect(plan).toHaveAttribute("data-empty", "true");
    expect(build).not.toHaveAttribute("data-empty");
    expect(plan.className).toContain("w-44");
    expect(build.className).toContain("w-72");
    // The count is the highlighted badge (the other "2" is the lane's step number).
    expect([...build.querySelectorAll("header span")].find((n) => n.className.includes("text-brand"))?.textContent).toBe("2");
    expect(within(plan).getByText("Nothing here")).toHaveClass("sr-only");
    // The step numbers follow the workflow's order.
    expect([...document.querySelectorAll("section[aria-label] header span[aria-hidden]")].map((n) => n.textContent)).toEqual(["1", "2", "3"]);
  });

  it("keeps an issue card visibly apart from its lane: the lane has a header, the card is a bordered, raised link", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 1,
      stages: [{ id: "b", name: "Build", type: "agent", approvers: [], issues: [issue("1", "Do the thing")] }],
    });
    renderPane();

    const lane = await screen.findByRole("region", { name: "Build" });
    expect(lane.querySelector("header")).not.toBeNull();
    const card = within(lane).getByRole("link", { name: /Do the thing/ });
    expect(card.className).toContain("border");
    expect(card.className).toContain("shadow-sm");
    expect(lane.contains(card)).toBe(true);
    expect(card.querySelector("header")).toBeNull();
  });

  it("says whom a human gate waits for, by name, and shows the assignee's name on the card", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 1,
      stages: [
        {
          id: "review",
          name: "Review",
          type: "human_gate",
          approvers: [
            { ref: "user:u-ann", id: "u-ann", name: "Ann Lee" },
            { ref: "user:u-bob", id: "u-bob", name: "Bob Ray" },
            { ref: "user:<multica-user-id>" },
          ],
          issues: [issue("1", "Needs a decision", { assignee_type: "member", assignee_id: "u-ann", status: "in_review" })],
        },
        { id: "nobody", name: "Nobody", type: "human_gate", approvers: [{ ref: "user:<multica-user-id>" }], issues: [] },
        { id: "build", name: "Build", type: "agent", approvers: [], issues: [] },
      ],
    });
    const { container } = renderPane();

    const gate = await screen.findByRole("region", { name: "Review" });
    expect(within(gate).getByText("Waiting for Ann Lee, Bob Ray +1 not registered")).toBeInTheDocument();
    expect(within(gate).getByRole("link", { name: /Needs a decision/ })).toHaveTextContent("Ann Lee · ");
    // A placeholder is counted, never printed as an id.
    expect(container.textContent).not.toContain("multica-user-id");
    expect(container.textContent).not.toContain("user:u-");
    expect(
      within(screen.getByRole("region", { name: "Nobody" })).getByText("Waiting for an approver, but none is a registered member"),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Build" })).queryByText(/Waiting for/)).toBeNull();
  });

  it("lists issues that sit outside any stage, and says why each needs attention", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 3,
      stages: [{ id: "build", name: "Build", type: "agent", approvers: [], issues: [] }],
      no_stage: [issue("1", "Not begun")],
      conflicting: [issue("2", "Two labels", { phases: ["phase:build", "phase:review"] })],
      unknown_stage: [issue("3", "Stale", { phases: ["phase:gone"] })],
    });
    renderPane();

    expect(await screen.findByRole("region", { name: "Not started" })).toHaveTextContent("Not begun");
    const conflicting = screen.getByRole("region", { name: "Needs attention: several phase labels" });
    expect(conflicting).toHaveTextContent("Two labels");
    expect(conflicting).toHaveTextContent("Labels: phase:build, phase:review");
    const unknown = screen.getByRole("region", { name: "Needs attention: unknown stage" });
    expect(unknown).toHaveTextContent("The phase label names no stage of version 2");
    expect(unknown).toHaveTextContent("Labels: phase:gone");
  });

  it("renders titles as text, never markup", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 1,
      stages: [{ id: "build", name: "<b>Build</b>", type: "agent", approvers: [], issues: [issue("1", "<img src=x onerror=alert(1)>")] }],
    });
    const { container } = renderPane();

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("says when nothing follows the workflow, naming the label that makes an issue follow it", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue(empty);
    renderPane();

    expect(await screen.findByText("No issue follows this workflow yet.")).toBeInTheDocument();
    expect(screen.getByText("An issue follows it when it has the label wf:sdlc-pilot.")).toBeInTheDocument();
  });

  it("asks for one squad's issues, and says when that squad has none", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue(empty);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithI18n(
      <QueryClientProvider client={client}>
        <NavigationProvider
          value={{
            pathname: "/acme/pipeline",
            searchParams: new URLSearchParams(),
            hash: "",
            push: vi.fn(),
            replace: vi.fn(),
            back: vi.fn(),
            getShareableUrl: (v) => v,
          }}
        >
          <WorkflowPipelinePane workflowId="wf-1" workflowKey="sdlc-pilot" squad="sq-1" />
        </NavigationProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("No issue of this squad follows this workflow.")).toBeInTheDocument();
    expect(api.getWorkflowPipeline).toHaveBeenCalledWith("wf-1", { squad: "sq-1" });
  });

  it("says when the list was cut", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 500,
      truncated: true,
      stages: [{ id: "build", name: "Build", type: "agent", approvers: [], issues: [issue("1", "x")] }],
    });
    renderPane();
    expect(await screen.findByText(/Showing the 500 most recently updated\./)).toBeInTheDocument();
  });

  it("says when the pipeline cannot be loaded", async () => {
    vi.mocked(api.getWorkflowPipeline).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPane();
    expect(await screen.findByText("Couldn't load the pipeline.")).toBeInTheDocument();
  });
});
