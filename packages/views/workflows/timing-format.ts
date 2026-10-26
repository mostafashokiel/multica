import { useT } from "../i18n";
import { formatDuration } from "../dashboard/utils";

/** Formats a number of seconds the way the timing views show it: "1h 23m", "12m 30s", "45s". */
export function useDurationFormat() {
  const { t } = useT("issues");
  const under = t(($) => $.workflows.timing.under_minute);
  return (seconds: number) => formatDuration(seconds, under);
}
