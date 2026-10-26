"use client";

import { Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";

/** A file name for a workflow's YAML: its key, which is already lowercase kebab-case, else a plain default. */
export function yamlFileName(key: string): string {
  return `${/^[a-z0-9-]+$/.test(key) && key !== "" ? key : "workflow"}.yaml`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Take a workflow out of Multica as text: download it as a file or copy it. The text is what the
 * server stores, so importing it into another workspace or environment gives the same workflow.
 */
export function YamlExportButtons({ text, fileName, disabled = false }: { text: string | undefined; fileName: string; disabled?: boolean }) {
  const { t } = useT("workflows");
  const off = disabled || text === undefined;
  return (
    <>
      <Button size="sm" variant="outline" disabled={off} onClick={() => text !== undefined && download(fileName, text)}>
        <Download aria-hidden="true" className="size-3.5" />
        {t(($) => $.editor.yaml.download)}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={off}
        onClick={() => {
          if (text === undefined) return;
          navigator.clipboard.writeText(text).then(
            () => toast.success(t(($) => $.editor.yaml.copied)),
            () => toast.error(t(($) => $.editor.yaml.copy_failed)),
          );
        }}
      >
        <Copy aria-hidden="true" className="size-3.5" />
        {t(($) => $.editor.yaml.copy)}
      </Button>
    </>
  );
}
