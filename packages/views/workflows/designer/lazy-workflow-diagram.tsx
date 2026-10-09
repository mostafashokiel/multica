"use client";

import { Suspense, lazy } from "react";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";

// The canvas library is large and only needed once someone opens a diagram, so it is
// loaded on demand rather than with the page.
const WorkflowDiagram = lazy(() => import("./workflow-diagram"));

export function LazyWorkflowDiagram(props: React.ComponentProps<typeof WorkflowDiagram>) {
  const { t } = useT("workflows");
  return (
    <Suspense fallback={<Skeleton className="h-[360px] w-full" role="status" aria-label={t(($) => $.designer.loading)} />}>
      <WorkflowDiagram {...props} />
    </Suspense>
  );
}
