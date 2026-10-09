"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { squadListOptions } from "@multica/core/workspace/queries";
import { useApplyWorkflow, workflowRenderOptions } from "@multica/core/workflows";
import type { WorkflowMember } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { conflictingWorkflowKey, workflowErrorCode } from "./workflow-state";

interface ApplyWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  workflowKey: string;
  /** The version being shown; that is the one applied. */
  version: number;
}

export function ApplyWorkflowDialog({
  open,
  onOpenChange,
  workflowId,
  workflowKey,
  version,
}: ApplyWorkflowDialogProps) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const [squadId, setSquadId] = useState("");
  // Set by a 409 "squad_has_workflow": the key of the workflow in the way.
  const [conflict, setConflict] = useState<string | null>(null);
  const [blockInvalid, setBlockInvalid] = useState(false);
  // Set when the squad already held exactly this version: nothing was written, and the
  // dialog stays open so that the answer cannot be missed.
  const [unchanged, setUnchanged] = useState(false);

  const squads = useQuery({ ...squadListOptions(wsId), enabled: open });
  const preview = useQuery(
    workflowRenderOptions(wsId, workflowId, { version, squadId }, open && squadId !== ""),
  );
  const apply = useApplyWorkflow(wsId, workflowId);

  const squadList = (squads.data ?? []).filter((s) => s.archived_at === null);
  const squadName = squadList.find((s) => s.id === squadId)?.name ?? "";

  const reset = () => {
    setConflict(null);
    setBlockInvalid(false);
    setUnchanged(false);
    apply.reset();
  };

  const submit = (replace: boolean) => {
    setBlockInvalid(false);
    apply.mutate(
      { squad_id: squadId, version, replace },
      {
        onSuccess: (result) => {
          const added = result.members.filter((m) => m.status === "added").length;
          if (!result.applied && added === 0) {
            setUnchanged(true);
            return;
          }
          toast.success(
            result.applied
              ? added > 0
                ? t(($) => $.apply.success_members, { version, squad: squadName, count: added })
                : t(($) => $.apply.success, { version, squad: squadName })
              : t(($) => $.apply.members_only, { version, squad: squadName, count: added }),
          );
          onOpenChange(false);
        },
        onError: (error) => {
          const code = workflowErrorCode(error);
          if (code === "squad_has_workflow") {
            setConflict(conflictingWorkflowKey(error));
          } else if (code === "managed_block_invalid") {
            setBlockInvalid(true);
          } else {
            toast.error(t(($) => $.apply.failed));
          }
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSquadId("");
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.apply.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.apply.description, { version })}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-caption text-muted-foreground" htmlFor="apply-workflow-squad">
              {t(($) => $.apply.squad_label)}
            </label>
            {squads.isSuccess && squadList.length === 0 ? (
              <p className="text-body text-muted-foreground">{t(($) => $.apply.no_squads)}</p>
            ) : (
              <Select
                items={squadList.map((s) => ({ value: s.id, label: s.name }))}
                value={squadId}
                onValueChange={(next) => {
                  setSquadId(next ?? "");
                  reset();
                }}
              >
                <SelectTrigger id="apply-workflow-squad" className="w-full">
                  <SelectValue placeholder={t(($) => $.apply.squad_placeholder)} />
                </SelectTrigger>
                <SelectContent>
                  {squadList.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {squadId !== "" ? (
            <section className="flex flex-col gap-1.5" aria-label={t(($) => $.apply.preview_label)}>
              <h3 className="text-caption text-muted-foreground">{t(($) => $.apply.preview_label)}</h3>
              {preview.isError ? (
                <p role="alert" className="text-body text-destructive">
                  {t(($) => $.apply.preview_failed)}
                </p>
              ) : preview.data ? (
                <>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-caption">
                    {preview.data.instructions}
                  </pre>
                  {preview.data.labels.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-caption text-muted-foreground">{t(($) => $.apply.labels_title)}</h3>
                      <p className="flex flex-wrap gap-1.5">
                        {preview.data.labels.map((label) => (
                          <code key={label} className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption">
                            {label}
                          </code>
                        ))}
                      </p>
                      <p className="text-caption text-muted-foreground">{t(($) => $.apply.labels_hint)}</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <Skeleton className="h-40 w-full" aria-hidden="true" />
              )}
            </section>
          ) : null}

          {squadId !== "" && preview.data ? <MembersPreview members={preview.data.members} /> : null}

          {conflict !== null ? (
            <div role="alert" className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-body">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">{t(($) => $.apply.conflict_title)}</p>
                <p className="text-caption text-muted-foreground">
                  {conflict === ""
                    ? t(($) => $.apply.conflict_body_unnamed, { key: workflowKey })
                    : t(($) => $.apply.conflict_body, { workflow: conflict, key: workflowKey })}
                </p>
              </div>
            </div>
          ) : null}
          {unchanged ? (
            <p role="status" className="text-body text-muted-foreground">
              {t(($) => $.apply.unchanged, { version, squad: squadName })}
            </p>
          ) : null}
          {blockInvalid ? (
            <p role="alert" className="text-body text-destructive">
              {t(($) => $.apply.invalid_block)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.apply.cancel)}
          </Button>
          {conflict !== null ? (
            <Button onClick={() => submit(true)} disabled={apply.isPending}>
              {t(($) => $.apply.confirm_replace)}
            </Button>
          ) : (
            <Button onClick={() => submit(false)} disabled={squadId === "" || !preview.isSuccess || apply.isPending || unchanged}>
              {t(($) => $.apply.confirm)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The agents and approvers the workflow names, and what applying does about each. */
function MembersPreview({ members }: { members: WorkflowMember[] }) {
  const { t } = useT("workflows");
  return (
    <section className="flex flex-col gap-1.5" aria-label={t(($) => $.apply.members_title)}>
      <h3 className="text-caption text-muted-foreground">{t(($) => $.apply.members_title)}</h3>
      {members.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.apply.members_empty)}</p>
      ) : (
        <>
          <p className="text-caption text-muted-foreground">{t(($) => $.apply.members_hint)}</p>
          <ul className="flex flex-col divide-y rounded-lg border text-body">
            {members.map((m) => (
              <li key={`${m.kind}:${m.ref}`} className="flex flex-wrap items-center gap-x-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {m.name ? m.name : <code className="text-caption text-muted-foreground">{m.ref}</code>}
                </span>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {m.kind === "agent" ? t(($) => $.apply.member_agent) : t(($) => $.apply.member_person)}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-caption",
                    m.status === "unresolved" ? "text-warning" : m.status === "present" ? "text-muted-foreground" : "text-success",
                  )}
                >
                  {m.status === "unresolved"
                    ? t(($) => $.apply.member_unresolved)
                    : m.status === "present"
                      ? t(($) => $.apply.member_present)
                      : t(($) => $.apply.member_add)}
                </span>
                {m.can_wake_leader === false ? (
                  <p role="alert" className="basis-full text-caption text-warning">
                    {t(($) => $.apply.member_cannot_wake)}
                  </p>
                ) : null}
                {m.cannot_run_agents && m.cannot_run_agents.length > 0 ? (
                  <p role="alert" className="basis-full text-caption text-warning">
                    {t(($) => $.apply.member_cannot_run, { agents: m.cannot_run_agents.join(", ") })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
