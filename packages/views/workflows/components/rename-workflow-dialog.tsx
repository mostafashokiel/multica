"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useUpdateWorkflow } from "@multica/core/workflows";
import { ApiError } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@multica/ui/components/ui/field";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../i18n";
import { workflowErrorCode } from "./workflow-state";

/** The longest name the server accepts. */
export const MAX_WORKFLOW_NAME_LENGTH = 120;

/**
 * Change the name a workflow has in lists and on its page. The name is not part of the definition (the key
 * is, and it never changes), so renaming makes no new version.
 */
export function RenameWorkflowDialog({
  workflow,
  open,
  onOpenChange,
}: {
  workflow: { id: string; key: string; name: string; revision: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const update = useUpdateWorkflow(wsId, workflow.id);
  const [name, setName] = useState(workflow.name);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const unchanged = trimmed === workflow.name;

  const submit = () => {
    if (trimmed === "" || unchanged || update.isPending) return;
    setError(null);
    update.mutate(
      { name: trimmed, revision: workflow.revision },
      {
        onSuccess: () => {
          toast.success(t(($) => $.rename.done));
          onOpenChange(false);
        },
        onError: (e) => {
          if (workflowErrorCode(e) === "revision_conflict") setError(t(($) => $.rename.conflict));
          else if (e instanceof ApiError && e.status === 400 && typeof (e.body as { error?: unknown } | null)?.error === "string") {
            setError((e.body as { error: string }).error);
          } else setError(t(($) => $.rename.failed));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(workflow.name);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t(($) => $.rename.title)}</DialogTitle>
            <DialogDescription>{t(($) => $.rename.description, { key: workflow.key })}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor="workflow-name">{t(($) => $.rename.label)}</FieldLabel>
            <Input
              id="workflow-name"
              value={name}
              maxLength={MAX_WORKFLOW_NAME_LENGTH}
              autoFocus
              aria-invalid={error !== null || undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(($) => $.rename.cancel)}
            </Button>
            <Button type="submit" disabled={trimmed === "" || unchanged || update.isPending}>
              {t(($) => $.rename.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
