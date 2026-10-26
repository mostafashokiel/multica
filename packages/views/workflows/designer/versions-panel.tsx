"use client";

import { useQuery } from "@tanstack/react-query";
import { History as HistoryIcon, RotateCcw } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { workflowVersionsOptions } from "@multica/core/workflows";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";

/**
 * The saved versions of the workflow. "Open" puts a version's content into the editor as an
 * ordinary, undoable edit; "Restore" asks the server to save it as the newest version.
 */
export function VersionsPanel({
  workflowId,
  latestVersion,
  dirty,
  busy,
  onOpen,
  onRestore,
}: {
  workflowId: string;
  latestVersion: number;
  /** Restoring replaces the editor's content, so it waits until there is nothing unsaved. */
  dirty: boolean;
  busy: boolean;
  onOpen: (version: number) => void;
  onRestore: (version: number) => void;
}) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const timeAgo = useTimeAgo();
  const versions = useQuery(workflowVersionsOptions(wsId, workflowId));

  if (versions.isError) return <p role="alert" className="p-4 text-body text-destructive">{t(($) => $.detail.load_failed)}</p>;
  if (versions.isLoading || !versions.data) return <Skeleton className="m-4 h-32" aria-hidden="true" />;
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-4">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <HistoryIcon aria-hidden="true" className="size-3.5" />
        {dirty ? t(($) => $.editor.versions.restore_blocked) : t(($) => $.editor.versions.hint)}
      </p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {versions.data.map((v) => (
          <li key={v.id} className="flex items-center gap-3 px-3 py-2.5">
            <Badge variant="outline" className="shrink-0 font-mono tabular-nums">
              {t(($) => $.history.version, { version: v.version })}
            </Badge>
            {v.version === latestVersion ? <Badge variant="secondary">{t(($) => $.detail.latest_badge)}</Badge> : null}
            <div className="min-w-0 flex-1">
              <p className={v.note ? "truncate text-body" : "truncate text-body text-muted-foreground"}>{v.note || t(($) => $.history.note_empty)}</p>
              <p className="truncate text-caption text-muted-foreground">{v.created_at ? timeAgo(v.created_at) : ""}</p>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpen(v.version)}>
              {t(($) => $.editor.versions.open)}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || dirty || v.version === latestVersion} onClick={() => onRestore(v.version)}>
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {t(($) => $.editor.versions.restore)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
