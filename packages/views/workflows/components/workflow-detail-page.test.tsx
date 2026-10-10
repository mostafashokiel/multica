import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { Squad, Workflow, WorkflowMember, WorkflowVersion } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowDetailPage } from "./workflow-detail-page";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    getWorkflow: vi.fn(),
    listWorkflowVersions: vi.fn(),
    getWorkflowVersion: vi.fn(),
    listWorkflowAudit: vi.fn(),
    listSquads: vi.fn(),
    listWorkflowSquads: vi.fn(),
    getWorkflowPipeline: vi.fn(),
    renderWorkflow: vi.fn(),
    applyWorkflow: vi.fn(),
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const member = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: member.role, userId: "u-1", member: null, isLoading: false }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    workflows: () => "/acme/workflows",
    workflowDetail: (id: string) => `/acme/workflows/${id}`,
    workflowEdit: (id: string) => `/acme/workflows/${id}/edit`,
    squadDetail: (id: string) => `/acme/squads/${id}`,
  }),
}));
// Highlighting is shiki's job and is covered in @multica/ui; here the text it
// is handed is what matters.
vi.mock("@multica/ui/markdown", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}));

// The canvas library has its own tests; here only what the page hands it matters.
vi.mock("../designer/lazy-workflow-diagram", () => ({
  LazyWorkflowDiagram: (props: { definition: { stages: { id: string }[] }; positions: Record<string, { x: number; y: number }>; problemsByStage: Record<string, number> }) => (
    <div data-testid="diagram" data-stages={props.definition.stages.map((s) => s.id).join(",")} data-positions={JSON.stringify(props.positions)} data-problems={JSON.stringify(props.problemsByStage)} />
  ),
}));

const workflow: Workflow = {
  id: "wf-1",
  key: "sdlc-pilot",
  name: "SDLC pilot",
  description: "BRD to architecture",
  status: "active",
  latest_version: 2,
  revision: 5,
  created_by_type: "member",
  created_by_id: "u-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

function version(n: number, overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: `v-${n}`,
    workflow_id: "wf-1",
    version: n,
    content_hash: `hash-${n}-0123456789abcdef`,
    note: "",
    created_by_type: "member",
    created_by_id: "u-1",
    created_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function renderPage(path = "/acme/workflows/wf-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider
        value={{
          pathname: path,
          searchParams: new URLSearchParams(),
          hash: "",
          push,
          replace: vi.fn(),
          back: vi.fn(),
          getShareableUrl: (v) => v,
        }}
      >
        <WorkflowDetailPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

const push = vi.fn();

beforeEach(() => {
  push.mockReset();
  vi.mocked(api.getWorkflow).mockReset();
  vi.mocked(api.listWorkflowVersions).mockReset();
  vi.mocked(api.getWorkflowVersion).mockReset();
  vi.mocked(api.listWorkflowAudit).mockReset();
  vi.mocked(api.listSquads).mockReset();
  vi.mocked(api.listWorkflowSquads).mockReset();
  vi.mocked(api.getWorkflowPipeline).mockReset();
  vi.mocked(api.listWorkflowSquads).mockResolvedValue({ squads: [] });
  vi.mocked(api.renderWorkflow).mockReset();
  vi.mocked(api.applyWorkflow).mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  member.role = "owner";
});

afterEach(cleanup);

describe("WorkflowDetailPage", () => {
  it("shows the latest version's YAML as given, with no problems", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: "kind: Workflow\n" }),
    });
    renderPage();
    await openDefinition();

    const code = await screen.findByText("kind: Workflow", { exact: false });
    expect(code.closest("pre")).toHaveAttribute("data-language", "yaml");
    expect(screen.getByText("No problems found")).toBeInTheDocument();
    expect(api.getWorkflow).toHaveBeenCalledWith("wf-1");
  });

  it("lets anyone who can read it download or copy the YAML, to move it to another workspace", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: "kind: Workflow\n" }),
    });
    renderPage();
    await openDefinition();

    expect(await screen.findByRole("button", { name: "Download" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
  });

  it("lists every problem with its rule code, stage and line", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, {
        definition: "kind: Workflow\n",
        issues: [
          { code: "V004", message: "stage review is unreachable", stage_id: "review" },
          { message: "unknown field", line: 7 },
        ],
      }),
    });
    renderPage();
    await openDefinition();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Problems (2)")).toBeInTheDocument();
    expect(within(alert).getByText("V004")).toBeInTheDocument();
    expect(within(alert).getByText("stage review is unreachable")).toBeInTheDocument();
    expect(within(alert).getByText("Stage review")).toBeInTheDocument();
    expect(within(alert).getByText("unknown field")).toBeInTheDocument();
    expect(within(alert).getByText("Line 7")).toBeInTheDocument();
  });

  it("says so when the workflow has no saved version", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: null });
    renderPage();

    expect(
      await screen.findByText("This workflow has no saved version yet."),
    ).toBeInTheDocument();
  });

  it("shows not-found on a 404 and the disabled state on a 403", async () => {
    vi.mocked(api.getWorkflow).mockRejectedValue(new ApiError("workflow not found", 404, "Not Found"));
    const first = renderPage();
    expect(await screen.findByText("This workflow doesn't exist.")).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getWorkflow).mockRejectedValue(
      new ApiError("not enabled", 403, "Forbidden", { code: "workflows_disabled" }),
    );
    renderPage();
    expect(await screen.findByText("Workflows are not enabled")).toBeInTheDocument();
  });

  it("opens an older version from the Versions tab and can return to the latest", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: "version: two\n" }),
    });
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({
      versions: [version(2, { note: "Second" }), version(1, { note: "First" })],
    });
    vi.mocked(api.getWorkflowVersion).mockResolvedValue(version(1, { definition: "version: one\n" }));
    renderPage();
    await openDefinition();
    await screen.findByText("version: two", { exact: false });

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByText("Latest")).toBeInTheDocument();
    const firstRow = screen.getByText("First").closest("li") as HTMLElement;
    fireEvent.click(within(firstRow).getByRole("button", { name: "View" }));

    expect(await screen.findByText("version: one", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Viewing version 1")).toBeInTheDocument();
    expect(api.getWorkflowVersion).toHaveBeenCalledWith("wf-1", 1);

    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(await screen.findByText("version: two", { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Viewing version 1")).toBeNull());
  });

  it("shows an action it does not know as a generic change, not its raw code", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: "kind: Workflow\n" }),
    });
    vi.mocked(api.listWorkflowAudit).mockResolvedValue({
      audit: [
        { action: "save", version: 2, actor_type: "member", actor_id: "u-1", detail: {}, created_at: "2026-01-02T00:00:00Z" },
        { action: "teleport", actor_type: "member", actor_id: "u-1", detail: {}, created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    renderPage();
    await openDefinition();
    await screen.findByText("kind: Workflow", { exact: false });

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByText("Saved a new version")).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.queryByText("teleport")).toBeNull();
  });

  it("does not fetch the version list or audit trail until their tabs are opened", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: "kind: Workflow\n" }),
    });
    renderPage();
    await openDefinition();
    await screen.findByText("kind: Workflow", { exact: false });

    expect(api.listWorkflowVersions).not.toHaveBeenCalled();
    expect(api.listWorkflowAudit).not.toHaveBeenCalled();
  });
});

function squad(id: string, name: string, archived = false): Squad {
  return {
    id,
    workspace_id: "ws",
    name,
    description: "",
    instructions: "",
    avatar_url: null,
    leader_id: "a-1",
    creator_id: "u-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    archived_at: archived ? "2026-01-02T00:00:00Z" : null,
    archived_by: null,
  };
}

const rendered = {
  workflow_key: "sdlc-pilot",
  version: 2,
  content_hash: "abc",
  squad_name: "Delivery",
  instructions: "<!-- workflow-managed:begin ... -->\nBRIEFING <b>not markup</b>",
  labels: ["wf:sdlc-pilot", "phase:build"],
  members: [] as WorkflowMember[],
};

const applied = {
  applied: true,
  squad_id: "sq-1",
  workflow_key: "sdlc-pilot",
  version: 2,
  content_hash: "abc",
  labels: [],
  members: [] as WorkflowMember[],
};

function mockWorkflow(overrides: Partial<Workflow> = {}, issues: WorkflowVersion["issues"] = []) {
  vi.mocked(api.getWorkflow).mockResolvedValue({
    workflow: { ...workflow, ...overrides },
    version: version(2, { definition: "kind: Workflow\n", issues }),
  });
  vi.mocked(api.listSquads).mockResolvedValue([
    squad("sq-1", "Delivery"),
    squad("sq-old", "Old squad", true),
  ]);
  vi.mocked(api.renderWorkflow).mockResolvedValue(rendered);
}

// The page opens on the diagram; most tests here are about the text and the controls.
async function openDefinition() {
  fireEvent.click(await screen.findByRole("tab", { name: "Definition" }));
}

async function openApplyDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Apply to squad" }));
  return user;
}

async function chooseSquad(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("combobox", { name: "Squad" }));
  await user.click(await screen.findByRole("option", { name: name }));
}

describe("Apply to squad", () => {
  it("is offered to owners and admins, for an active workflow whose version is valid", async () => {
    for (const role of ["owner", "admin"]) {
      member.role = role;
      mockWorkflow();
      const view = renderPage();
      expect(await screen.findByRole("button", { name: "Apply to squad" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it.each([
    ["a plain member", () => { member.role = "member"; mockWorkflow(); }],
    ["an archived workflow", () => mockWorkflow({ status: "archived" })],
    ["a version with problems", () => mockWorkflow({}, [{ code: "V003", message: "unreachable" }])],
  ])("is not offered for %s", async (_name, arrange) => {
    arrange();
    renderPage();
    await openDefinition();
    await screen.findByText("kind: Workflow", { exact: false });
    expect(screen.queryByRole("button", { name: "Apply to squad" })).toBeNull();
  });

  it("previews the briefing as text for the chosen squad, and lists the labels", async () => {
    mockWorkflow();
    renderPage();
    const user = await openApplyDialog();

    // Archived squads are not offered.
    await user.click(await screen.findByRole("combobox", { name: "Squad" }));
    expect(screen.queryByRole("option", { name: "Old squad" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "Delivery" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/BRIEFING <b>not markup<\/b>/)).toBeInTheDocument();
    expect(dialog.querySelector("b")).toBeNull();
    expect(within(dialog).getByText("wf:sdlc-pilot")).toBeInTheDocument();
    expect(api.renderWorkflow).toHaveBeenCalledWith("wf-1", { version: 2, squad_id: "sq-1" });
    expect(api.applyWorkflow).not.toHaveBeenCalled();
  });

  it("applies the shown version to the chosen squad and says so", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockResolvedValue(applied);
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(api.applyWorkflow).toHaveBeenCalledWith("wf-1", { squad_id: "sq-1", version: 2, replace: false }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Applied version 2 to Delivery"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says nothing changed when the squad already had this version", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockResolvedValue({ ...applied, applied: false });
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Delivery already has version 2; nothing changed",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("lists the squads that follow the workflow, with links and how current each is", async () => {
    mockWorkflow();
    vi.mocked(api.listWorkflowSquads).mockResolvedValue({
      squads: [
        { squad_id: "sq-1", name: "Delivery", version: 2, content_hash: "h2", up_to_date: true },
        { squad_id: "sq-3", name: "<b>Support</b>", version: 1, content_hash: "h1", up_to_date: false },
      ],
    });
    renderPage();

    const delivery = await screen.findByRole("link", { name: "Delivery" });
    expect(delivery).toHaveAttribute("href", "/acme/squads/sq-1");
    expect(within(delivery.closest("li")!).getByText("Up to date")).toBeInTheDocument();
    // A squad's name is text, never markup.
    const support = screen.getByRole("link", { name: "<b>Support</b>" });
    expect(support.querySelector("b")).toBeNull();
    expect(within(support.closest("li")!).getByText("Behind: the latest is version 2")).toBeInTheDocument();
    expect(api.listWorkflowSquads).toHaveBeenCalledWith("wf-1");
  });

  it("says when no squad follows the workflow, and when the list cannot be loaded", async () => {
    mockWorkflow();
    renderPage();
    expect(await screen.findByText("No squad follows this workflow yet.")).toBeInTheDocument();
    cleanup();

    vi.mocked(api.listWorkflowSquads).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage();
    expect(await screen.findByText("Couldn't load the squads.")).toBeInTheDocument();
  });

  it("refreshes the list after applying", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockResolvedValue(applied);
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);
    const before = vi.mocked(api.listWorkflowSquads).mock.calls.length;

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(vi.mocked(api.listWorkflowSquads).mock.calls.length).toBeGreaterThan(before));
  });

  it("previews the agents and approvers it will add, and the ones it cannot find", async () => {
    mockWorkflow();
    vi.mocked(api.renderWorkflow).mockResolvedValue({
      ...rendered,
      members: [
        { kind: "agent", ref: "builder", id: "a-1", name: "builder", status: "add" },
        { kind: "person", ref: "user:u-1", id: "u-1", name: "Ada <b>Lovelace</b>", status: "add", can_wake_leader: false },
        { kind: "person", ref: "user:u-2", id: "u-2", name: "Bea", status: "add", can_wake_leader: true, cannot_run_agents: ["builder", "reviewer"] },
        { kind: "agent", ref: "reviewer", id: "a-2", name: "reviewer", status: "present" },
        { kind: "person", ref: "user:<multica-user-id>", status: "unresolved" },
      ],
    });
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");

    const section = await within(dialog).findByRole("region", { name: "Squad members" });
    expect(within(section).getAllByText("Will be added")).toHaveLength(3);
    // Only the person who cannot wake a private leader is warned.
    const alerts = within(section).getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("Their comment will not wake the squad leader");
    // And the agents their delegated work cannot reach are named.
    expect(alerts[1]).toHaveTextContent("Work handed on after their comment cannot reach builder, reviewer");
    expect(within(section).getByText("Already in the squad")).toBeInTheDocument();
    expect(within(section).getByText("Not found in this workspace; it will not be added")).toBeInTheDocument();
    // Names are text, never markup.
    expect(within(section).getByText(/Ada <b>Lovelace<\/b>/)).toBeInTheDocument();
    expect(section.querySelector("b")).toBeNull();
  });

  it("says how many members it added when it applies", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockResolvedValue({
      ...applied,
      members: [
        { kind: "agent", ref: "builder", status: "added" },
        { kind: "person", ref: "user:u-1", status: "added" },
        { kind: "person", ref: "user:x", status: "unresolved" },
      ],
    });
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Applied version 2 to Delivery and added 2 members"),
    );
  });

  it("adds members even when the briefing was already current", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockResolvedValue({
      ...applied,
      applied: false,
      members: [{ kind: "agent", ref: "builder", status: "added" }],
    });
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Added 1 member to Delivery; it already had version 2"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks before replacing a different workflow, and only then sends replace", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow)
      .mockRejectedValueOnce(
        new ApiError("already follows", 409, "Conflict", { code: "squad_has_workflow", workflow: "other-flow" }),
      )
      .mockResolvedValueOnce({ ...applied, replaced_workflow: "other-flow" });
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await within(dialog).findByText("This squad already follows another workflow")).toBeInTheDocument();
    expect(within(dialog).getByText(/other-flow/)).toBeInTheDocument();
    expect(api.applyWorkflow).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Replace and apply" }));

    await waitFor(() => expect(api.applyWorkflow).toHaveBeenCalledTimes(2));
    expect(api.applyWorkflow).toHaveBeenLastCalledWith("wf-1", { squad_id: "sq-1", version: 2, replace: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("explains a damaged marker instead of offering to replace", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockRejectedValue(
      new ApiError("bad marker", 409, "Conflict", { code: "managed_block_invalid" }),
    );
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await within(dialog).findByText(/damaged workflow marker/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Replace and apply" })).toBeNull();
  });

  it("reports any other failure and keeps the dialog open", async () => {
    mockWorkflow();
    vi.mocked(api.applyWorkflow).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage();
    const user = await openApplyDialog();
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't apply the workflow"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("cannot apply before a squad is chosen", async () => {
    mockWorkflow();
    renderPage();
    await openApplyDialog();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("applies an older version when that is the one being viewed", async () => {
    mockWorkflow();
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [version(2), version(1, { note: "First" })] });
    vi.mocked(api.getWorkflowVersion).mockResolvedValue(version(1, { definition: "version: one\n", issues: [] }));
    vi.mocked(api.applyWorkflow).mockResolvedValue({ ...applied, version: 1 });
    renderPage();
    await openDefinition();
    await screen.findByText("kind: Workflow", { exact: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    const row = (await screen.findByText("First")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "View" }));
    await screen.findByText("Viewing version 1");

    await user.click(await screen.findByRole("button", { name: "Apply to squad" }));
    await chooseSquad(user, "Delivery");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BRIEFING/);
    expect(api.renderWorkflow).toHaveBeenLastCalledWith("wf-1", { version: 1, squad_id: "sq-1" });
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(api.applyWorkflow).toHaveBeenCalledWith("wf-1", { squad_id: "sq-1", version: 1, replace: false }),
    );
  });
});

const PILOT = `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: demo
  version: 1
approvers: {}
start: a
stages:
  - id: a
    type: agent
    agent: x
    next: b
  - id: b
    type: end
`;

describe("Diagram tab", () => {
  it("is where the page opens, and draws the newest version", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT, layout: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } }) });
    renderPage();

    const diagram = await screen.findByTestId("diagram");
    expect(diagram).toHaveAttribute("data-stages", "a,b");
    expect(screen.getByRole("tab", { name: "Diagram" })).toHaveAttribute("aria-selected", "true");
    // The saved layout is used as it is.
    expect(JSON.parse(diagram.getAttribute("data-positions") ?? "{}")).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  });

  it("lays the stages out itself when the version has no complete saved layout", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT, layout: { a: { x: 1, y: 2 } } }) });
    renderPage();

    const positions = JSON.parse((await screen.findByTestId("diagram")).getAttribute("data-positions") ?? "{}");
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
    expect(positions.a).not.toEqual({ x: 1, y: 2 });
    expect(positions.a.y).toBeLessThan(positions.b.y);
  });

  it("marks the stages the server reported problems on, and lists the problems", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: PILOT, issues: [{ code: "V004", message: "no end reachable", stage_id: "a" }, { code: "V002", message: "x", stage_id: "a" }, { message: "general" }] }),
    });
    renderPage();

    const diagram = await screen.findByTestId("diagram");
    expect(JSON.parse(diagram.getAttribute("data-problems") ?? "{}")).toEqual({ a: 2 });
    expect(screen.getByText("Problems (3)")).toBeInTheDocument();
  });

  it("says so when the version cannot be read or has no stages or no text, instead of drawing nothing", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: "a: [" }) });
    const first = renderPage();
    expect(await screen.findByText(/can't be drawn/)).toBeInTheDocument();
    expect(screen.queryByTestId("diagram")).toBeNull();
    first.unmount();

    vi.mocked(api.getWorkflow).mockResolvedValue({
      workflow,
      version: version(2, { definition: PILOT.replace(/stages:[\s\S]*/, "stages: []\n") }),
    });
    const second = renderPage();
    expect(await screen.findByText("This version has no stages yet.")).toBeInTheDocument();
    second.unmount();

    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: null });
    renderPage();
    expect(await screen.findByText("This workflow has no saved version yet.")).toBeInTheDocument();
  });

  it("follows the version being viewed", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT }) });
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [version(2), version(1, { note: "First" })] });
    vi.mocked(api.getWorkflowVersion).mockResolvedValue(version(1, { definition: PILOT.replace("id: b\n    type: end", "id: z\n    type: end").replace("next: b", "next: z") }));
    renderPage();
    await screen.findByTestId("diagram");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    const row = (await screen.findByText("First")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("tab", { name: "Diagram" }));

    await waitFor(() => expect(screen.getByTestId("diagram")).toHaveAttribute("data-stages", "a,z"));
    expect(screen.getByText("Viewing version 1")).toBeInTheDocument();
  });
});

describe("Edit", () => {
  it("opens the designer for owners and admins on an active workflow", async () => {
    for (const role of ["owner", "admin"]) {
      member.role = role;
      vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT }) });
      const view = renderPage();
      const button = await screen.findByRole("button", { name: "Edit" });
      button.click();
      expect(push).toHaveBeenLastCalledWith("/acme/workflows/wf-1/edit");
      view.unmount();
    }
  });

  it("is not offered to a member, nor for an archived workflow", async () => {
    member.role = "member";
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT }) });
    const first = renderPage();
    await screen.findByTestId("diagram");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    first.unmount();

    member.role = "owner";
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow: { ...workflow, status: "archived" }, version: version(2, { definition: PILOT }) });
    renderPage();
    await screen.findByTestId("diagram");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("is offered even when the version has problems: that is when you need it", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version(2, { definition: PILOT, issues: [{ code: "V004", message: "x" }] }) });
    renderPage();
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply to squad" })).toBeNull();
  });
});
