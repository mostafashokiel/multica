import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { Workflow, WorkflowVersion } from "@multica/core/types";
import { workflowKeys } from "@multica/core/workflows";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowDesignerPage } from "./workflow-designer-page";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { getWorkflow: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
const member = vi.hoisted(() => ({ role: "owner" as string | null, loading: false }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: member.role, userId: "u", member: null, isLoading: member.loading }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    workflows: () => "/acme/workflows",
    workflowDetail: (id: string) => `/acme/workflows/${id}`,
    workflowEdit: (id: string) => `/acme/workflows/${id}/edit`,
  }),
}));
// The canvas has its own tests; here only what the page hands the designer matters.
type StubProps = { workflowId: string | null; initial: { definition: { metadata: { id: string }; stages: unknown[] }; positions: Record<string, unknown>; version: number }; onCreated: (id: string) => void };
vi.mock("../designer/workflow-designer", () => ({
  default: (props: StubProps) => (
    <div
      data-testid="designer"
      data-workflow-id={props.workflowId ?? ""}
      data-version={props.initial.version}
      data-key={props.initial.definition.metadata.id}
      data-stages={props.initial.definition.stages.length}
      data-positions={Object.keys(props.initial.positions).length}
    >
      <button onClick={() => props.onCreated("wf-created")}>created</button>
    </div>
  ),
}));

const replace = vi.fn();

const workflow: Workflow = {
  id: "wf-1", key: "demo", name: "Demo flow", description: "", status: "active", latest_version: 2, revision: 3,
  created_by_type: "member", created_by_id: "u", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

const DEFINITION = `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: demo
  version: 2
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

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return { id: "v2", workflow_id: "wf-1", version: 2, content_hash: "h", note: "", created_by_type: "member", created_by_id: "u", created_at: "", definition: DEFINITION, ...overrides };
}

let client: QueryClient;
function renderPage(pathname: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider
        value={{ pathname, searchParams: new URLSearchParams(), hash: "", push: vi.fn(), replace, back: vi.fn(), getShareableUrl: (v) => v }}
      >
        <WorkflowDesignerPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getWorkflow).mockReset();
  replace.mockReset();
  member.role = "owner";
  member.loading = false;
});
afterEach(cleanup);

describe("WorkflowDesignerPage", () => {
  it("opens an empty designer for a new workflow, without loading anything", async () => {
    renderPage("/acme/workflows/new");
    const designer = await screen.findByTestId("designer");
    expect(designer).toHaveAttribute("data-workflow-id", "");
    expect(designer).toHaveAttribute("data-version", "0");
    expect(designer).toHaveAttribute("data-stages", "0");
    expect(api.getWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "New workflow" })).toBeInTheDocument();
  });

  it("moves to the edit URL once the first version is saved", async () => {
    renderPage("/acme/workflows/new");
    (await screen.findByRole("button", { name: "created" })).click();
    expect(replace).toHaveBeenCalledWith("/acme/workflows/wf-created/edit");
  });

  it("loads a workflow for editing: its newest version, laid out", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version() });
    renderPage("/acme/workflows/wf-1/edit");

    const designer = await screen.findByTestId("designer");
    expect(api.getWorkflow).toHaveBeenCalledWith("wf-1");
    expect(designer).toHaveAttribute("data-workflow-id", "wf-1");
    expect(designer).toHaveAttribute("data-version", "2");
    expect(designer).toHaveAttribute("data-key", "demo");
    expect(designer).toHaveAttribute("data-stages", "2");
    expect(designer).toHaveAttribute("data-positions", "2");
    expect(screen.getByRole("heading", { name: "Edit workflow" })).toBeInTheDocument();
  });

  it("is not reset by a refetch: the designer owns the edits once it has the workflow", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version() });
    renderPage("/acme/workflows/wf-1/edit");
    await screen.findByTestId("designer");

    act(() => {
      client.setQueryData(workflowKeys.detail("ws", "wf-1"), { workflow: { ...workflow, latest_version: 9 }, version: version({ version: 9, definition: DEFINITION.replace("id: demo", "id: other") }) });
    });

    const designer = screen.getByTestId("designer");
    expect(designer).toHaveAttribute("data-version", "2");
    expect(designer).toHaveAttribute("data-key", "demo");
  });

  it("refuses anyone who is not an owner or admin, and does not load the workflow for them", async () => {
    member.role = "member";
    renderPage("/acme/workflows/wf-1/edit");
    expect(await screen.findByText("You can't edit workflows")).toBeInTheDocument();
    expect(screen.queryByTestId("designer")).toBeNull();
    expect(api.getWorkflow).not.toHaveBeenCalled();
    cleanup();

    renderPage("/acme/workflows/new");
    expect(await screen.findByText("You can't edit workflows")).toBeInTheDocument();
  });

  it("does not decide while the role is still loading", () => {
    member.role = null;
    member.loading = true;
    renderPage("/acme/workflows/new");
    expect(screen.queryByText("You can't edit workflows")).toBeNull();
    expect(screen.queryByTestId("designer")).toBeNull();
  });

  it("will not open an archived workflow", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow: { ...workflow, status: "archived" }, version: version() });
    renderPage("/acme/workflows/wf-1/edit");
    expect(await screen.findByText("This workflow is archived, so it can't be edited.")).toBeInTheDocument();
    expect(screen.queryByTestId("designer")).toBeNull();
  });

  it("says so when the version cannot be read instead of opening an empty designer", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ workflow, version: version({ definition: "a: [" }) });
    renderPage("/acme/workflows/wf-1/edit");
    expect(await screen.findByText(/couldn't be read, so it can't be opened/)).toBeInTheDocument();
    expect(screen.queryByTestId("designer")).toBeNull();
  });

  it("reports a missing workflow, a disabled feature and a load failure", async () => {
    vi.mocked(api.getWorkflow).mockRejectedValue(new ApiError("nope", 404, "Not Found"));
    const first = renderPage("/acme/workflows/wf-1/edit");
    expect(await screen.findByText("This workflow doesn't exist.")).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getWorkflow).mockRejectedValue(new ApiError("off", 403, "Forbidden", { code: "workflows_disabled" }));
    const second = renderPage("/acme/workflows/wf-1/edit");
    expect(await screen.findByText("Workflows are not enabled")).toBeInTheDocument();
    second.unmount();

    vi.mocked(api.getWorkflow).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage("/acme/workflows/wf-1/edit");
    await waitFor(() => expect(screen.getByText("Couldn't load this workflow.")).toBeInTheDocument());
  });
});
