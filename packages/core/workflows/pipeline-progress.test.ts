import { describe, expect, it } from "vitest";
import type { WorkflowPipelineChild } from "../types";
import { BRANCH_BATCH_WINDOW_MS, branchLabel, branchProgress, currentBranches } from "./pipeline-progress";

const T0 = Date.parse("2026-10-10T21:00:00Z");
const child = (title: string, offsetMs: number, over: Partial<WorkflowPipelineChild> = {}): WorkflowPipelineChild => ({
  id: title,
  identifier: "ACM-1",
  title,
  status: "todo",
  created_at: new Date(T0 + offsetMs).toISOString(),
  closed: false,
  cancelled: false,
  ...over,
});

describe("currentBranches", () => {
  it("picks the sub-issues the leader titled for this stage, not those of another stage", () => {
    const kids = [child("Design: Threat model", 0), child("Design: Test strategy", 1000), child("Verification: Security scan", 3600_000)];
    expect(currentBranches(kids, "Design").map((c) => c.title)).toEqual(["Design: Threat model", "Design: Test strategy"]);
    expect(currentBranches(kids, "Verification").map((c) => c.title)).toEqual(["Verification: Security scan"]);
  });

  it("keeps only the newest batch when the stage was visited again after a rejection", () => {
    const first = [child("Design: A", 0), child("Design: B", 2000)];
    const again = [child("Design: A", 5 * 3600_000), child("Design: B", 5 * 3600_000 + 3000)];
    expect(currentBranches([...first, ...again], "Design").map((c) => c.created_at)).toEqual(again.map((c) => c.created_at));
  });

  it("counts creations within the window as one batch, and the first beyond it as another", () => {
    const kids = [child("Design: A", 0), child("Design: B", BRANCH_BATCH_WINDOW_MS), child("Design: C", BRANCH_BATCH_WINDOW_MS + 1)];
    expect(currentBranches(kids, "Design").map((c) => c.title)).toEqual(["Design: B", "Design: C"]);
  });

  it("falls back to all sub-issues when none carries the stage's title", () => {
    const kids = [child("check NYC", 0), child("check Cairo", 1000)];
    expect(currentBranches(kids, "Design")).toHaveLength(2);
  });

  it("is empty for an issue with no sub-issues, and tolerates a date it cannot read", () => {
    expect(currentBranches([], "Design")).toEqual([]);
    expect(currentBranches([child("Design: A", 0, { created_at: "garbage" })], "Design")).toHaveLength(1);
  });
});

describe("branchLabel and branchProgress", () => {
  it("drops the stage prefix from a branch's title, only when something is left", () => {
    expect(branchLabel(child("Design: Threat model", 0), "Design")).toBe("Threat model");
    expect(branchLabel(child("Design: ", 0), "Design")).toBe("Design: ");
    expect(branchLabel(child("Other thing", 0), "Design")).toBe("Other thing");
  });

  it("counts finished branches, cancelled ones among them", () => {
    const kids = [child("a", 0, { closed: true }), child("b", 0, { closed: true, cancelled: true }), child("c", 0)];
    expect(branchProgress(kids)).toEqual({ total: 3, closed: 2, cancelled: 1 });
    expect(branchProgress([])).toEqual({ total: 0, closed: 0, cancelled: 0 });
  });
});
