import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, api } from "@multica/core/api";
import {
  addStage,
  stringifyDefinition,
  autoLayout,
  connect,
  emptyDefinition,
  renameStage,
  setApproverGroup,
  updateMetadata,
  updateStage,
  type WorkflowDefinition,
} from "@multica/core/workflows";
import { renderWithI18n } from "../../test/i18n";
import { sizeOf } from "./flow";
import { installFlowMocks } from "../../test/flow";
import WorkflowDesigner, { type DesignerInitial } from "./workflow-designer";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    createWorkflow: vi.fn(),
    saveWorkflowVersion: vi.fn(),
    listAgents: vi.fn(),
    listSkills: vi.fn(),
    listMembers: vi.fn(),
    validateWorkflow: vi.fn(),
    listWorkflowVersions: vi.fn(),
    getWorkflowVersion: vi.fn(),
    restoreWorkflowVersion: vi.fn(),
  },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/ui/components/common/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@multica/ui/markdown", () => ({ CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre> }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeAll(installFlowMocks);
beforeEach(() => {
  vi.mocked(api.createWorkflow).mockReset();
  vi.mocked(api.saveWorkflowVersion).mockReset();
  vi.mocked(api.listAgents).mockReset().mockResolvedValue([{ id: "a1", name: "builder", archived_at: null }, { id: "a2", name: "old-agent", archived_at: "2026-01-01" }] as never);
  vi.mocked(api.listSkills).mockReset().mockResolvedValue([{ id: "s1", name: "br-checklist" }] as never);
  vi.mocked(api.listMembers).mockReset().mockResolvedValue([
    { user_id: "u-ann", name: "Ann Lee", email: "ann@example.com", role: "admin" },
    { user_id: "u-bob", name: "Bob Ray", email: "bob@example.com", role: "member" },
  ] as never);
  vi.mocked(api.validateWorkflow).mockReset().mockResolvedValue({ parsed: true, valid: true, issues: [], canonical: "canonical: text\n" });
  vi.mocked(api.listWorkflowVersions).mockReset();
  vi.mocked(api.getWorkflowVersion).mockReset();
  vi.mocked(api.restoreWorkflowVersion).mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

function pilotish(): WorkflowDefinition {
  let d = updateMetadata(emptyDefinition(), { id: "demo", description: "Demo flow" });
  const add = (type: Parameters<typeof addStage>[1], id: string) => {
    const a = addStage(d, type);
    const r = renameStage(a.definition, a.id, id);
    if (!r.ok) throw new Error(r.reason);
    d = r.definition;
  };
  add("agent", "build");
  add("human_gate", "review");
  add("end", "done");
  d = setApproverGroup(d, "qa", ["user:1"]);
  d = updateStage(d, "build", { agent: "builder" });
  d = updateStage(d, "review", { approvers: "qa", max_rework: 2 });
  d = connect(d, "build", "next", "review");
  d = connect(d, "review", "approve", "done");
  d = connect(d, "review", "reject", "build");
  return d;
}

function initialFor(def: WorkflowDefinition, version: number): DesignerInitial {
  return { definition: def, positions: autoLayout(def, sizeOf), version };
}

function renderDesigner(props: { initial: DesignerInitial; workflowId?: string | null; onCreated?: (id: string) => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCreated = props.onCreated ?? vi.fn();
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <div style={{ width: 1000, height: 700 }}>
        <WorkflowDesigner workflowId={props.workflowId ?? null} initial={props.initial} onCreated={onCreated} />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, onCreated };
}

// By id: once a stage is selected its name is also in the side panel.
const nodeNamed = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const nodeCount = (container: HTMLElement) => container.querySelectorAll(".react-flow__node").length;
const edgeCount = (container: HTMLElement) => container.querySelectorAll(".react-flow__edge").length;

describe("a new workflow", () => {
  const blank = () => initialFor(emptyDefinition(), 0);

  it("starts empty, with the palette and a hint", () => {
    renderDesigner({ initial: blank() });
    expect(screen.getByText("Drag a stage from the palette to start.")).toBeInTheDocument();
    for (const name of ["Agent", "Parallel", "Human gate", "Condition", "End"]) {
      expect(within(screen.getByLabelText("Stages")).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId("version-label")).toHaveTextContent("Not saved yet");
  });

  it("adds a stage when a palette button is clicked; the first becomes the start", async () => {
    const { container } = renderDesigner({ initial: blank() });
    const user = userEvent.setup();

    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "Agent" }));

    await waitFor(() => expect(nodeCount(container)).toBe(1));
    expect(within(nodeNamed("agent-1")).getByText("Start")).toBeInTheDocument();
    expect(screen.queryByText("Drag a stage from the palette to start.")).toBeNull();
    // The new stage is selected, so its panel is showing.
    expect(screen.getByRole("button", { name: "Delete stage" })).toBeInTheDocument();

    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await waitFor(() => expect(nodeCount(container)).toBe(2));
    expect(within(nodeNamed("end-1")).queryByText("Start")).toBeNull();
  });

  it("cannot be saved until it has an id, then saves with the text, positions and note", async () => {
    const onCreated = vi.fn();
    vi.mocked(api.createWorkflow).mockResolvedValue({
      workflow: { id: "wf-new", key: "demo", name: "demo", description: "", status: "active", latest_version: 1, revision: 1, created_by_type: "member", created_by_id: "u", created_at: "", updated_at: "" },
      version: { id: "v1", workflow_id: "wf-new", version: 1, content_hash: "h", note: "", created_by_type: "member", created_by_id: "u", created_at: "" },
    });
    renderDesigner({ initial: blank(), onCreated });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    // Nothing selected: the workflow's own settings are showing.
    // (fireEvent, not userEvent: d3's pan handler cannot take a mousedown without a window.)
    fireEvent.click(screen.getByLabelText("Workflow canvas").querySelector(".react-flow__pane") as HTMLElement);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("Id"), "demo");
    await user.type(screen.getByLabelText("Version note"), "First draft");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.createWorkflow).mock.calls[0]![0];
    expect(body.definition).toContain("id: demo");
    expect(body.definition).toContain("- id: end-1");
    expect(body.note).toBe("First draft");
    expect(Object.keys(body.layout ?? {})).toEqual(["end-1"]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("wf-new"));
    expect(toast.success).toHaveBeenCalledWith("Saved version 1");
  });
});

describe("an existing workflow", () => {
  const open = () => initialFor(pilotish(), 3);

  it("draws what was loaded and is not dirty", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    await waitFor(() => expect(edgeCount(container)).toBe(3));
    expect(screen.getByTestId("version-label")).toHaveTextContent("Version 3");
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("locks the id, because it is the workflow's key", () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    expect(screen.getByLabelText("Id")).toBeDisabled();
  });

  it("shows a stage's connections and can cut one", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));

    fireEvent.click(nodeNamed("review"));
    const panel = screen.getByLabelText("Connections");
    expect(within(panel).getByText("done")).toBeInTheDocument();
    expect(within(panel).getByText("build")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Disconnect reject" }));
    await waitFor(() => expect(edgeCount(container)).toBe(2));
    expect(screen.getByTestId("version-label")).toHaveTextContent("Unsaved changes");
  });

  it("deleting a stage removes it and every connection to it", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));

    fireEvent.click(nodeNamed("build"));
    await user.click(screen.getByRole("button", { name: "Delete stage" }));

    await waitFor(() => expect(nodeCount(container)).toBe(2));
    // build->review and review->build are both gone; review->done stays.
    expect(edgeCount(container)).toBe(1);
  });

  it("moves the start with 'Set as start'", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    expect(within(nodeNamed("build")).getByText("Start")).toBeInTheDocument();

    fireEvent.click(nodeNamed("review"));
    await user.click(screen.getByRole("button", { name: "Set as start" }));

    expect(within(nodeNamed("review")).getByText("Start")).toBeInTheDocument();
    expect(within(nodeNamed("build")).queryByText("Start")).toBeNull();
  });

  it("undoes and redoes, and says when there is nothing to undo", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    const undoButton = screen.getByRole("button", { name: "Undo" });
    const redoButton = screen.getByRole("button", { name: "Redo" });
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await waitFor(() => expect(nodeCount(container)).toBe(4));
    expect(undoButton).toBeEnabled();

    await user.click(undoButton);
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
    expect(redoButton).toBeEnabled();

    await user.click(redoButton);
    await waitFor(() => expect(nodeCount(container)).toBe(4));
  });

  it("undoes from the keyboard, but not while typing in a field", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await waitFor(() => expect(nodeCount(container)).toBe(4));

    fireEvent.keyDown(screen.getByLabelText("Version note"), { key: "z", ctrlKey: true });
    expect(nodeCount(container)).toBe(4);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(nodeCount(container)).toBe(3));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(nodeCount(container)).toBe(4));
  });

  it("auto-layout is a change that can be undone", async () => {
    renderDesigner({ initial: { ...open(), positions: { build: { x: 900, y: 900 }, review: { x: 0, y: 0 }, done: { x: 400, y: 10 } } }, workflowId: "wf-1" });
    const user = userEvent.setup();
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");

    await user.click(screen.getByRole("button", { name: "Auto-layout" }));
    expect(screen.getByTestId("version-label")).toHaveTextContent("Unsaved changes");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
  });

  it("saves on top of the version it loaded, then is clean again", async () => {
    vi.mocked(api.saveWorkflowVersion).mockResolvedValue({
      workflow: { id: "wf-1" } as never,
      version: { id: "v4", workflow_id: "wf-1", version: 4, content_hash: "h", note: "", created_by_type: "member", created_by_id: "u", created_at: "" },
    });
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalledTimes(1));
    const [id, body] = vi.mocked(api.saveWorkflowVersion).mock.calls[0]!;
    expect(id).toBe("wf-1");
    expect(body.base_version).toBe(3);
    expect(body.definition).toContain("- id: end-1");
    expect(Object.keys(body.layout ?? {}).sort()).toEqual(["build", "done", "end-1", "review"]);
    expect(api.createWorkflow).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("version-label")).toHaveTextContent("Version 4"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(toast.success).toHaveBeenCalledWith("Saved version 4");
  });

  it("keeps the edits and says who won when a newer version was saved first", async () => {
    vi.mocked(api.saveWorkflowVersion).mockRejectedValue(
      new ApiError("a newer version was saved first", 409, "Conflict", { code: "version_conflict", latest_version: 5 }),
    );
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Someone saved version 5 first");
    await waitFor(() => expect(nodeCount(container)).toBe(4));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("lists the problems when the server could not read the workflow", async () => {
    vi.mocked(api.saveWorkflowVersion).mockRejectedValue(
      new ApiError("the definition could not be read", 400, "Bad Request", {
        code: "invalid_definition",
        issues: [{ path: "stages.0.next", message: "expected text" }, { message: "unknown field" }],
      }),
    );
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server could not read this workflow");
    expect(within(alert).getByText("stages.0.next: expected text")).toBeInTheDocument();
    expect(within(alert).getByText("unknown field")).toBeInTheDocument();
  });

  it("says plainly when saving fails for any other reason", async () => {
    vi.mocked(api.saveWorkflowVersion).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the workflow.");
  });

  it("asks before leaving with unsaved work, and not otherwise", async () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("draws server text as text, never as markup", async () => {
    let d = open().definition;
    d = updateStage(d, "build", { name: '<img src=x onerror="alert(1)">' });
    const { container } = renderDesigner({ initial: initialFor(d, 3), workflowId: "wf-1" });
    // (Twice: on the canvas and as the start stage's name in the settings.)
    expect((await screen.findAllByText('<img src=x onerror="alert(1)">')).length).toBeGreaterThan(0);
    expect(container.querySelector("img")).toBeNull();
  });
});

const stringifyForTest = stringifyDefinition;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const pickOption = async (user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, option: string) => {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
};
const lastSaved = () => vi.mocked(api.saveWorkflowVersion).mock.calls.at(-1)![1];
const okSave = () =>
  vi.mocked(api.saveWorkflowVersion).mockResolvedValue({
    workflow: { id: "wf-1" } as never,
    version: { id: "v", workflow_id: "wf-1", version: 4, content_hash: "h", note: "", created_by_type: "member", created_by_id: "u", created_at: "" },
  });

describe("stage properties", () => {
  const open = () => initialFor(pilotish(), 3);
  const select = async (id: string, container: HTMLElement) => {
    await waitFor(() => expect(nodeCount(container)).toBeGreaterThan(0));
    fireEvent.click(nodeNamed(id));
  };

  it("edits a stage's name; the node shows it at once and the change is saved", async () => {
    okSave();
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("build", container);

    await user.type(field("Name"), "Build it");

    expect(within(nodeNamed("build")).getByText("Build it")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    expect(lastSaved().definition).toContain("name: Build it");
  });

  it("renames a stage everywhere it is used, and keeps it selected", async () => {
    okSave();
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("build", container);

    await user.clear(field("Id"));
    await user.type(field("Id"), "compile{Enter}");

    await waitFor(() => expect(nodeNamed("compile")).toBeTruthy());
    expect(nodeNamed("build")).toBeNull();
    expect(field("Id")).toHaveValue("compile");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const saved = lastSaved();
    expect(saved.definition).toContain("start: compile");
    expect(saved.definition).toContain("on_reject: compile");
    expect(saved.definition).not.toMatch(/\bbuild\b/); // ("builder", the agent, is not the stage)
    expect(Object.keys(saved.layout ?? {}).sort()).toEqual(["compile", "done", "review"]);
  });

  it("refuses an empty or taken id, says why, and puts the old one back", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("build", container);

    await user.clear(field("Id"));
    await user.tab();
    expect(await screen.findByText("This can't be empty.")).toBeInTheDocument();
    expect(field("Id")).toHaveValue("build");

    await user.clear(field("Id"));
    await user.type(field("Id"), "review");
    await user.tab();
    expect(await screen.findByText('"review" is already used.')).toBeInTheDocument();
    expect(field("Id")).toHaveValue("build");
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
  });

  it("shows who is in a gate's approver group and lets you change them from the gate", async () => {
    okSave();
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("review", container);

    // The gate shows the people of its group, and flags the ones that are not registered members.
    expect(await screen.findByText("Members of qa")).toBeInTheDocument();
    expect(screen.getByText("user:1")).toBeInTheDocument();
    expect(screen.getByText("Not a registered member of this workspace")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a person" }));
    await user.click(await screen.findByRole("button", { name: /^Add Bob Ray/ }));
    await user.click(screen.getByRole("button", { name: "Remove user:1" }));
    expect(await screen.findByText("Bob Ray")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("user:u-bob");
    expect(text).not.toMatch(/user:1\b/);
  });

  it("shows the stage type's icon on each palette button, so people and agents can be told apart", () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });

    const palette = screen.getByLabelText("Stages");
    for (const [type, icon] of [["agent", "agent"], ["parallel", "parallel"], ["human_gate", "human_gate"], ["condition", "condition"], ["end", "end"]] as const) {
      const button = palette.querySelector(`[data-stage-type="${type}"]`) as HTMLElement;
      expect(button.querySelector(`[data-stage-icon="${icon}"]`), type).not.toBeNull();
    }
  });

  it("edits an agent stage: the agent (picked from the workspace's agents), skills and expected output", async () => {
    okSave();
    vi.mocked(api.listAgents).mockResolvedValue([
      { id: "a1", name: "builder", archived_at: null },
      { id: "a3", name: "reviewer", archived_at: null },
      { id: "a2", name: "old-agent", archived_at: "2026-01-01" },
    ] as never);
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("build", container);

    // Registered agents are offered; archived ones are not.
    await user.click(await screen.findByLabelText("Agent"));
    expect(await screen.findByRole("option", { name: "reviewer" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "builder" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "old-agent" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "reviewer" }));
    await user.type(field("Skills"), "br-checklist{Enter}");
    await user.type(field("Skills"), "br-checklist{Enter}"); // a duplicate is ignored
    await user.type(field("Skills"), "other{Enter}");
    await user.click(screen.getByRole("button", { name: "Remove skill other" }));
    await user.type(field("Expected output"), "A report");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("agent: reviewer");
    expect(text).toContain("br-checklist");
    expect(text).not.toContain("other");
    expect(text).toContain("expected_output: A report");
  });

  it("edits a parallel stage in the panel: branches are added, filled in and removed, and the node follows", async () => {
    okSave();
    vi.mocked(api.listAgents).mockResolvedValue([
      { id: "a1", name: "nyc", archived_at: null },
      { id: "a2", name: "cairo", archived_at: null },
    ] as never);
    const { container } = renderDesigner({ initial: initialFor(pilotish(), 3), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "Parallel" }));
    await waitFor(() => expect(nodeNamed("parallel-1")).not.toBeNull());
    const panel = within(screen.getByLabelText("Properties"));

    // Two empty branches to begin with, drawn as cards between two circles.
    expect(within(nodeNamed("parallel-1")).getAllByText("(no agent)")).toHaveLength(2);
    expect(nodeNamed("parallel-1").querySelectorAll('[data-gate="true"]')).toHaveLength(2);
    const first = within(panel.getByRole("group", { name: "Branch 1" }));
    await user.click(first.getByLabelText("Agent"));
    await user.click(await screen.findByRole("option", { name: "nyc" }));
    await user.type(first.getByLabelText("Branch name"), "New York");
    await user.type(first.getByLabelText("Skills"), "clock{Enter}");
    await user.type(first.getByLabelText("Expected output"), "The time");
    const second = within(panel.getByRole("group", { name: "Branch 2" }));
    await user.click(second.getByLabelText("Agent"));
    await user.click(await screen.findByRole("option", { name: "cairo" }));

    // A third branch, then take it away again.
    await user.click(panel.getByRole("button", { name: "Add branch" }));
    expect(panel.getByRole("group", { name: "Branch 3" })).toBeInTheDocument();
    await user.click(panel.getByRole("button", { name: "Remove branch 3" }));
    expect(panel.queryByRole("group", { name: "Branch 3" })).toBeNull();

    // The cards show the branch's name when it has one, else "Branch n", and its agent.
    const cards = within(nodeNamed("parallel-1")).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(cards.filter((c) => c?.includes(":"))).toEqual(["New York: nyc", "Branch 2: cairo"]);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("type: parallel");
    expect(text).toMatch(/name: New York\n\s+agent: nyc/);
    expect(text).toContain("agent: cairo");
    expect(text).toContain("expected_output: The time");
    expect(nodeCount(container)).toBe(4);
  });

  it("edits a parallel stage on the canvas: add a branch, pick one to show it in the panel, remove one", async () => {
    renderDesigner({ initial: initialFor(emptyDefinition(), 0) });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "Parallel" }));
    await waitFor(() => expect(nodeNamed("parallel-1")).not.toBeNull());
    const node = within(nodeNamed("parallel-1"));
    const panel = within(screen.getByLabelText("Properties"));

    // With two branches nothing can be removed from the canvas: a parallel stage needs two.
    expect(node.queryByRole("button", { name: /^Remove branch/ })).toBeNull();
    await user.click(node.getByRole("button", { name: "Add branch" }));
    expect(panel.getByRole("group", { name: "Branch 3" })).toBeInTheDocument();
    expect(node.getAllByRole("listitem")).toHaveLength(3);

    // Picking a card marks it, and the panel marks the same branch.
    // fireEvent, as for nodes: a synthesized mouse-down has no window and trips the canvas library's drag handler.
    fireEvent.click(node.getByRole("button", { name: /^Branch 3:/ }));
    expect(node.getByRole("button", { name: /^Branch 3:/ })).toHaveAttribute("aria-pressed", "true");
    expect(node.getByRole("button", { name: /^Branch 1:/ })).toHaveAttribute("aria-pressed", "false");
    expect(panel.getByRole("group", { name: "Branch 3" })).toHaveAttribute("aria-current", "true");
    expect(panel.getByRole("group", { name: "Branch 1" })).not.toHaveAttribute("aria-current");

    // The cross on a card removes that branch and clears the pick.
    await user.click(node.getByRole("button", { name: "Remove branch 3" }));
    expect(node.getAllByRole("listitem")).toHaveLength(2);
    expect(panel.queryByRole("group", { name: "Branch 3" })).toBeNull();
    expect(panel.getByRole("group", { name: "Branch 1" })).not.toHaveAttribute("aria-current");
  });

  it("stops offering more branches at the limit, on the canvas and in the panel", async () => {
    renderDesigner({ initial: initialFor(emptyDefinition(), 0) });
    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "Parallel" }));
    await waitFor(() => expect(nodeNamed("parallel-1")).not.toBeNull());
    const panel = within(screen.getByLabelText("Properties"));
    const add = panel.getByRole("button", { name: "Add branch" });
    for (let i = 0; i < 6; i++) await user.click(add);
    expect(panel.getByRole("group", { name: "Branch 8" })).toBeInTheDocument();
    expect(add).toBeDisabled();
    expect(panel.getByText("A parallel stage has at most 8 branches.")).toBeInTheDocument();
    expect(within(nodeNamed("parallel-1")).queryByRole("button", { name: "Add branch" })).toBeNull();
  });

  it("edits a gate: the approver group, the rework limit and the escalation", async () => {
    okSave();
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("review", container);

    expect(field("Max rework")).toHaveValue(2);
    await user.clear(field("Max rework"));
    await user.type(field("Max rework"), "5");
    await user.type(field("Escalate after (hours)"), "12");
    await pickOption(user, screen.getByLabelText("Approver group"), "(none)");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("max_rework: 5");
    expect(text).toContain("escalate_after_hours: 12");
    expect(text).toMatch(/approvers: ""/);
  });

  it("a cleared or non-positive number removes the field instead of saving nonsense", async () => {
    okSave();
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("review", container);

    await user.clear(field("Max rework"));
    await user.type(field("Escalate after (hours)"), "-3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    expect(lastSaved().definition).not.toContain("max_rework");
    expect(lastSaved().definition).not.toContain("escalate_after_hours");
  });

  it("edits a condition's expression", async () => {
    okSave();
    let d = open().definition;
    const added = addStage(d, "condition");
    d = added.definition;
    const { container } = renderDesigner({ initial: initialFor(d, 3), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select(added.id, container);

    await user.type(field("Condition"), 'has_label("pci")');

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    expect(lastSaved().definition).toContain("when: has_label(\"pci\")");
  });

  it("a burst of typing is one undo step", async () => {
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await select("build", container);

    await user.type(field("Name"), "Build it");
    expect(within(nodeNamed("build")).getByText("Build it")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(within(nodeNamed("build")).queryByText("Build it")).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("shows a gate that points at a group that no longer exists, rather than hiding it", async () => {
    let d = open().definition;
    d = updateStage(d, "review", { approvers: "ghosts" });
    const { container } = renderDesigner({ initial: initialFor(d, 3), workflowId: "wf-1" });
    await select("review", container);
    expect(screen.getByLabelText("Approver group")).toHaveTextContent("ghosts (not defined)");
  });
});

describe("workflow settings", () => {
  const open = () => initialFor(pilotish(), 3);

  it("sets the start stage and the squad it was written for", async () => {
    okSave();
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();

    await pickOption(user, screen.getByLabelText("Start stage"), "review");
    await user.type(field("Squad name"), "Delivery");
    await user.type(field("Squad leader agent"), "orchestrator");
    await user.type(field("Owner"), "eng-director");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("start: review");
    expect(text).toMatch(/squad:\s+name: Delivery\s+leader: orchestrator/);
    expect(text).toContain("owner: eng-director");
  });

  it("adds, renames, fills and removes approver groups", async () => {
    okSave();
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();

    // People are picked from the registered members, all listed without typing anything.
    await user.click(screen.getByRole("button", { name: "Add a person" }));
    expect(await screen.findByRole("button", { name: /^Add Bob Ray/ })).toBeInTheDocument();
    await user.type(field("Filter people"), "ann");
    expect(screen.queryByRole("button", { name: /^Add Bob Ray/ })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /^Add Ann Lee/ }));
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    // Only the name is shown for a registered member, never the id.
    expect(screen.queryByText("user:u-ann")).toBeNull();
    // Someone already in the group is no longer offered.
    expect(screen.queryByRole("button", { name: /^Add Ann Lee/ })).toBeNull();

    await user.type(field("New group name"), "po");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(field("New group name")).toHaveValue("");
    expect(screen.getAllByLabelText("Group name")).toHaveLength(2);

    // An entry that is not a registered member is flagged, and can be removed.
    expect(screen.getByText("Not a registered member of this workspace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove user:1" }));
    await user.click(screen.getAllByRole("button", { name: "Remove group" })[1]!);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("user:u-ann");
    expect(text).not.toMatch(/user:1\b/);
    expect(text).not.toMatch(/^\s+po:/m);
  });

  it("renames a group everywhere its gates use it", async () => {
    okSave();
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Group name"));
    await user.type(screen.getByLabelText("Group name"), "quality{Enter}");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveWorkflowVersion).toHaveBeenCalled());
    const text = lastSaved().definition;
    expect(text).toContain("approvers: quality");
    expect(text).toMatch(/^\s+quality:/m);
    expect(text).not.toMatch(/^\s+qa:/m);
  });

  it("refuses an empty, used or reserved group name, saying why", async () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(await screen.findByText("This can't be empty.")).toBeInTheDocument();
    await user.type(field("New group name"), "qa");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(await screen.findByText('"qa" is already used.')).toBeInTheDocument();
    await user.clear(field("New group name"));
    await user.type(field("New group name"), "__proto__");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(await screen.findByText('"__proto__" is not allowed.')).toBeInTheDocument();
    expect(screen.getAllByLabelText("Group name")).toHaveLength(1);
  });
});

describe("validation", () => {
  const open = () => initialFor(pilotish(), 3);
  const status = () => screen.getByTestId("validation-status");

  it("asks the server about the definition as text, and says Valid when it is", async () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "valid"));
    expect(status()).toHaveTextContent("Valid");
    const sent = vi.mocked(api.validateWorkflow).mock.calls[0]![0];
    expect(sent).toContain("id: demo");
    expect(sent).toContain("- id: review");
    expect(screen.getByText("No problems.")).toBeInTheDocument();
  });

  it("lists the server's problems, marks their stages on the canvas and counts them", async () => {
    vi.mocked(api.validateWorkflow).mockResolvedValue({
      parsed: true,
      valid: false,
      canonical: "x\n",
      issues: [
        { code: "V005", message: "a loop has no counted gate", stage_id: "review" },
        { code: "V006", message: "approver group is empty", stage_id: "review" },
        { message: "something general" },
      ],
    });
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });

    await waitFor(() => expect(status()).toHaveAttribute("data-state", "problems"));
    expect(status()).toHaveTextContent("3 problem(s)");
    const panel = screen.getByLabelText("Problems");
    expect(within(panel).getByText("V005")).toBeInTheDocument();
    expect(within(panel).getByText("a loop has no counted gate")).toBeInTheDocument();
    expect(within(panel).getByText("something general")).toBeInTheDocument();
    await waitFor(() => expect(within(nodeNamed("review")).getByText("! 2")).toBeInTheDocument());
    expect(within(nodeNamed("build")).queryByText(/^! /)).toBeNull();
    expect(nodeCount(container)).toBe(3);
  });

  it("clicking a problem on a stage selects that stage; one without a stage is just text", async () => {
    vi.mocked(api.validateWorkflow).mockResolvedValue({
      parsed: true, valid: false, canonical: "x\n",
      issues: [{ code: "V004", message: "no end reachable", stage_id: "build" }, { message: "general" }],
    });
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    const panel = await screen.findByLabelText("Problems");

    await user.click(await within(panel).findByRole("button", { name: /no end reachable/ }));

    expect(await screen.findByRole("heading", { name: "Agent stage" })).toBeInTheDocument();
    expect(field("Id")).toHaveValue("build");
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
  });

  it("waits for typing to stop before asking, and says it is checking meanwhile", async () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "valid"));
    const before = vi.mocked(api.validateWorkflow).mock.calls.length;
    const user = userEvent.setup({ delay: 20 });

    fireEvent.click(await screen.findByText("review").then((n) => n.closest(".react-flow__node") as HTMLElement));
    await user.type(field("Name"), "Quality");
    expect(status()).toHaveAttribute("data-state", "checking");
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "valid"));

    // Seven keystrokes, one question.
    expect(vi.mocked(api.validateWorkflow).mock.calls.length - before).toBe(1);
    expect(vi.mocked(api.validateWorkflow).mock.calls.at(-1)![0]).toContain("name: Quality");
  });

  it("says it could not check, instead of calling the workflow valid", async () => {
    vi.mocked(api.validateWorkflow).mockRejectedValue(new Error("offline"));
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "failed"));
    expect(status()).toHaveTextContent("Couldn't check");
    expect(screen.queryByText("No problems.")).toBeNull();
    expect(screen.getByRole("status", { name: "" })).toBeTruthy();
  });

  it("shows the text a save would store, as the server wrote it", async () => {
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "valid"));

    await user.click(screen.getByRole("tab", { name: "YAML" }));

    expect(await screen.findByTestId("code")).toHaveTextContent("canonical: text");
    expect(screen.getByText(/exact text that will be saved/)).toBeInTheDocument();
    // The canvas is only hidden: switching back loses nothing.
    await user.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(nodeNamed("build")).toBeTruthy();
  });
});

describe("versions", () => {
  const open = () => initialFor(pilotish(), 3);
  const v = (n: number, note = "", definition?: string) => ({ id: `v${n}`, workflow_id: "wf-1", version: n, content_hash: "h", note, created_by_type: "member", created_by_id: "u", created_at: "2026-01-02T00:00:00Z", ...(definition ? { definition } : {}) });
  const oldVersion = () => {
    let d = pilotish();
    d = updateStage(d, "build", { agent: "old-agent" });
    d = renameStage(d, "done", "finished").ok ? (renameStage(d, "done", "finished") as { ok: true; definition: WorkflowDefinition }).definition : d;
    return stringifyForTest(d);
  };

  it("has no versions tab for a workflow that was never saved", () => {
    renderDesigner({ initial: initialFor(emptyDefinition(), 0) });
    expect(screen.queryByRole("tab", { name: "Versions" })).toBeNull();
  });

  it("lists the versions and opens an old one as an edit that can be undone", async () => {
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [v(3, "Latest note"), v(2, "Older note")] });
    vi.mocked(api.getWorkflowVersion).mockResolvedValue({ ...v(2, "", oldVersion()), layout: undefined } as never);
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));

    await user.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("Older note")).toBeInTheDocument();
    expect(screen.getByText("Latest")).toBeInTheDocument();
    await user.click(within((await screen.findByText("Older note")).closest("li") as HTMLElement).getByRole("button", { name: "Open" }));

    await waitFor(() => expect(nodeNamed("finished")).toBeTruthy());
    expect(nodeNamed("done")).toBeNull();
    expect(screen.getByTestId("version-label")).toHaveTextContent("Unsaved changes");
    expect(toast.success).toHaveBeenCalledWith("Opened version 2. Save to make it the newest.");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(nodeNamed("done")).toBeTruthy());
  });

  it("restores a version through the server and then shows it as the newest, with nothing unsaved", async () => {
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [v(3, "Latest note"), v(2, "Older note")] });
    vi.mocked(api.restoreWorkflowVersion).mockResolvedValue({ workflow: { id: "wf-1" } as never, version: v(4, "Restored from version 2", oldVersion()) as never });
    const { container } = renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await waitFor(() => expect(nodeCount(container)).toBe(3));

    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(within((await screen.findByText("Older note")).closest("li") as HTMLElement).getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(api.restoreWorkflowVersion).toHaveBeenCalledWith("wf-1", 2));
    await waitFor(() => expect(screen.getByTestId("version-label")).toHaveTextContent("Version 4"));
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
    await waitFor(() => expect(nodeNamed("finished")).toBeTruthy());
    expect(toast.success).toHaveBeenCalledWith("Restored version 2 as version 4.");
    // The restore is not an undo step: the history starts again from it.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("will not restore over unsaved changes, nor restore the newest version onto itself", async () => {
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [v(3, "Latest note"), v(2, "Older note")] });
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    const latest = (await screen.findByText("Latest note")).closest("li") as HTMLElement;
    const older = (await screen.findByText("Older note")).closest("li") as HTMLElement;
    expect(within(latest).getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(within(older).getByRole("button", { name: "Restore" })).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: "Canvas" }));
    await user.click(within(screen.getByLabelText("Stages")).getByRole("button", { name: "End" }));
    await user.click(screen.getByRole("tab", { name: "Versions" }));

    // (The panel was unmounted while on the canvas, so find the row again.)
    const olderAgain = (await screen.findByText("Older note")).closest("li") as HTMLElement;
    expect(within(olderAgain).getByRole("button", { name: "Restore" })).toBeDisabled();
    expect(screen.getByText(/Save or undo your changes first/)).toBeInTheDocument();
  });

  it("says so when a version cannot be opened or restored", async () => {
    vi.mocked(api.listWorkflowVersions).mockResolvedValue({ versions: [v(3, "Latest note"), v(2, "Older note")] });
    vi.mocked(api.getWorkflowVersion).mockRejectedValue(new Error("gone"));
    vi.mocked(api.restoreWorkflowVersion).mockRejectedValue(new Error("gone"));
    renderDesigner({ initial: open(), workflowId: "wf-1" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    const older = (await screen.findByText("Older note")).closest("li") as HTMLElement;

    await user.click(within(older).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open that version."));
    await user.click(within(older).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't restore that version."));
    expect(screen.getByTestId("version-label")).not.toHaveTextContent("Unsaved");
  });
});

describe("validation answers that cannot be trusted", () => {
  it("does not call the workflow valid when the answer could not be read", async () => {
    // A body the client cannot make sense of falls back to "nothing parsed, no problems".
    vi.mocked(api.validateWorkflow).mockResolvedValue({ parsed: false, valid: false, issues: [] });
    renderDesigner({ initial: initialFor(pilotish(), 3), workflowId: "wf-1" });
    await waitFor(() => expect(screen.getByTestId("validation-status")).toHaveAttribute("data-state", "failed"));
    expect(screen.queryByText("No problems.")).toBeNull();
  });

  it("shows the problems of text the server could not read, instead of nothing", async () => {
    vi.mocked(api.validateWorkflow).mockResolvedValue({ parsed: false, valid: false, issues: [{ message: "yaml: line 3: bad", line: 3 }] });
    renderDesigner({ initial: initialFor(pilotish(), 3), workflowId: "wf-1" });
    await waitFor(() => expect(screen.getByTestId("validation-status")).toHaveAttribute("data-state", "problems"));
    expect(screen.getByText("yaml: line 3: bad")).toBeInTheDocument();
  });
});
