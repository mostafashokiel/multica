"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createWorkspaceAwareStorage,
  registerForWorkspaceRehydration,
} from "../platform/workspace-storage";
import { defaultStorage } from "../platform/storage";

// Which workflow the Pipeline page opens on when the URL names none. Persisted per
// workspace and per device, so the page comes back to the workflow you last looked
// at instead of the first one in the list. The squad filter is deliberately not
// stored: it lives in the URL only, so a shared link shows what its sender saw.
interface PipelineViewState {
  /** The key of the workflow last chosen; "" when none was. */
  workflow: string;
  setWorkflow: (workflow: string) => void;
}

export const usePipelineViewStore = create<PipelineViewState>()(
  persist(
    (set) => ({
      workflow: "",
      setWorkflow: (workflow) => set({ workflow }),
    }),
    {
      name: "multica_workflow_pipeline_view",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
      partialize: (state) => ({ workflow: state.workflow }),
      // A workspace with nothing stored starts from the default, not from the
      // previous workspace's choice still held in memory.
      merge: (persisted, current) => {
        if (!persisted) return { ...current, workflow: "" };
        return { ...current, ...(persisted as Partial<PipelineViewState>) };
      },
    },
  ),
);

registerForWorkspaceRehydration(() => usePipelineViewStore.persist.rehydrate());
