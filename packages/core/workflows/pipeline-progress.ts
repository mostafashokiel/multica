import type { WorkflowPipelineChild } from "../types";

/**
 * Sub-issues created within this long of the newest one belong to the same visit to a parallel stage:
 * the leader creates all of a stage's branches in one step. When an issue comes back to the stage after a
 * rejection, the new set is hours later and the first one is left behind.
 */
export const BRANCH_BATCH_WINDOW_MS = 10 * 60 * 1000;

const asTime = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * The branches of an issue's current visit to a parallel stage, from its sub-issues. The leader titles each
 * one "<stage name>: <branch name>", so those are picked out first (all sub-issues are used when none is
 * titled that way), and of those only the newest batch counts.
 */
export function currentBranches(children: readonly WorkflowPipelineChild[], stageName: string): WorkflowPipelineChild[] {
  const titled = children.filter((c) => c.title.startsWith(`${stageName}: `));
  const pool = titled.length > 0 ? titled : children;
  if (pool.length === 0) return [];
  const newest = Math.max(...pool.map((c) => asTime(c.created_at)));
  return pool.filter((c) => newest - asTime(c.created_at) <= BRANCH_BATCH_WINDOW_MS);
}

/** The branch's own name: the title without the "<stage name>: " the leader put in front of it. */
export function branchLabel(child: WorkflowPipelineChild, stageName: string): string {
  const prefix = `${stageName}: `;
  return child.title.startsWith(prefix) && child.title.length > prefix.length ? child.title.slice(prefix.length) : child.title;
}

export interface BranchProgress {
  total: number;
  /** Finished, cancelled ones included: the leader is woken when this reaches `total`. */
  closed: number;
  cancelled: number;
}

export function branchProgress(branches: readonly WorkflowPipelineChild[]): BranchProgress {
  return {
    total: branches.length,
    closed: branches.filter((b) => b.closed).length,
    cancelled: branches.filter((b) => b.cancelled).length,
  };
}
