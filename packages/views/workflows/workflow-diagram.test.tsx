// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../test/i18n";
import { WorkflowDiagram, type DiagramNode } from "./workflow-diagram";

const node = (id: string, over: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  label: id.toUpperCase(),
  icon: <span aria-hidden>*</span>,
  ...over,
});

// A builds, then B reviews and can send it back to A; C is a person's step; D is the end.
const nodes: DiagramNode[] = [
  node("a", { who: "Builder", next: "b" }),
  node("b", { who: "Reviewer", next: "d", back: "a" }),
  node("c", { who: "Ada" }),
  node("d"),
];

afterEach(cleanup);

function edges() {
  const all = [...document.querySelectorAll<SVGPathElement>('svg path[stroke="currentColor"]')];
  return {
    forward: all.filter((p) => !p.hasAttribute("stroke-dasharray")),
    back: all.filter((p) => p.hasAttribute("stroke-dasharray")),
  };
}

describe("WorkflowDiagram", () => {
  it("draws a forward arrow for each next and a dashed one for each back, and none for a person's step", () => {
    renderWithI18n(<WorkflowDiagram nodes={nodes} selectedId="a" onSelect={vi.fn()} />);
    const { forward, back } = edges();
    expect(forward).toHaveLength(2); // a -> b, b -> d
    expect(back).toHaveLength(1); // b -> a
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("puts edges that share a node on different lanes so they do not overlap", () => {
    renderWithI18n(<WorkflowDiagram nodes={nodes} selectedId="a" onSelect={vi.fn()} />);
    const bulges = edges().forward.map((p) => /C(\d+),/.exec(p.getAttribute("d") ?? "")?.[1]);
    expect(new Set(bulges).size).toBe(2);
  });

  it("selects a step and marks the selected one", () => {
    const onSelect = vi.fn();
    renderWithI18n(<WorkflowDiagram nodes={nodes} selectedId="b" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /^B/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^A/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /^C/ }));
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("ignores a link to a step that is not in the picture or that points at itself", () => {
    renderWithI18n(
      <WorkflowDiagram
        nodes={[node("a", { next: "gone", back: "a" }), node("b")]}
        selectedId="a"
        onSelect={vi.fn()}
      />,
    );
    const { forward, back } = edges();
    expect(forward).toHaveLength(0);
    expect(back).toHaveLength(0);
  });

  it("explains the arrows", () => {
    renderWithI18n(<WorkflowDiagram nodes={nodes} selectedId="a" onSelect={vi.fn()} />);
    expect(screen.getByText("Moves on to")).toBeTruthy();
    expect(screen.getByText("Sent back to")).toBeTruthy();
  });
});
