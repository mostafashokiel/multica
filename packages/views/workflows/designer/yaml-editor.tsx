"use client";

import { useRef, useState } from "react";
import { FileUp, Replace } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { MAX_WORKFLOW_SOURCE_BYTES, parseDefinitionText, type WorkflowDefinition } from "@multica/core/workflows";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { ValidationBadge } from "./problems-panel";
import { useDefinitionValidation } from "./use-validation";
import { YamlExportButtons, yamlFileName } from "./yaml-actions";

/**
 * The workflow as text, which can be edited, pasted over or loaded from a file, to move a workflow
 * between workspaces and environments. Nothing here decides what is valid: the server reads the text
 * and answers with its problems and the canonical form, and only that form is put on the canvas, as
 * one change that can be undone. A text with problems may still be put on the canvas; a text that
 * cannot be read at all cannot.
 */
export function YamlEditor({
  canonical,
  lockedKey,
  onApply,
}: {
  /** The canvas as the server would store it. */
  canonical: string;
  /** The key of a saved workflow: its key cannot change, so text with another key is refused. */
  lockedKey: string | null;
  onApply: (definition: WorkflowDefinition) => void;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const [draft, setDraft] = useState(canonical);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const verdict = useDefinitionValidation(wsId, draft);

  const readable = verdict.known && !verdict.failed && verdict.canonical !== undefined;
  const sameAsCanvas = verdict.canonical === canonical;
  const canApply = readable && !verdict.checking && !sameAsCanvas;

  const edit = (text: string) => {
    setDraft(text);
    setRefusal(null);
  };

  const apply = () => {
    if (verdict.canonical === undefined) return;
    const parsed = parseDefinitionText(verdict.canonical);
    if (!parsed.ok) {
      setRefusal(t(($) => $.editor.yaml.unreadable));
      return;
    }
    const found = parsed.definition.metadata.id;
    if (lockedKey !== null && found !== lockedKey) {
      setRefusal(t(($) => $.editor.yaml.key_mismatch, { found, expected: lockedKey }));
      return;
    }
    onApply(parsed.definition);
    toast.success(t(($) => $.editor.yaml.applied));
  };

  const load = async (file: File | undefined) => {
    if (file === undefined) return;
    if (file.size > MAX_WORKFLOW_SOURCE_BYTES) {
      setRefusal(t(($) => $.editor.yaml.too_large));
      return;
    }
    edit(await file.text());
  };

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-caption text-muted-foreground">
          {lockedKey === null ? t(($) => $.editor.yaml.hint_new) : t(($) => $.editor.yaml.hint_edit, { key: lockedKey })}
        </p>
        <ValidationBadge validation={verdict} />
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,text/yaml,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-label={t(($) => $.editor.yaml.load_file)}
          onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <FileUp aria-hidden="true" className="size-3.5" />
          {t(($) => $.editor.yaml.load_file)}
        </Button>
        <YamlExportButtons text={canonical} fileName={yamlFileName(lockedKey ?? "")} />
        <Button size="sm" disabled={!canApply} onClick={apply}>
          <Replace aria-hidden="true" className="size-3.5" />
          {t(($) => $.editor.yaml.apply)}
        </Button>
      </div>
      <Textarea
        aria-label={t(($) => $.editor.yaml.label)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none font-mono text-caption"
        value={draft}
        onChange={(e) => edit(e.target.value)}
      />
      <div role="status" aria-live="polite" className="max-h-32 shrink-0 overflow-y-auto text-body">
        {refusal !== null ? <p className="text-destructive">{refusal}</p> : null}
        {readable && sameAsCanvas ? <p className="text-muted-foreground">{t(($) => $.editor.yaml.same)}</p> : null}
        {verdict.known && !verdict.failed && verdict.canonical === undefined ? (
          <ul className="divide-y">
            {verdict.issues.map((issue, index) => (
              // Text from the pasted YAML, so drawn as text, never as markup.
              <li key={`${index}-${issue.message}`} className="flex gap-3 py-1">
                <span className="w-14 shrink-0 font-mono text-caption text-destructive">
                  {issue.line === undefined ? "" : t(($) => $.editor.yaml.line, { line: issue.line })}
                </span>
                <span className="min-w-0 flex-1 break-words">{issue.path ? `${issue.path}: ${issue.message}` : issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {readable && !sameAsCanvas && verdict.issues.length > 0 ? (
          <p className="text-muted-foreground">{t(($) => $.editor.yaml.has_problems, { count: verdict.issues.length })}</p>
        ) : null}
      </div>
    </div>
  );
}
