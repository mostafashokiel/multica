"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import {
  WORKFLOW_YAML_MAX_BYTES,
  exportWorkflowYaml,
  parseWorkflowYaml,
  resolveWorkflowImport,
  type ResolvedWorkflowImport,
  type WorkflowImportNote,
  type WorkflowYamlRefs,
} from "@multica/core/issue-workflows";
import type { IssueWorkflow } from "@multica/core/types";
import { agentListOptions, memberListOptions, squadListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";

/**
 * The workspace names a workflow file is written and read against: statuses by
 * key and name, agents and squads by name, members by email. Archived agents
 * and squads are not offered as handlers, so they do not resolve.
 */
function buildRefs(
  statuses: WorkflowYamlRefs["statuses"],
  agents: { id: string; name: string; archived_at?: string | null }[],
  squads: { id: string; name: string; archived_at?: string | null }[],
  members: { user_id: string; email: string }[],
): WorkflowYamlRefs {
  return {
    statuses: statuses.map((s) => ({ key: s.key, name: s.name, category: s.category })),
    agents: agents.filter((a) => !a.archived_at).map((a) => ({ id: a.id, name: a.name })),
    squads: squads.filter((s) => !s.archived_at).map((s) => ({ id: s.id, name: s.name })),
    members: members.map((m) => ({ user_id: m.user_id, email: m.email })),
  };
}

/**
 * The lookups for reading a file. `ready` is false until the agents, squads,
 * members and statuses have loaded: resolving against partial lists would
 * quietly drop handlers that do exist.
 */
function useWorkflowYamlRefs(): { refs: WorkflowYamlRefs; ready: boolean } {
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const agents = useQuery(agentListOptions(wsId));
  const squads = useQuery(squadListOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  const ready = catalog.isLoaded && agents.isSuccess && squads.isSuccess && members.isSuccess;
  const refs = useMemo(
    () => buildRefs(catalog.activeStatuses, agents.data ?? [], squads.data ?? [], members.data ?? []),
    [catalog.activeStatuses, agents.data, squads.data, members.data],
  );
  return { refs, ready };
}

function fileNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "workflow"}.yaml`;
}

/** Copy and download of a saved workflow as YAML. */
export function useWorkflowYamlExport(workflow: Pick<IssueWorkflow, "name" | "description" | "steps"> | null) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const catalog = useIssueStatuses(wsId);

  // Names are read fresh: a list that has not loaded yet must not turn real handlers into warnings.
  const build = async () => {
    if (!workflow) return null;
    const [agents, squads, members] = await Promise.all([
      queryClient.ensureQueryData(agentListOptions(wsId)),
      queryClient.ensureQueryData(squadListOptions(wsId)),
      queryClient.ensureQueryData(memberListOptions(wsId)),
    ]);
    const out = exportWorkflowYaml(workflow, buildRefs(catalog.activeStatuses, agents, squads, members));
    if (out.warnings.length > 0) {
      toast.warning(t(($) => $.workflows.yaml.export_warnings, { count: out.warnings.length }));
    }
    return out.yaml;
  };

  return {
    copy: async () => {
      try {
        const yaml = await build();
        if (yaml === null) return;
        await navigator.clipboard.writeText(yaml);
        toast.success(t(($) => $.workflows.yaml.copied));
      } catch {
        toast.error(t(($) => $.workflows.yaml.copy_failed));
      }
    },
    download: async () => {
      const yaml = await build().catch(() => null);
      if (yaml === null || !workflow) return;
      const url = URL.createObjectURL(new Blob([yaml], { type: "text/yaml;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileNameFor(workflow.name);
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(t(($) => $.workflows.yaml.downloaded));
    },
  };
}

/** What an import changed or could not carry over, in words. */
export function ImportNotes({ notes }: { notes: WorkflowImportNote[] }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  if (notes.length === 0) return null;

  const text = (note: WorkflowImportNote): string => {
    switch (note.code) {
      case "status_matched_by_name":
        return t(($) => $.workflows.yaml.notes.status_matched_by_name, { step: note.step, detail: labelOf(note.detail) });
      case "status_will_be_created":
        return t(($) => $.workflows.yaml.notes.status_will_be_created, { step: note.step });
      case "category_adjusted":
        return t(($) => $.workflows.yaml.notes.category_adjusted, { step: note.step, detail: note.detail });
      case "handler_not_found":
        return t(($) => $.workflows.yaml.notes.handler_not_found[note.kind], { step: note.step, detail: note.detail });
      case "link_dropped":
        return t(($) => $.workflows.yaml.notes.link_dropped, { step: note.step, detail: note.detail });
      case "link_to_new_status":
        return t(($) => $.workflows.yaml.notes.link_to_new_status, { step: note.step, detail: note.detail });
      case "fields_ignored":
        return t(($) => $.workflows.yaml.notes.fields_ignored, { step: note.step });
      case "step_duplicate":
        return t(($) => $.workflows.yaml.notes.step_duplicate, { step: note.step });
    }
  };

  return (
    <div className="rounded-lg border border-surface-border bg-warning/10 p-3 text-caption leading-5" role="status">
      <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
        <TriangleAlert aria-hidden className="size-3.5 text-warning" />
        {t(($) => $.workflows.yaml.notes.title)}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {notes.map((note, i) => (
          <li key={i}>{text(note)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Paste or load a workflow file. It is checked as you type, every problem with
 * its line; a good file shows what the import will change, and "Open in
 * editor" hands the draft to the workflow editor. Nothing is saved here.
 */
export function WorkflowImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (resolved: ResolvedWorkflowImport) => void;
}) {
  const { t } = useT("issues");
  const { refs, ready } = useWorkflowYamlRefs();
  const [text, setText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const result = useMemo(() => {
    if (!ready || text.trim() === "") return null;
    const parsed = parseWorkflowYaml(text);
    return parsed.ok
      ? { ok: true as const, steps: parsed.doc.steps.length, resolved: resolveWorkflowImport(parsed.doc, refs) }
      : { ok: false as const, problems: parsed.problems };
  }, [text, refs, ready]);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > WORKFLOW_YAML_MAX_BYTES) {
      setText(await file.slice(0, WORKFLOW_YAML_MAX_BYTES + 1).text());
      return;
    }
    try {
      setText(await file.text());
    } catch {
      toast.error(t(($) => $.workflows.yaml.file_read_failed));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.yaml.import_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.workflows.yaml.import_description)}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label={t(($) => $.workflows.yaml.import_label)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="h-64 resize-y font-mono text-caption"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,text/yaml,text/plain"
            className="hidden"
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
            <FileUp className="size-3.5" />
            {t(($) => $.workflows.yaml.load_file)}
          </Button>
          {result?.ok && (
            <span className="text-caption text-muted-foreground">
              {t(($) => $.workflows.yaml.ready, { count: result.steps })}
            </span>
          )}
        </div>
        {result && !result.ok && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-caption leading-5">
            <p className="mb-1 font-medium text-destructive">{t(($) => $.workflows.yaml.problems_title)}</p>
            <ul className="space-y-0.5">
              {result.problems.slice(0, 20).map((p, i) => (
                <li key={i} className="text-muted-foreground">
                  {p.line !== undefined && (
                    <span className="mr-1.5 font-medium text-foreground">{t(($) => $.workflows.yaml.line, { line: p.line })}</span>
                  )}
                  {p.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result?.ok && <ImportNotes notes={result.resolved.notes} />}
        <DialogFooter>
          <Button
            disabled={!result?.ok}
            onClick={() => {
              if (!result?.ok) return;
              onImport(result.resolved);
              setText("");
              onOpenChange(false);
            }}
          >
            {t(($) => $.workflows.yaml.open_in_editor)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
