import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import type { Workflow } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { WorkflowsPage } from "./workflows-page";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { listWorkflows: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    workflows: () => "/acme/workflows",
    workflowNew: () => "/acme/workflows/new",
    workflowDetail: (id: string) => `/acme/workflows/${id}`,
  }),
}));
const member = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: member.role, userId: "u", member: null, isLoading: false }),
}));

const push = vi.fn();

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    key: "sdlc-pilot",
    name: "SDLC pilot",
    description: "BRD to architecture",
    status: "active",
    latest_version: 3,
    revision: 4,
    created_by_type: "member",
    created_by_id: "u-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider
        value={{
          pathname: "/acme/workflows",
          searchParams: new URLSearchParams(),
          hash: "",
          push,
          replace: vi.fn(),
          back: vi.fn(),
          getShareableUrl: (v) => v,
        }}
      >
        <WorkflowsPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  push.mockReset();
  member.role = "owner";
  vi.mocked(api.listWorkflows).mockReset();
});

afterEach(cleanup);

describe("WorkflowsPage", () => {
  it("lists workflows with key, version and status", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflow()] });
    renderPage();

    const row = (await screen.findByText("SDLC pilot")).closest("[role=row]") as HTMLElement;
    expect(within(row).getByText("BRD to architecture")).toBeInTheDocument();
    expect(within(row).getByText("sdlc-pilot")).toBeInTheDocument();
    expect(within(row).getByText("Version 3")).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
  });

  it("opens the workflow when its row is clicked", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflow()] });
    renderPage();

    (await screen.findByText("SDLC pilot")).click();

    expect(push).toHaveBeenCalledWith("/acme/workflows/wf-1");
  });

  it("offers owners and admins a way to create the first workflow", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [] });
    renderPage();

    expect(await screen.findByText("No workflows yet.")).toBeInTheDocument();
    expect(screen.getByText(/Create the first one in the designer/)).toBeInTheDocument();
    // The header action and the empty state's own button.
    const buttons = screen.getAllByRole("button", { name: "New workflow" });
    expect(buttons.length).toBeGreaterThan(0);
    buttons[buttons.length - 1]!.click();
    expect(push).toHaveBeenCalledWith("/acme/workflows/new");
  });

  it("tells anyone else to ask an owner or admin, and offers no create button", async () => {
    member.role = "member";
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [] });
    renderPage();

    expect(await screen.findByText("No workflows yet.")).toBeInTheDocument();
    expect(screen.getByText(/Ask a workspace owner or admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
  });

  it("puts New workflow in the header for owners and admins only", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [workflow()] });
    for (const [role, shown] of [["owner", true], ["admin", true], ["member", false]] as const) {
      member.role = role;
      const view = renderPage();
      await screen.findByText("SDLC pilot");
      expect(screen.queryByRole("button", { name: "New workflow" }) !== null, role).toBe(shown);
      view.unmount();
    }
  });

  it("offers no create button when the list could not be loaded", async () => {
    vi.mocked(api.listWorkflows).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage();
    await screen.findByText("Couldn't load workflows.");
    expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
  });

  it("says the feature is off, not that loading failed, on a 403", async () => {
    vi.mocked(api.listWorkflows).mockRejectedValue(
      new ApiError("workflows are not enabled", 403, "Forbidden", { code: "workflows_disabled" }),
    );
    renderPage();

    expect(await screen.findByText("Workflows are not enabled")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load workflows.")).toBeNull();
  });

  it("shows a load failure for any other error", async () => {
    vi.mocked(api.listWorkflows).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage();

    expect(await screen.findByText("Couldn't load workflows.")).toBeInTheDocument();
  });

  it("renders server-provided text as text, never as markup", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({
      workflows: [
        workflow({
          name: '<img src=x onerror="alert(1)">',
          description: "<script>alert(2)</script>",
        }),
      ],
    });
    const { container } = renderPage();

    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText("<script>alert(2)</script>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
