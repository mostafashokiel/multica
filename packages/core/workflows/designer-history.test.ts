import { describe, expect, it } from "vitest";
import {
  MAX_UNDO_STEPS,
  canRedo,
  canUndo,
  commit,
  createHistory,
  currentSnapshot,
  redo,
  replacePresent,
  undo,
  type History,
} from "./designer-history";
import { emptyDefinition } from "./designer-model";

const snap = (owner: string) => ({
  definition: { ...emptyDefinition(), metadata: { id: "", version: 1, owner } },
  positions: {},
});
const owner = (h: History) => currentSnapshot(h).definition.metadata.owner;

describe("history", () => {
  it("undoes and redoes in order", () => {
    let h = createHistory(snap("a"));
    h = commit(h, snap("b"), { now: 0 });
    h = commit(h, snap("c"), { now: 0 });
    expect(canUndo(h) && owner(undo(h))).toBe("b");
    expect(owner(undo(undo(h)))).toBe("a");
    expect(owner(redo(undo(undo(h))))).toBe("b");
    expect(canRedo(undo(h))).toBe(true);
  });

  it("does nothing when there is nothing to undo or redo", () => {
    const h = createHistory(snap("a"));
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
    expect(canUndo(h)).toBe(false);
  });

  it("a new change drops the redo stack", () => {
    let h = commit(createHistory(snap("a")), snap("b"), { now: 0 });
    h = undo(h);
    h = commit(h, snap("c"), { now: 0 });
    expect(canRedo(h)).toBe(false);
  });

  it("merges a burst of edits to one field into a single step", () => {
    let h = createHistory(snap("a"));
    for (const [i, value] of ["b", "bc", "bcd"].entries()) h = commit(h, snap(value), { mergeKey: "owner", now: i * 200 });
    expect(owner(h)).toBe("bcd");
    expect(owner(undo(h))).toBe("a");
    expect(canUndo(undo(h))).toBe(false);
  });

  it("does not merge across keys or after a pause", () => {
    let h = createHistory(snap("a"));
    h = commit(h, snap("b"), { mergeKey: "x", now: 0 });
    h = commit(h, snap("c"), { mergeKey: "y", now: 100 });
    h = commit(h, snap("d"), { mergeKey: "y", now: 5000 });
    expect(owner(undo(undo(undo(h))))).toBe("a");
  });

  it("an undone step is not merged into by the next edit", () => {
    let h = commit(createHistory(snap("a")), snap("b"), { mergeKey: "k", now: 0 });
    h = undo(h);
    h = commit(h, snap("z"), { mergeKey: "k", now: 100 });
    expect(owner(undo(h))).toBe("a");
  });

  it("keeps at least 50 steps and caps memory", () => {
    let h = createHistory(snap("0"));
    for (let i = 1; i <= MAX_UNDO_STEPS + 40; i++) h = commit(h, snap(String(i)), { now: 0 });
    let steps = 0;
    while (canUndo(h)) {
      h = undo(h);
      steps++;
    }
    expect(steps).toBe(MAX_UNDO_STEPS);
    expect(MAX_UNDO_STEPS).toBeGreaterThanOrEqual(50);
  });

  it("replacePresent swaps the snapshot without adding an undo step", () => {
    let h = commit(createHistory(snap("a")), snap("b"), { now: 0 });
    h = replacePresent(h, snap("loaded"));
    expect(owner(h)).toBe("loaded");
    expect(owner(undo(h))).toBe("a");
    expect(h.past).toHaveLength(1);
  });
});
