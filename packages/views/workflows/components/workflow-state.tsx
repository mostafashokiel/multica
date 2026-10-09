"use client";

import { AlertCircle, Lock } from "lucide-react";
import { ApiError } from "@multica/core/api";
import { CollectionPageState } from "../../layout/collection-page";
import { useT } from "../../i18n";

/**
 * With `workflows_v1` off the server answers every /api/workflows request with
 * 403 `workflows_disabled`. That is not a failure to retry, so it gets its own
 * state instead of the generic error.
 */
export function isWorkflowsDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function WorkflowsDisabledState() {
  const { t } = useT("workflows");
  return (
    <CollectionPageState
      icon={Lock}
      title={t(($) => $.page.disabled_title)}
      description={t(($) => $.page.disabled_description)}
    />
  );
}

export function WorkflowsErrorState({ message }: { message: string }) {
  return <CollectionPageState icon={AlertCircle} tone="destructive" role="alert" title={message} />;
}

/** The machine-readable `code` of a failed workflow request, when it has one. */
export function workflowErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string") {
    return body.code;
  }
  return null;
}

/** The workflow key a 409 `squad_has_workflow` names, when it names one. */
export function conflictingWorkflowKey(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (typeof body === "object" && body !== null && "workflow" in body && typeof body.workflow === "string") {
      return body.workflow;
    }
  }
  return "";
}
