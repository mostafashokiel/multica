import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { workflowPipelineOptions, workflowSquadsOptions } from "./queries";

vi.mock("../api", () => ({
  api: { getWorkflowPipeline: vi.fn(), listWorkflowSquads: vi.fn() },
}));

afterEach(() => vi.clearAllMocks());

// The app's own client treats every query as fresh forever (see createQueryClient).
const appLikeClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

describe("workflow queries that nothing invalidates", () => {
  it("refetch a pipeline view each time it is opened, even under the app's stale-never default", async () => {
    vi.mocked(api.getWorkflowPipeline).mockResolvedValue({} as never);
    const qc = appLikeClient();

    await qc.fetchQuery(workflowPipelineOptions("ws", "wf-1", { squad: "sq-1" }));
    await qc.fetchQuery(workflowPipelineOptions("ws", "wf-1", { squad: "sq-1" }));

    expect(api.getWorkflowPipeline).toHaveBeenCalledTimes(2);
  });

  it("keep each squad filter in its own cache entry", () => {
    const a = workflowPipelineOptions("ws", "wf-1", { squad: "" }).queryKey;
    const b = workflowPipelineOptions("ws", "wf-1", { squad: "sq-1" }).queryKey;
    expect(a).not.toEqual(b);
  });

  it("refetch the squads that follow a workflow each time it is opened", async () => {
    vi.mocked(api.listWorkflowSquads).mockResolvedValue({ squads: [] });
    const qc = appLikeClient();

    await qc.fetchQuery(workflowSquadsOptions("ws", "wf-1"));
    await qc.fetchQuery(workflowSquadsOptions("ws", "wf-1"));

    expect(api.listWorkflowSquads).toHaveBeenCalledTimes(2);
  });
});
