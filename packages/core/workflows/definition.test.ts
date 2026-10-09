import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_SOURCE_BYTES,
  parseDefinitionText,
  stringifyDefinition,
  type WorkflowDefinition,
} from "./definition";
import { emptyDefinition } from "./designer-model";

// The server's own test files are the contract: whatever Go writes (and accepts), the editor
// must read, and what the editor writes must read back the same.
const GO_TESTDATA = new URL("../../../server/internal/workflow/testdata/", import.meta.url);
const goFile = (name: string) => readFileSync(new URL(name, GO_TESTDATA), "utf8");

function parsed(text: string): WorkflowDefinition {
  const result = parseDefinitionText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

describe("parseDefinitionText", () => {
  it("reads the canonical pilot the server writes", () => {
    const def = parsed(goFile("pilot.canonical.yaml"));
    expect(def.metadata.id).toBe("sdlc-pilot");
    expect(def.start).toBe("br-review");
    expect(def.stages).toHaveLength(8);
    expect(def.stages.map((s) => s.type)).toContain("human_gate");
    const gate = def.stages.find((s) => s.id === "br-approval");
    expect(gate).toMatchObject({ type: "human_gate", approvers: "product", on_approve: "stories", on_reject: "br-review", max_rework: 3 });
    expect(def.approvers.product).toEqual(["user:<multica-user-id>"]);
    expect(def.target?.squad).toEqual({ name: "Delivery - Pilot", leader: "sdlc-orchestrator" });
  });

  it("reads every fixture the server's tests use that the server accepts", () => {
    const dir = new URL("fixtures/", GO_TESTDATA);
    const names = readdirSync(dir).filter((n) => n.endsWith(".yaml"));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      // A fixture the server rejects at parse time (unlike validation) is not expected to read.
      const result = parseDefinitionText(readFileSync(new URL(name, dir), "utf8"));
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("treats a missing reference as empty so a half-drawn definition opens", () => {
    const def = parsed(`
apiVersion: composer.noqodi/v1
kind: Workflow
metadata: { id: a, version: 1 }
approvers: {}
start: s
stages:
  - { id: s, type: agent, agent: x }
`);
    expect(def.stages[0]).toMatchObject({ type: "agent", next: "" });
  });

  it("refuses text that is not usable, with a reason", () => {
    for (const bad of ["", "just text", "- a\n- b", "metadata: 1", "a: [", "stages: [{id: a, type: robot}]"]) {
      const result = parseDefinitionText(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("refuses aliases, a second document and oversized text", () => {
    expect(parseDefinitionText("a: &x 1\nb: *x\n").ok).toBe(false);
    expect(parseDefinitionText(goFile("pilot.canonical.yaml") + "---\nextra: true\n").ok).toBe(false);
    const huge = parseDefinitionText("#" + "x".repeat(MAX_WORKFLOW_SOURCE_BYTES));
    expect(huge.ok).toBe(false);
  });

  it("refuses an approver group called __proto__ rather than writing it onto an object", () => {
    const text = goFile("pilot.canonical.yaml").replace("approvers:\n", 'approvers:\n  "__proto__": [a]\n');
    const result = parseDefinitionText(text);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>)["a"]).toBeUndefined();
  });

  it("reports the line of a syntax error", () => {
    const result = parseDefinitionText("a: 1\nb: [\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.line).toBeGreaterThan(0);
  });
});

describe("stringifyDefinition", () => {
  it("round-trips the pilot", () => {
    const def = parsed(goFile("pilot.canonical.yaml"));
    expect(parsed(stringifyDefinition(def))).toEqual(def);
  });

  it("writes required keys even when they are empty, because the server requires them", () => {
    const text = stringifyDefinition({
      ...emptyDefinition(),
      metadata: { id: "x", version: 1 },
      start: "a",
      stages: [{ id: "a", type: "human_gate", approvers: "", on_approve: "", on_reject: "" }],
    });
    for (const key of ["approvers: {}", "start: a", "on_approve: \"\"", "on_reject: \"\""]) expect(text).toContain(key);
    expect(parsed(text).stages[0]).toMatchObject({ on_approve: "", on_reject: "" });
  });

  it("leaves optional keys out when unset", () => {
    const text = stringifyDefinition(parsed(goFile("pilot.canonical.yaml")));
    const minimal = stringifyDefinition({ ...emptyDefinition(), metadata: { id: "x", version: 1 } });
    expect(minimal).not.toContain("owner");
    expect(minimal).not.toContain("target");
    expect(text).toContain("target:");
  });

  it("survives strings that YAML would otherwise reinterpret or break", () => {
    const hostile = [
      "yes", "no", "on", "true", "null", "~", "123", "1e3", "0x1F", "<<", "- dash", "# hash", "key: value",
      "  leading", "trailing  ", "line one\nline two", "\n\nleading newlines", "tab\there", "quote\"s and 'single'",
      "back\\slash", "unicode ✓ é 漢", "&anchor", "*alias", "!tag", "%directive", "@at", "`tick", "{flow}", "[seq]", "",
    ];
    for (const text of hostile) {
      const def: WorkflowDefinition = {
        ...emptyDefinition(),
        metadata: { id: "x", version: 1, owner: text, description: text },
        approvers: { g: [text] },
        start: "a",
        stages: [{ id: "a", type: "agent", name: text, agent: text, skills: [text], expected_output: text, next: "" }],
      };
      const back = parsed(stringifyDefinition(def));
      expect(back.metadata.owner, JSON.stringify(text)).toBe(text);
      expect(back.metadata.description).toBe(text);
      expect(back.approvers.g).toEqual([text]);
      expect(back.stages[0]).toMatchObject({ name: text, agent: text, expected_output: text });
    }
  });
});

describe("parallel stages", () => {
  // parallel.yaml is the server's canonical text for a workflow with a parallel stage.
  it("reads the branches the server writes, in order, with their optional fields", () => {
    const def = parsed(goFile("parallel.yaml"));
    expect(def.stages[0]).toEqual({
      id: "clocks",
      type: "parallel",
      name: "Check the clocks",
      branches: [
        { name: "New York", agent: "Check time in NYC", skills: ["clock"], expected_output: "The local time and date.\nOne line." },
        { agent: "Check Time at Cairo" },
      ],
      next: "sign-off",
    });
  });

  it("writes text the editor reads back unchanged", () => {
    const def = parsed(goFile("parallel.yaml"));
    expect(parsed(stringifyDefinition(def))).toEqual(def);
  });

  it("tolerates an unfinished stage: no branches yet, no next stage", () => {
    const def = parsed(
      stringifyDefinition({ ...emptyDefinition(), metadata: { id: "x", version: 1 }, start: "p", stages: [{ id: "p", type: "parallel", branches: [], next: "" }] }),
    );
    expect(def.stages[0]).toEqual({ id: "p", type: "parallel", branches: [], next: "" });
  });
});
