import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { WorkflowPipeline, WorkflowPipelineChild, WorkflowPipelineIssue } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowPipelinePane } from "./workflow-pipeline-pane";
import { runFixture } from "./run-fixture";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflowPipeline: vi.fn(), getWorkflowRun: vi.fn() },
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
    expect(plan.className).toContain("w-48");
    expect(build.className).toContain("w-72");
    // The count is the highlighted badge (the other "2" is the lane's step number).
    expect([...build.querySelectorAll("header span")].find((n) => n.className.includes("text-brand"))?.textContent).toBe("2");
    expect(within(plan).getByText("Nothing here")).toHaveClass("sr-only");
    // The step numbers follow the workflow's order.
    expect([...document.querySelectorAll("section[aria-label] header span[aria-hidden]")].map((n) => n.textContent)).toEqual(["1", "2", "3"]);
  });

  const branch = (id: string, title: string, minutes: number, over: Partial<WorkflowPipelineChild> = {}): WorkflowPipelineChild => ({
    id,
    identifier: `ACM-${id}`,
    title,
    status: "todo",
    created_at: new Date(Date.parse("2026-10-10T21:00:00Z") + minutes * 60_000).toISOString(),
    closed: false,
    cancelled: false,
    ...over,
  });

  it("shows how far the branches of a parallel stage are, with a row for each that opens its sub-issue", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 1,
      stages: [
        {
          id: "design",
          name: "Design",
          type: "parallel",
          approvers: [],
          issues: [
            issue("1", "User management", {
              children: [
                branch("10", "Design: Threat model", 0, { status: "done", closed: true, assignee_type: "agent", assignee_id: "a1" }),
                branch("11", "Design: Test strategy", 0, { status: "in_progress" }),
                branch("12", "Design: Architecture", 0, { status: "cancelled", closed: true, cancelled: true }),
              ],
            }),
          ],
        },
      ],
    });
    renderPane();

    const lane = await screen.findByRole("region", { name: "Design" });
    expect(within(lane).getByText("2 of 3 branches done")).toBeInTheDocument();
    expect(within(lane).getByText("1 cancelled")).toBeInTheDocument();
    const rows = within(within(lane).getByRole("list", { name: "Branches" })).getAllByRole("link");
    // Named without the stage's prefix, each a link to its own sub-issue.
    expect(rows.map((r) => r.querySelector(".truncate")?.textContent)).toEqual(["Threat model", "Test strategy", "Architecture"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/acme/issues/10", "/acme/issues/11", "/acme/issues/12"]);
    // A link is never inside another link.
    expect(lane.querySelectorAll("a a")).toHaveLength(0);
  });

  it("counts only the newest set of branches after the stage was visited again, and only in a parallel stage", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
      ...empty,
      total: 2,
      stages: [
        {
          id: "design",
          name: "Design",
          type: "parallel",
          approvers: [],
          issues: [
            issue("1", "Reworked", {
              children: [
                branch("10", "Design: A", 0, { closed: true, status: "done" }),
                branch("11", "Design: B", 0, { closed: true, status: "done" }),
                branch("12", "Design: A", 300),
                branch("13", "Design: B", 301),
              ],
            }),
          ],
        },
        // Sub-issues of an issue in an ordinary stage are not branches and are not shown.
        { id: "build", name: "Build", type: "agent", approvers: [], issues: [issue("2", "Plain", { children: [branch("20", "Build: X", 0)] })] },
      ],
    });
    renderPane();

    const design = await screen.findByRole("region", { name: "Design" });
    expect(within(design).getByText("0 of 2 branches done")).toBeInTheDocument();
    expect(within(design).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/acme/issues/1", "/acme/issues/12", "/acme/issues/13"]);
    const build = screen.getByRole("region", { name: "Build" });
    expect(within(build).queryByRole("list", { name: "Branches" })).toBeNull();
  });

  describe("clocks", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-10T22:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());
    const ago = (seconds: number) => new Date(Date.parse("2026-10-10T22:00:00Z") - seconds * 1000).toISOString();

    it("shows how long an issue has been in its stage and in the run, flags a stay far past the usual, and says what is usual", async () => {
      vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
        ...empty,
        total: 2,
        stages: [
          { id: "build", name: "Build", type: "agent", approvers: [], typical_seconds: 600, typical_samples: 4, issues: [issue("1", "Slow one", { stage_entered_at: ago(2400), run_started_at: ago(3600) })] },
          { id: "review", name: "Review", type: "human_gate", approvers: [], issues: [issue("2", "Fresh one", { stage_entered_at: ago(90), run_started_at: ago(600) })] },
        ],
      });
      renderPane();

      const build = await screen.findByRole("region", { name: "Build" });
      expect(within(build).getByText("usually 10m 0s")).toBeInTheDocument();
      expect(within(build).getByText("In stage 40m 0s")).toBeInTheDocument();
      expect(within(build).getByText("· 4x the usual")).toBeInTheDocument();
      expect(within(build).getByText("Total 1h 0m")).toBeInTheDocument();
      // A person's wait reads as waiting, and with no typical time nothing is flagged.
      const review = screen.getByRole("region", { name: "Review" });
      expect(within(review).getByText("Waiting 1m 30s")).toBeInTheDocument();
      expect(within(review).queryByText(/the usual/)).toBeNull();
      expect(within(review).queryByText(/usually/)).toBeNull();
    });

    it("does not flag a stay that is only a little slow, and shows no clock where nothing was recorded", async () => {
      vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
        ...empty,
        total: 2,
        stages: [
          { id: "build", name: "Build", type: "agent", approvers: [], typical_seconds: 600, issues: [issue("1", "Fine", { stage_entered_at: ago(1500), run_started_at: ago(1500) }), issue("2", "Old record")] },
        ],
      });
      renderPane();

      const build = await screen.findByRole("region", { name: "Build" });
      expect(within(build).getByText("In stage 25m 0s")).toBeInTheDocument();
      expect(within(build).queryByText(/the usual/)).toBeNull();
      // The issue with no recorded entry has no clock and no timeline button of its own.
      expect(within(build).getAllByText("Timeline")).toHaveLength(1);
    });

    it("opens the issue's timeline from its card", async () => {
      vi.mocked(api.getWorkflowRun).mockResolvedValue(runFixture());
      vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
        ...empty,
        total: 1,
        stages: [{ id: "build", name: "Build", type: "agent", approvers: [], issues: [issue("1", "Slow one", { stage_entered_at: ago(60), run_started_at: ago(120) })] }],
      });
      renderPane();
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Timeline" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("ACM-1 Slow one")).toBeInTheDocument();
      expect(await within(dialog).findByText(/Total so far/)).toBeInTheDocument();
      expect(api.getWorkflowRun).toHaveBeenCalledWith("1");
    });

    it("gives each branch of a parallel stage its time: the finished ones fixed, the running one counting", async () => {
      vi.mocked(api.getWorkflowPipeline).mockResolvedValue({
        ...empty,
        total: 1,
        stages: [
          {
            id: "verify",
            name: "Verification",
            type: "parallel",
            approvers: [],
            issues: [
              issue("1", "User management", {
                stage_entered_at: ago(400),
                run_started_at: ago(900),
                children: [
                  { id: "c1", identifier: "ACM-10", title: "Verification: Docs", status: "done", created_at: ago(400), closed_at: ago(352), closed: true, cancelled: false },
                  { id: "c2", identifier: "ACM-11", title: "Verification: QA", status: "in_progress", created_at: ago(362), closed: false, cancelled: false },
                ],
              }),
            ],
          },
        ],
      });
      renderPane();

      const lane = await screen.findByRole("region", { name: "Verification" });
      const rows = within(within(lane).getByRole("list", { name: "Branches" })).getAllByRole("link");
      expect(rows[0]).toHaveTextContent("48s");
      expect(rows[0]).not.toHaveTextContent("…");
      expect(rows[1]).toHaveTextContent("6m 2s…");
    });
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
    const link = within(lane).getByRole("link", { name: /Do the thing/ });
    // The card is the raised, bordered box around the issue's link.
    const card = link.parentElement as HTMLElement;
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
