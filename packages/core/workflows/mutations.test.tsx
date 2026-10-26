/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { useCreateWorkflow, useRestoreWorkflowVersion, useSaveWorkflowVersion } from "./mutations";
import { workflowKeys } from "./queries";

afterEach(cleanup);

const written = { workflow: { id: "wf-1" }, version: null };

function setup(api: Partial<Record<keyof ApiClient, unknown>>) {
  setApiInstance(api as unknown as ApiClient);
  const qc = new QueryClient();
  qc.setQueryData(workflowKeys.list("ws-1"), { workflows: [] });
  qc.setQueryData(workflowKeys.detail("ws-1", "wf-1"), {});
  qc.setQueryData(workflowKeys.list("ws-2"), { workflows: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true;
  return { qc, wrapper, invalidated };
}

describe("workflow write hooks", () => {
  it("creating refreshes this workspace's workflow caches and no other", async () => {
    const createWorkflow = vi.fn().mockResolvedValue(written);
    const { wrapper, invalidated } = setup({ createWorkflow });
    const { result } = renderHook(() => useCreateWorkflow("ws-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ definition: "d" });
    });

    expect(createWorkflow).toHaveBeenCalledWith({ definition: "d" });
    expect(invalidated(workflowKeys.list("ws-1"))).toBe(true);
    expect(invalidated(workflowKeys.detail("ws-1", "wf-1"))).toBe(true);
    expect(invalidated(workflowKeys.list("ws-2"))).toBe(false);
  });

  it("saving sends the workflow id and refreshes on success", async () => {
    const saveWorkflowVersion = vi.fn().mockResolvedValue(written);
    const { wrapper, invalidated } = setup({ saveWorkflowVersion });
    const { result } = renderHook(() => useSaveWorkflowVersion("ws-1", "wf-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ definition: "d", base_version: 2 });
    });

    expect(saveWorkflowVersion).toHaveBeenCalledWith("wf-1", { definition: "d", base_version: 2 });
    expect(invalidated(workflowKeys.detail("ws-1", "wf-1"))).toBe(true);
  });

  it("a refused save leaves the caches alone: nothing was written", async () => {
    const saveWorkflowVersion = vi.fn().mockRejectedValue(new Error("409"));
    const { wrapper, invalidated } = setup({ saveWorkflowVersion });
    const { result } = renderHook(() => useSaveWorkflowVersion("ws-1", "wf-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ definition: "d", base_version: 2 }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidated(workflowKeys.detail("ws-1", "wf-1"))).toBe(false);
  });

  it("restoring sends the version number and refreshes", async () => {
    const restoreWorkflowVersion = vi.fn().mockResolvedValue(written);
    const { wrapper, invalidated } = setup({ restoreWorkflowVersion });
    const { result } = renderHook(() => useRestoreWorkflowVersion("ws-1", "wf-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(3);
    });

    expect(restoreWorkflowVersion).toHaveBeenCalledWith("wf-1", 3);
    expect(invalidated(workflowKeys.list("ws-1"))).toBe(true);
  });
});
