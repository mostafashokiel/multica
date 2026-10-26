/** @vitest-environment jsdom */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { createQueryClient } from "../query-client";
import { workflowKeys } from "../workflows/queries";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));
vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Queries default to staleTime: Infinity, so a workflow page only moves when
// something invalidates it. All three workflow events must reach every cached
// projection (list, detail, versions, audit) of the current workspace.
it.each(["workflow:created", "workflow:updated", "workflow:version_created"] as const)(
  "invalidates the workspace's workflow caches on %s",
  async (type) => {
    const qc = createQueryClient();
    let onAny: ((msg: { type: string }) => void) | undefined;
    const ws = {
      on: () => () => {},
      onAny: (handler: (msg: { type: string }) => void) => {
        onAny = handler;
        return () => {};
      },
      onReconnect: () => () => {},
    } as unknown as WSClient;
    const stores = {
      authStore: { getState: () => ({ user: { id: "u1" } }) },
    } as unknown as RealtimeSyncStores;
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }

    qc.setQueryData(workflowKeys.list("ws-1"), { workflows: [] });
    qc.setQueryData(workflowKeys.detail("ws-1", "wf-1"), {});
    qc.setQueryData(workflowKeys.versions("ws-1", "wf-1"), {});
    qc.setQueryData(workflowKeys.audit("ws-1", "wf-1"), {});
    qc.setQueryData(workflowKeys.list("ws-2"), { workflows: [] });

    renderHook(() => useRealtimeSync(ws, stores), { wrapper: Wrapper });
    act(() => {
      onAny?.({ type });
      vi.advanceTimersByTime(150);
    });

    expect(qc.getQueryState(workflowKeys.list("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(workflowKeys.detail("ws-1", "wf-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(workflowKeys.versions("ws-1", "wf-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(workflowKeys.audit("ws-1", "wf-1"))?.isInvalidated).toBe(true);
    // Another workspace's cache is not this client's business.
    expect(qc.getQueryState(workflowKeys.list("ws-2"))?.isInvalidated).toBe(false);
  },
);
