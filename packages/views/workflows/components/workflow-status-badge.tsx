"use client";

import { Badge } from "@multica/ui/components/ui/badge";
import { useT } from "../../i18n";

/**
 * Status is a server-driven string: a value this client does not know is shown
 * as received rather than hidden or mislabelled.
 */
export function WorkflowStatusBadge({ status }: { status: string }) {
  const { t } = useT("workflows");
  if (status === "active") {
    return <Badge variant="secondary">{t(($) => $.status.active)}</Badge>;
  }
  if (status === "archived") {
    return <Badge variant="outline">{t(($) => $.status.archived)}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}
