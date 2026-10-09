"use client";

import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { CodeBlock } from "@multica/ui/markdown";
import { useT } from "../../i18n";

/** The exact text a save would store, as the server writes it: read only, never edited here. */
export function YamlPreview({ canonical }: { canonical: string | undefined }) {
  const { t } = useT("workflows");
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-4">
      <p className="text-caption text-muted-foreground">{t(($) => $.editor.yaml.hint)}</p>
      {canonical === undefined ? <Skeleton className="h-64 w-full" aria-hidden="true" /> : <CodeBlock code={canonical} language="yaml" mode="full" />}
    </div>
  );
}
