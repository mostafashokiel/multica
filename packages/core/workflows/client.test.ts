import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import {
  EMPTY_VALIDATE_WORKFLOW_RESULT,
  EMPTY_WORKFLOW_APPLY_RESULT,
  EMPTY_WORKFLOW_RENDER,
  EMPTY_LIST_WORKFLOW_AUDIT_RESPONSE,
  EMPTY_LIST_WORKFLOW_SQUADS_RESPONSE,
  EMPTY_WORKFLOW_PIPELINE,
  EMPTY_LIST_WORKFLOWS_RESPONSE,
  EMPTY_LIST_WORKFLOW_VERSIONS_RESPONSE,
  EMPTY_WORKFLOW_WITH_VERSION,
} from "../api/schemas";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const workflow = {
  id: "wf-1",
  key: "sdlc-pilot",
  name: "SDLC pilot",
  description: "",
  status: "active",
  latest_version: 2,
  revision: 3,
  created_by_type: "member",
  created_by_id: "u-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

describe("ApiClient workflows (reads)", () => {
  it("lists workflows", async () => {
    const fetchMock = stubFetch(json({ workflows: [workflow] }));
    const client = new ApiClient("https://api.example.test");

    const result = await client.listWorkflows();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows");
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.key).toBe("sdlc-pilot");
  });

  it("falls back to an empty list on a malformed body", async () => {
    stubFetch(json({ workflows: "nope" }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.listWorkflows()).toEqual(EMPTY_LIST_WORKFLOWS_RESPONSE);
  });

  it("treats a backend without the route (404) as an empty list", async () => {
    stubFetch(json({ error: "not found" }, 404));
    const client = new ApiClient("https://api.example.test");

    expect(await client.listWorkflows()).toEqual(EMPTY_LIST_WORKFLOWS_RESPONSE);
  });

  it("lets a 403 (flag off) surface as an ApiError", async () => {
    stubFetch(json({ error: "workflows are not enabled", code: "workflows_disabled" }, 403));
    const client = new ApiClient("https://api.example.test");

    const error = await client.listWorkflows().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });

  it("does not hide a server error as an empty list", async () => {
    stubFetch(json({ error: "boom" }, 500));
    const client = new ApiClient("https://api.example.test");

    await expect(client.listWorkflows()).rejects.toBeInstanceOf(ApiError);
  });

  it("reads a workflow with its latest version, keeping the YAML as text", async () => {
    const definition = "apiVersion: multica.dev/v1\nkind: Workflow\n";
    const fetchMock = stubFetch(
      json({
        workflow,
        version: {
          id: "v-2",
          workflow_id: "wf-1",
          version: 2,
          content_hash: "abc",
          note: "",
          created_by_type: "member",
          created_by_id: "u-1",
          created_at: "2026-01-02T00:00:00Z",
          definition,
          issues: [{ code: "V004", message: "stage a is unreachable", stage_id: "a" }],
        },
      }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.getWorkflow("wf-1");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1");
    expect(result.version?.definition).toBe(definition);
    expect(result.version?.issues?.[0]?.code).toBe("V004");
  });

  it("accepts a workflow that has no version yet", async () => {
    stubFetch(json({ workflow }));
    const client = new ApiClient("https://api.example.test");

    const result = await client.getWorkflow("wf-1");

    expect(result.workflow.id).toBe("wf-1");
    expect(result.version).toBeNull();
  });

  it("falls back on a malformed workflow body", async () => {
    stubFetch(json({ workflow: 12 }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.getWorkflow("wf-1")).toEqual(EMPTY_WORKFLOW_WITH_VERSION);
  });

  it("encodes the id in the path", async () => {
    const fetchMock = stubFetch(json({ workflow }));
    const client = new ApiClient("https://api.example.test");

    await client.getWorkflow("a/b c");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/a%2Fb%20c");
  });

  it("lists versions and tolerates a malformed body", async () => {
    stubFetch(json({ versions: [{ id: "v-1", version: 1 }] }));
    const client = new ApiClient("https://api.example.test");
    const ok = await client.listWorkflowVersions("wf-1");
    expect(ok.versions[0]?.version).toBe(1);
    expect(ok.versions[0]?.note).toBe("");

    stubFetch(json({ versions: {} }));
    expect(await client.listWorkflowVersions("wf-1")).toEqual(EMPTY_LIST_WORKFLOW_VERSIONS_RESPONSE);
  });

  it("reads one version by number", async () => {
    const fetchMock = stubFetch(json({ id: "v-1", version: 1, definition: "kind: Workflow\n" }));
    const client = new ApiClient("https://api.example.test");

    const version = await client.getWorkflowVersion("wf-1", 1);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/versions/1");
    expect(version?.definition).toBe("kind: Workflow\n");
  });

  it("lists the audit trail and tolerates unknown actions and a malformed body", async () => {
    stubFetch(json({ audit: [{ action: "something-new", actor_type: "member", actor_id: "u", created_at: "t", detail: {} }] }));
    const client = new ApiClient("https://api.example.test");
    const ok = await client.listWorkflowAudit("wf-1");
    expect(ok.audit[0]?.action).toBe("something-new");

    stubFetch(json({ audit: 5 }));
    expect(await client.listWorkflowAudit("wf-1")).toEqual(EMPTY_LIST_WORKFLOW_AUDIT_RESPONSE);
  });
});

describe("ApiClient workflows (render and apply)", () => {
  it("previews a briefing with the squad and version it was asked for", async () => {
    const fetchMock = stubFetch(
      json({
        workflow_key: "sdlc-pilot",
        version: 2,
        content_hash: "abc",
        squad_name: "Delivery",
        instructions: "<!-- block -->",
        labels: ["wf:sdlc-pilot", "phase:a"],
      }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.renderWorkflow("wf-1", { version: 2, squad_id: "sq-1" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/render");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ version: 2, squad_id: "sq-1" });
    expect(result.instructions).toBe("<!-- block -->");
    expect(result.labels).toEqual(["wf:sdlc-pilot", "phase:a"]);
  });

  it("reads the members a preview names, and treats an unknown status as unresolved", async () => {
    stubFetch(
      json({
        workflow_key: "sdlc-pilot",
        members: [
          { kind: "agent", ref: "builder", id: "a-1", name: "builder", status: "add" },
          { kind: "person", ref: "user:u-1", id: "u-1", name: "Ada", status: "present" },
          { kind: "person", ref: "user:?", status: "teleported" },
        ],
      }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.renderWorkflow("wf-1", { squad_id: "sq-1" });

    expect(result.members.map((m) => [m.kind, m.ref, m.status])).toEqual([
      ["agent", "builder", "add"],
      ["person", "user:u-1", "present"],
      ["person", "user:?", "unresolved"],
    ]);
  });

  it("answers no members when an older server sends none or null", async () => {
    stubFetch(json({ workflow_key: "x", members: null }));
    const client = new ApiClient("https://api.example.test");
    expect((await client.renderWorkflow("wf-1", {})).members).toEqual([]);
  });

  it("falls back to an empty preview on a malformed body", async () => {
    stubFetch(json({ labels: "nope", version: "x" }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.renderWorkflow("wf-1", {})).toEqual(EMPTY_WORKFLOW_RENDER);
  });

  it("reads the pipeline: issues by stage, and the ones that sit outside any stage", async () => {
    const fetchMock = stubFetch(
      json({
        workflow_key: "sdlc-pilot",
        version: 2,
        stages: [
          { id: "build", name: "Build", type: "agent", approvers: null, issues: [{ id: "i-1", identifier: "ACM-1", title: "Do it", status: "in_progress", updated_at: "t" }] },
          { id: "gate", name: "Gate", type: "human_gate", approvers: [{ ref: "user:u-1", id: "u-1", name: "Ada" }, { ref: "user:?" }], issues: [] },
          { id: "done", name: "done", type: "end", issues: null },
        ],
        no_stage: [{ id: "i-2", identifier: "ACM-2", title: "New", status: "todo", updated_at: "t" }],
        conflicting: null,
        unknown_stage: [{ id: "i-3", identifier: "ACM-3", title: "Old", status: "todo", updated_at: "t", phases: ["phase:gone"] }],
        total: 3,
        truncated: false,
      }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.getWorkflowPipeline("wf-1");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/pipeline");
    expect(result.stages.map((s) => [s.id, s.issues.length])).toEqual([["build", 1], ["gate", 0], ["done", 0]]);
    expect(result.stages[0]?.approvers).toEqual([]);
    expect(result.stages[1]?.approvers).toEqual([{ ref: "user:u-1", id: "u-1", name: "Ada" }, { ref: "user:?" }]);
    expect(result.no_stage).toHaveLength(1);
    expect(result.conflicting).toEqual([]);
    expect(result.unknown_stage[0]?.phases).toEqual(["phase:gone"]);
    expect(result.total).toBe(3);
  });

  it("asks for one squad's issues when given a squad", async () => {
    // A fresh Response per call: a body can be read once.
    const fetchMock = vi.fn().mockImplementation(async () => json({ workflow_key: "x", stages: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://api.example.test");

    await client.getWorkflowPipeline("wf-1", { squad: "sq 1" });
    await client.getWorkflowPipeline("wf-1", { squad: "none" });
    await client.getWorkflowPipeline("wf-1", {});

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://api.example.test/api/workflows/wf-1/pipeline?squad=sq%201",
      "https://api.example.test/api/workflows/wf-1/pipeline?squad=none",
      "https://api.example.test/api/workflows/wf-1/pipeline",
    ]);
  });

  it("falls back to an empty pipeline on a malformed body", async () => {
    stubFetch(json({ stages: "nope", total: "x" }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.getWorkflowPipeline("wf-1")).toEqual(EMPTY_WORKFLOW_PIPELINE);
  });

  it("lists the squads that follow a workflow", async () => {
    const fetchMock = stubFetch(
      json({ squads: [{ squad_id: "sq-1", name: "Delivery", version: 2, content_hash: "h", up_to_date: false }] }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.listWorkflowSquads("wf-1");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/squads");
    expect(result.squads).toEqual([
      { squad_id: "sq-1", name: "Delivery", version: 2, content_hash: "h", up_to_date: false },
    ]);
  });

  it("falls back to no squads on a malformed body", async () => {
    stubFetch(json({ squads: "nope" }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.listWorkflowSquads("wf-1")).toEqual(EMPTY_LIST_WORKFLOW_SQUADS_RESPONSE);
  });

  it("applies to a squad and sends exactly what it was given", async () => {
    const fetchMock = stubFetch(
      json({ applied: false, squad_id: "sq-1", workflow_key: "sdlc-pilot", version: 3, content_hash: "h", labels: ["wf:sdlc-pilot"] }),
    );
    const client = new ApiClient("https://api.example.test");

    const result = await client.applyWorkflow("wf-1", { squad_id: "sq-1", replace: true });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/apply");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ squad_id: "sq-1", replace: true });
    expect(result.applied).toBe(false);
    expect(result.version).toBe(3);
  });

  it("does not turn a 2xx apply with an unreadable body into a failure", async () => {
    stubFetch(json({ applied: "maybe", labels: 7 }));
    const client = new ApiClient("https://api.example.test");

    expect(await client.applyWorkflow("wf-1", { squad_id: "sq-1" })).toEqual(EMPTY_WORKFLOW_APPLY_RESULT);
  });

  it("surfaces the refusal code when the squad already follows another workflow", async () => {
    stubFetch(
      json({ error: "this squad already follows workflow \"other\"", code: "squad_has_workflow", workflow: "other" }, 409),
    );
    const client = new ApiClient("https://api.example.test");

    const error = await client.applyWorkflow("wf-1", { squad_id: "sq-1" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).body).toMatchObject({ code: "squad_has_workflow", workflow: "other" });
  });
});

describe("ApiClient workflow writes", () => {
  const client = () => new ApiClient("https://api.example.test");
  const written = { workflow, version: { id: "v-1", version: 1, definition: "kind: Workflow\n" } };

  it("validates text and returns the canonical form with the problems", async () => {
    const fetchMock = stubFetch(
      json({ parsed: true, valid: false, issues: [{ code: "V002", message: "x", stage_id: "a" }], canonical: "kind: Workflow\n" }),
    );

    const result = await client().validateWorkflow("kind: Workflow\n");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/validate");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ definition: "kind: Workflow\n" });
    expect(result).toMatchObject({ parsed: true, valid: false, canonical: "kind: Workflow\n" });
    expect(result.issues[0]?.code).toBe("V002");
  });

  it("reads a null problem list (what older servers sent for a clean definition) as empty", async () => {
    stubFetch(json({ parsed: true, valid: true, issues: null, canonical: "c\n" }));
    expect(await client().validateWorkflow("x")).toEqual({ parsed: true, valid: true, issues: [], canonical: "c\n" });
  });

  it("never reads a malformed validation answer as valid", async () => {
    stubFetch(json({ valid: "yes please", issues: 5 }));
    expect(await client().validateWorkflow("x")).toEqual(EMPTY_VALIDATE_WORKFLOW_RESULT);
  });

  it("creates with the definition, layout and note it was given", async () => {
    const fetchMock = stubFetch(json(written, 201));

    const result = await client().createWorkflow({ definition: "d", name: "N", layout: { a: { x: 1, y: 2 } }, note: "first" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      definition: "d", name: "N", layout: { a: { x: 1, y: 2 } }, note: "first",
    });
    expect(result.workflow.key).toBe("sdlc-pilot");
  });

  it("saves on top of a base version and surfaces a conflict with the newest version", async () => {
    const fetchMock = stubFetch(json(written, 201));
    await client().saveWorkflowVersion("wf-1", { definition: "d", base_version: 3 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/versions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ definition: "d", base_version: 3 });

    stubFetch(json({ error: "a newer version was saved first", code: "version_conflict", latest_version: 5 }, 409));
    const error = await client().saveWorkflowVersion("wf-1", { definition: "d", base_version: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).body).toMatchObject({ code: "version_conflict", latest_version: 5 });
  });

  it("surfaces the problems of a definition the server could not read", async () => {
    stubFetch(json({ error: "the definition could not be read", code: "invalid_definition", issues: [{ message: "bad", line: 3 }] }, 400));
    const error = await client().createWorkflow({ definition: "x" }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).body).toMatchObject({ code: "invalid_definition", issues: [{ line: 3 }] });
  });

  it("restores an old version", async () => {
    const fetchMock = stubFetch(json(written, 201));
    await client().restoreWorkflowVersion("wf-1", 2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.example.test/api/workflows/wf-1/versions/2/restore");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});
