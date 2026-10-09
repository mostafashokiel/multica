import type { WorkflowDefinition } from "./definition";
import type { Positions } from "./designer-model";

/** Everything an undo step restores: the definition and where its stages are drawn. */
export interface Snapshot {
  definition: WorkflowDefinition;
  positions: Positions;
}

interface Entry {
  snapshot: Snapshot;
  mergeKey: string | undefined;
  at: number;
}

export interface History {
  past: Entry[];
  present: Entry;
  future: Entry[];
}

/** At least 50 steps are kept; a few more cost nothing. */
export const MAX_UNDO_STEPS = 100;
/** Consecutive edits with the same merge key within this time count as one step. */
export const MERGE_WINDOW_MS = 1000;

export function createHistory(snapshot: Snapshot, now = 0): History {
  return { past: [], present: { snapshot, mergeKey: undefined, at: now }, future: [] };
}

export function currentSnapshot(history: History): Snapshot {
  return history.present.snapshot;
}

/**
 * Record a change. Typing in one field passes the same `mergeKey`, so a burst of keystrokes is
 * one undo step. Any new change drops the redo stack.
 */
export function commit(history: History, snapshot: Snapshot, options: { mergeKey?: string; now?: number } = {}): History {
  const now = options.now ?? Date.now();
  const { mergeKey } = options;
  const last = history.present;
  if (mergeKey !== undefined && last.mergeKey === mergeKey && now - last.at <= MERGE_WINDOW_MS) {
    return { ...history, present: { snapshot, mergeKey, at: now }, future: [] };
  }
  const past = [...history.past, last].slice(-MAX_UNDO_STEPS);
  return { past, present: { snapshot, mergeKey, at: now }, future: [] };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: { ...previous, mergeKey: undefined }, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: { ...next, mergeKey: undefined }, future: rest };
}

/** Replace the present snapshot without an undo step (loading, restoring, first layout). */
export function replacePresent(history: History, snapshot: Snapshot): History {
  return { ...history, present: { ...history.present, snapshot, mergeKey: undefined } };
}
