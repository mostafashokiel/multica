import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { addStage, connect, emptyDefinition, renameStage, updateMetadata, updateStage, type WorkflowDefinition } from "@multica/core/workflows";
import { renderWithI18n } from "../../test/i18n";
import WorkflowDiagram from "./workflow-diagram";
import { sizeOf } from "./flow";
import { installFlowMocks } from "../../test/flow";
import { autoLayout } from "@multica/core/workflows";

vi.mock("@multica/ui/components/common/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

beforeAll(installFlowMocks);

afterEach(cleanup);

function sample(): WorkflowDefinition {
  let d = updateMetadata(emptyDefinition(), { id: "demo" });
  const add = (type: Parameters<typeof addStage>[1], id: string) => {
    const a = addStage(d, type);
    const r = renameStage(a.definition, a.id, id);
    if (!r.ok) throw new Error(r.reason);
    d = r.definition;
  };
  add("agent", "build");
  add("human_gate", "review");
  add("condition", "check");
  add("end", "done");
  d = updateStage(d, "build", { name: "Build it", agent: "builder" });
  d = updateStage(d, "review", { approvers: "qa", max_rework: 3, escalate_after_hours: 24 });
  d = updateStage(d, "check", { when: 'has_label("x")' });
  d = connect(d, "build", "next", "review");
  d = connect(d, "review", "approve", "check");
  d = connect(d, "review", "reject", "build");
  d = connect(d, "check", "then", "done");
  d = connect(d, "check", "else", "done");
  return d;
}

function render(def: WorkflowDefinition, problems?: Record<string, number>) {
  return renderWithI18n(
    <WorkflowDiagram
      definition={def}
      positions={autoLayout(def, sizeOf)}
      {...(problems === undefined ? {} : { problemsByStage: problems })}
    />,
  );
}

describe("WorkflowDiagram", () => {
  it("marks each stage with the icon of its type, and hides it from assistive technology", async () => {
    render(sample());

    const expected: Record<string, string> = { build: "agent", review: "human_gate", check: "condition", done: "end" };
    await screen.findByText("check");
    for (const [id, type] of Object.entries(expected)) {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
      const icons = node.querySelectorAll("[data-stage-icon]");
      expect(icons, id).toHaveLength(1);
      expect(icons[0]?.getAttribute("data-stage-icon"), id).toBe(type);
      expect(icons[0]?.getAttribute("aria-hidden"), id).toBe("true");
    }
  });

  it("draws a condition as a diamond and every other stage as a box", async () => {
    render(sample());

    const check = (await screen.findByText("check")).closest("[data-id]") as HTMLElement;
    const shape = check.querySelector('[data-shape="diamond"]');
    expect(shape).not.toBeNull();
    // Four corners at the middle of each side: a diamond, not a rectangle.
    expect(shape!.querySelector("polygon")?.getAttribute("points")).toBe("50,0 100,50 50,100 0,50");
    // The expression is still readable on it, and the outcomes leave from its left and right points.
    expect(within(check).getByText('has_label("x")')).toBeInTheDocument();
    expect(check.querySelector('[data-handleid="then"]')).not.toBeNull();
    expect(check.querySelector('[data-handleid="else"]')).not.toBeNull();

    for (const id of ["build", "review", "done"]) {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
      expect(node.querySelector('[data-shape="diamond"]'), id).toBeNull();
    }
  });

  it("marks a condition's problems on the diamond's outline", async () => {
    render(sample(), { check: 2 });

    const check = (await screen.findByText("check")).closest("[data-id]") as HTMLElement;
    expect(check.querySelector("polygon")?.getAttribute("class")).toContain("stroke-destructive");
    expect(within(check).getByText("! 2")).toBeInTheDocument();
  });

  it("draws every stage with its type, name and the detail that matters", async () => {
    render(sample());

    const build = await screen.findByText("Build it");
    const node = build.closest("[data-id]") as HTMLElement;
    expect(within(node).getByText("Agent")).toBeInTheDocument();
    expect(within(node).getByText("build")).toBeInTheDocument(); // the id under a custom name
    expect(within(node).getByText("builder")).toBeInTheDocument();
    expect(within(node).getByText("Start")).toBeInTheDocument();

    const gate = (await screen.findByText("review")).closest("[data-id]") as HTMLElement;
    expect(within(gate).getByText("Human gate")).toBeInTheDocument();
    expect(within(gate).getByText("Approvers: qa")).toBeInTheDocument();
    expect(within(gate).getByText("Max rework 3 · Escalates after 24 h")).toBeInTheDocument();

    const cond = (await screen.findByText("check")).closest("[data-id]") as HTMLElement;
    expect(within(cond).getByText('has_label("x")')).toBeInTheDocument();
    expect(await screen.findByText("done")).toBeInTheDocument();
  });

  it("draws one edge per connection, and says what each one is", async () => {
    const { container } = render(sample());
    await screen.findByText("Build it");
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge").length).toBe(5));
    const labels = [...container.querySelectorAll(".react-flow__edge-text")].map((n) => n.textContent);
    expect(labels.sort()).toEqual(["approve", "else", "reject", "then"]);
  });

  it("marks the stages the server reported problems on", async () => {
    render(sample(), { review: 2 });
    const gate = (await screen.findByText("review")).closest("[data-id]") as HTMLElement;
    expect(within(gate).getByText("! 2")).toBeInTheDocument();
    const build = (await screen.findByText("Build it")).closest("[data-id]") as HTMLElement;
    expect(within(build).queryByText(/^! /)).toBeNull();
  });

  it("draws server text as text, never as markup", async () => {
    let d = sample();
    d = updateStage(d, "build", { name: '<img src=x onerror="alert(1)">', agent: "<script>alert(2)</script>" });
    const { container } = render(d);
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText("<script>alert(2)</script>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("is read-only: nodes cannot be dragged or connected", async () => {
    const { container } = render(sample());
    await screen.findByText("Build it");
    expect(container.querySelector(".react-flow__node.draggable")).toBeNull();
    expect(container.querySelector(".react-flow__handle.connectable")).toBeNull();
  });

  it("lists the stages and transitions for a screen reader", async () => {
    const { container } = render(sample());
    await screen.findByText("Build it");
    const list = container.querySelector("ul.sr-only") as HTMLElement;
    expect(within(list).getByText("Build it leads to review")).toBeInTheDocument();
    expect(within(list).getByText("review leads to build")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Workflow diagram with 4 stages" })).toBeInTheDocument();
  });
});
