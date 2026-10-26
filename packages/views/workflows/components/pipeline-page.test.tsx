import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import { usePipelineViewStore } from "@multica/core/workflows";
import type { Squad, Workflow, WorkflowPipeline } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { PipelinePage } from "./pipeline-page";

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: { listWorkflows: vi.fn(), listSquads: vi.fn(), getWorkflowPipeline: vi.fn() },
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => `${type} ${id}` }),
}));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (key: string) => key }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));

const workflow = (id: string, key: string, name: string): Workflow =>
  ({
    id,
    key,
    name,
    description: "",
    status: "active",
    latest_version: 1,
    revision: 1,
    created_by_type: "member",
    created_by_id: "u",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }) as Workflow;

const squad = (id: string, name: string, archived = false): Squad =>
  ({ id, name, archived_at: archived ? "2026-01-01T00:00:00Z" : null }) as Squad;

const pipeline = (key: string): WorkflowPipeline => ({
  workflow_key: key,
  version: 1,
  stages: [{ id: "build", name: `Build of ${key}`, type: "agent", approvers: [], issues: [] }],
  no_stage: [],
  conflicting: [],
  unknown_stage: [],
  total: 1,
  truncated: false,
});

const replace = vi.fn();

function renderPage(search = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider
        value={{
          pathname: "/acme/pipeline",
          searchParams: new URLSearchParams(search),
          hash: "",
          push: vi.fn(),
          replace,
          back: vi.fn(),
          getShareableUrl: (v) => v,
        }}
      >
        <PipelinePage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePipelineViewStore.setState({ workflow: "" });
  replace.mockReset();
  vi.mocked(api.listWorkflows).mockReset().mockResolvedValue({
    workflows: [workflow("wf-1", "sdlc-pilot", "SDLC pilot"), workflow("wf-2", "triage", "Support triage")],
  } as never);
  vi.mocked(api.listSquads)
    .mockReset()
    .mockResolvedValue([squad("sq-1", "Delivery"), squad("sq-2", "Support"), squad("sq-old", "Old squad", true)]);
  vi.mocked(api.getWorkflowPipeline)
    .mockReset()
    .mockImplementation(async (id: string) => pipeline(id === "wf-2" ? "triage" : "sdlc-pilot"));
});
afterEach(cleanup);

describe("PipelinePage", () => {
  it("shows the first workflow's pipeline, unfiltered, when the URL says nothing", async () => {
    renderPage();

    expect(await screen.findByRole("region", { name: "Build of sdlc-pilot" })).toBeInTheDocument();
    expect(api.getWorkflowPipeline).toHaveBeenCalledWith("wf-1", { squad: "" });
    expect(screen.getByLabelText("Workflow")).toHaveTextContent("SDLC pilot");
    expect(screen.getByLabelText("Squad")).toHaveTextContent("All squads");
  });

  it("opens on the workflow last chosen when the URL names none, and remembers a new choice", async () => {
    usePipelineViewStore.setState({ workflow: "triage" });
    renderPage();
    const user = userEvent.setup();

    expect(await screen.findByRole("region", { name: "Build of triage" })).toBeInTheDocument();

    await user.click(screen.getByLabelText("Workflow"));
    await user.click(await screen.findByRole("option", { name: "SDLC pilot" }));
    expect(usePipelineViewStore.getState().workflow).toBe("sdlc-pilot");
  });

  it("falls back to the first workflow when the remembered one is gone", async () => {
    usePipelineViewStore.setState({ workflow: "deleted-flow" });
    renderPage();

    expect(await screen.findByRole("region", { name: "Build of sdlc-pilot" })).toBeInTheDocument();
  });

  it("takes the workflow and the squad from the URL", async () => {
    renderPage("workflow=triage&squad=sq-2");

    expect(await screen.findByRole("region", { name: "Build of triage" })).toBeInTheDocument();
    expect(api.getWorkflowPipeline).toHaveBeenCalledWith("wf-2", { squad: "sq-2" });
    expect(screen.getByLabelText("Squad")).toHaveTextContent("Support");
  });

  it("offers every active squad and 'not assigned to a squad', but not an archived squad", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Build of sdlc-pilot" });

    await user.click(screen.getByLabelText("Squad"));

    expect(await screen.findByRole("option", { name: "Delivery" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Support" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Not assigned to a squad" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Old squad" })).toBeNull();
  });

  it("keeps the choices in the URL, one at a time", async () => {
    renderPage("workflow=triage");
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Build of triage" });

    await user.click(screen.getByLabelText("Squad"));
    await user.click(await screen.findByRole("option", { name: "Delivery" }));
    expect(replace).toHaveBeenLastCalledWith("/acme/pipeline?workflow=triage&squad=sq-1");

    await user.click(screen.getByLabelText("Squad"));
    await user.click(await screen.findByRole("option", { name: "Not assigned to a squad" }));
    expect(replace).toHaveBeenLastCalledWith("/acme/pipeline?workflow=triage&squad=none");

    await user.click(screen.getByLabelText("Workflow"));
    await user.click(await screen.findByRole("option", { name: "SDLC pilot" }));
    expect(replace).toHaveBeenLastCalledWith("/acme/pipeline?workflow=sdlc-pilot");
  });

  it("clears the squad filter when 'All squads' is chosen", async () => {
    renderPage("workflow=sdlc-pilot&squad=sq-1");
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Build of sdlc-pilot" });

    await user.click(screen.getByLabelText("Squad"));
    await user.click(await screen.findByRole("option", { name: "All squads" }));

    expect(replace).toHaveBeenLastCalledWith("/acme/pipeline?workflow=sdlc-pilot");
  });

  it("ignores a squad in the URL that does not exist", async () => {
    renderPage("squad=gone");

    await screen.findByRole("region", { name: "Build of sdlc-pilot" });
    expect(api.getWorkflowPipeline).toHaveBeenCalledWith("wf-1", { squad: "" });
    expect(screen.getByLabelText("Squad")).toHaveTextContent("All squads");
  });

  it("says so when the workspace has no workflow", async () => {
    vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [] } as never);
    renderPage();

    expect(await screen.findByText("No workflows yet. Create one to see its pipeline here.")).toBeInTheDocument();
    expect(api.getWorkflowPipeline).not.toHaveBeenCalled();
  });

  it("says the feature is off, or that it could not load", async () => {
    vi.mocked(api.listWorkflows).mockRejectedValue(
      new ApiError("off", 403, "Forbidden", { code: "workflows_disabled" }),
    );
    renderPage();
    expect(await screen.findByText("Workflows are not enabled")).toBeInTheDocument();
    cleanup();

    vi.mocked(api.listWorkflows).mockRejectedValue(new ApiError("boom", 500, "Server Error"));
    renderPage();
    await waitFor(() => expect(screen.getByText("Couldn't load workflows.")).toBeInTheDocument());
  });
});
