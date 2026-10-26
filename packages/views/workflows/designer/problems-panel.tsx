"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import type { WorkflowIssue } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type { Validation } from "./use-validation";

/** The one-word state of the workflow: checking, valid, or how many problems. */
export function ValidationBadge({ validation }: { validation: Validation }) {
  const { t } = useT("workflows");
  const count = validation.issues.length;
  const state = validation.failed ? "failed" : !validation.known || validation.checking ? "checking" : count === 0 ? "valid" : "problems";
  return (
    <span
      data-testid="validation-status"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium",
        state === "valid" && "bg-success/10 text-success",
        state === "problems" && "bg-destructive/10 text-destructive",
        (state === "checking" || state === "failed") && "bg-muted text-muted-foreground",
      )}
    >
      {state === "valid" ? <CircleCheck aria-hidden="true" className="size-3" /> : state === "problems" ? <CircleAlert aria-hidden="true" className="size-3" /> : <LoaderCircle aria-hidden="true" className={cn("size-3", state === "checking" && "animate-spin")} />}
      {state === "valid"
        ? t(($) => $.editor.status.valid)
        : state === "problems"
          ? t(($) => $.editor.status.problems, { count })
          : state === "failed"
            ? t(($) => $.editor.status.failed)
            : t(($) => $.editor.status.checking)}
    </span>
  );
}

/** What the server found wrong, most useful first: a problem on a stage can be clicked to find it. */
export function ProblemsPanel({ validation, onSelect }: { validation: Validation; onSelect: (stageId: string) => void }) {
  const { t } = useT("workflows");
  const { issues } = validation;
  return (
    <section className="max-h-40 shrink-0 overflow-y-auto border-t" aria-label={t(($) => $.editor.problems.title)}>
      {validation.failed ? (
        <p role="status" className="px-4 py-2 text-body text-muted-foreground">
          {t(($) => $.editor.problems.failed)}
        </p>
      ) : issues.length === 0 ? (
        <p className="px-4 py-2 text-body text-muted-foreground">{validation.known ? t(($) => $.editor.problems.none) : t(($) => $.editor.status.checking)}</p>
      ) : (
        <ul className="divide-y text-body">
          {issues.map((issue, index) => (
            <li key={`${issue.code ?? "p"}-${issue.stage_id ?? ""}-${index}`}>
              <ProblemRow issue={issue} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProblemRow({ issue, onSelect }: { issue: WorkflowIssue; onSelect: (stageId: string) => void }) {
  const { t } = useT("workflows");
  const stageId = issue.stage_id;
  const body = (
    <>
      <span className="w-12 shrink-0 font-mono text-caption text-destructive">{issue.code ?? "-"}</span>
      {/* Text built from the workflow itself: drawn as text, never as markup. */}
      <span className="min-w-0 flex-1 break-words">{issue.message}</span>
      {stageId ? <span className="shrink-0 font-mono text-caption text-muted-foreground">{t(($) => $.problems.stage, { id: stageId })}</span> : null}
    </>
  );
  if (!stageId) return <div className="flex gap-3 px-4 py-1.5">{body}</div>;
  return (
    <button type="button" className="flex w-full gap-3 px-4 py-1.5 text-left hover:bg-accent" onClick={() => onSelect(stageId)}>
      {body}
    </button>
  );
}
