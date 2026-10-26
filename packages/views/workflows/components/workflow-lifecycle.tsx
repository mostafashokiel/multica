"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useDeleteWorkflow, useUpdateWorkflow } from "@multica/core/workflows";
import { ApiError } from "@multica/core/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@multica/ui/components/ui/field";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../i18n";
import { workflowErrorCode } from "./workflow-state";

type TFn = ReturnType<typeof useT<"workflows">>["t"];

/** Squad names a 409 `workflow_in_use` carries. */
function squadsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.body as { squads?: unknown } | null;
  return Array.isArray(body?.squads) ? body.squads.filter((s): s is string => typeof s === "string") : [];
}

function deleteFailure(t: TFn, error: unknown): string {
  switch (workflowErrorCode(error)) {
    case "workflow_in_use":
      return t(($) => $.lifecycle.delete_in_use, { squads: squadsOf(error).join(", ") });
    case "workflow_not_archived":
      return t(($) => $.lifecycle.delete_not_archived);
    default:
      return t(($) => $.lifecycle.delete_failed);
  }
}

/**
 * What an owner or admin can do with the life of a workflow: archive it (hidden, no more edits or applies,
 * reversible), restore it, or delete an archived one for good. Two steps on purpose: deleting removes every
 * version and the audit trail, and is refused while a squad still follows the workflow.
 */
export function WorkflowLifecycle({
  workflow,
  onDeleted,
}: {
  workflow: { id: string; key: string; name: string; status: string; revision: number };
  onDeleted: () => void;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const update = useUpdateWorkflow(wsId, workflow.id);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archived = workflow.status === "archived";

  const setStatus = (status: "active" | "archived") =>
    update.mutate(
      { status, revision: workflow.revision },
      {
        onSuccess: () => {
          setConfirmArchive(false);
          toast.success(status === "archived" ? t(($) => $.lifecycle.archived_done) : t(($) => $.lifecycle.restored_done));
        },
        onError: (e) => {
          setConfirmArchive(false);
          toast.error(workflowErrorCode(e) === "revision_conflict" ? t(($) => $.lifecycle.conflict) : t(($) => $.lifecycle.failed));
        },
      },
    );

  return (
    <div className="flex flex-col gap-2" aria-label={t(($) => $.lifecycle.title)} role="group">
      <h2 className="text-body font-medium">{t(($) => $.lifecycle.title)}</h2>
      <p className="text-caption text-muted-foreground">{archived ? t(($) => $.lifecycle.archived_hint) : t(($) => $.lifecycle.active_hint)}</p>
      {archived ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => setStatus("active")}>
            <ArchiveRestore aria-hidden="true" className="size-3.5" />
            {t(($) => $.lifecycle.restore)}
          </Button>
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t(($) => $.lifecycle.delete_button)}
          </Button>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setConfirmArchive(true)}>
            <Archive aria-hidden="true" className="size-3.5" />
            {t(($) => $.lifecycle.archive)}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmArchive} onOpenChange={(open) => !update.isPending && setConfirmArchive(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.lifecycle.archive_title, { name: workflow.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.lifecycle.archive_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>{t(($) => $.lifecycle.cancel)}</AlertDialogCancel>
            <AlertDialogAction disabled={update.isPending} onClick={(e) => { e.preventDefault(); setStatus("archived"); }}>
              {t(($) => $.lifecycle.archive)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteWorkflowDialog workflow={workflow} open={confirmDelete} onOpenChange={setConfirmDelete} onDeleted={onDeleted} />
    </div>
  );
}

/** Deleting asks for the workflow's key: it cannot be undone. */
function DeleteWorkflowDialog({
  workflow,
  open,
  onOpenChange,
  onDeleted,
}: {
  workflow: { id: string; key: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const remove = useDeleteWorkflow(wsId, workflow.id);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === workflow.key;

  const submit = () => {
    if (!matches || remove.isPending) return;
    setError(null);
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t(($) => $.lifecycle.deleted_done));
        onOpenChange(false);
        onDeleted();
      },
      onError: (e) => setError(deleteFailure(t, e)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setTyped("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(($) => $.lifecycle.delete_title, { name: workflow.name })}</DialogTitle>
            <DialogDescription>{t(($) => $.lifecycle.delete_description)}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor="workflow-delete-key">{t(($) => $.lifecycle.delete_type_key, { key: workflow.key })}</FieldLabel>
            <Input
              id="workflow-delete-key"
              className="font-mono"
              value={typed}
              autoComplete="off"
              aria-invalid={error !== null || undefined}
              onChange={(e) => {
                setTyped(e.target.value);
                setError(null);
              }}
            />
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(($) => $.lifecycle.cancel)}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || remove.isPending}>
              {t(($) => $.lifecycle.delete_confirm)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
