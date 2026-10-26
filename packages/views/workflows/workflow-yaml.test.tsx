// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { ResolvedWorkflowImport } from "@multica/core/issue-workflows";
import { renderWithI18n } from "../test/i18n";
import { WorkflowImportDialog } from "./workflow-yaml";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
const status = (key: string, name: string, category: string, position: number) => ({
  id: key, workspace_id: "ws-1", key, name, description: "", category, color: "#3b82f6",
  is_system: false, position, archived_at: null, created_at: "", updated_at: "",
});
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () =>
    buildIssueStatusCatalog([
      status("todo", "Todo", "unstarted", 1),
      status("in_progress", "In Progress", "started", 2),
      status("in_review", "In Review", "started", 3),
      status("done", "Done", "done", 4),
    ] as never),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: async () => [{ id: "agent-1", name: "Builder", archived_at: null }] }),
  squadListOptions: () => ({ queryKey: ["squads"], queryFn: async () => [] }),
  memberListOptions: () => ({ queryKey: ["members"], queryFn: async () => [{ user_id: "user-1", email: "ada@example.com" }] }),
}));

const GOOD = [
  "version: 1",
  "name: Delivery",
  "steps:",
  "  - status: in_progress",
  "    handler: { type: agent, name: Builder }",
  "    instructions: Build it.",
  "    next: in_review",
  "  - status: in_review",
  "    handler: { type: squad, name: Ghost Squad }",
].join("\n");

function renderDialog(onImport = vi.fn<(r: ResolvedWorkflowImport) => void>(), onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <WorkflowImportDialog open onOpenChange={onOpenChange} onImport={onImport} />
    </QueryClientProvider>,
  );
  return { onImport, onOpenChange };
}

const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), { target: { value: text } });
const openButton = () => screen.getByRole("button", { name: "Open in editor" }) as HTMLButtonElement;

afterEach(cleanup);

describe("WorkflowImportDialog (MUL-7420)", () => {
  it("waits for text, then lists every problem with its line and keeps Open disabled", async () => {
    renderDialog();
    expect(openButton().disabled).toBe(true);

    type("version: 1\nname: X\nsteps:\n  - status: qa\n    instruction: typo\n");
    expect(await screen.findByText("Problems in the file")).toBeTruthy();
    expect(screen.getByText("Line 4")).toBeTruthy();
    expect(openButton().disabled).toBe(true);
  });

  it("says what a good file will change and hands the resolved draft to the editor", async () => {
    const { onImport, onOpenChange } = renderDialog();
    type(GOOD);

    expect(await screen.findByText("Ready: 2 steps")).toBeTruthy();
    expect(screen.getByText("Changed while importing")).toBeTruthy();
    expect(screen.getByText(/There is no squad “Ghost Squad” here, so “in_review” was imported without a handoff/)).toBeTruthy();
    expect(openButton().disabled).toBe(false);

    fireEvent.click(openButton());
    expect(onImport).toHaveBeenCalledTimes(1);
    const resolved = onImport.mock.calls[0]![0];
    expect(resolved.draft.name).toBe("Delivery");
    expect(resolved.draft.handoffs.in_progress?.handler).toEqual({ type: "agent", id: "agent-1" });
    expect(resolved.notes).toHaveLength(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("loads a file into the editor box", async () => {
    renderDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([GOOD], "delivery.yaml", { type: "text/yaml" })] } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Workflow YAML" }) as HTMLTextAreaElement).value).toBe(GOOD));
    expect(await screen.findByText("Ready: 2 steps")).toBeTruthy();
  });
});
