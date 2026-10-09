import { Bot, Columns3, Flag, Split, UserCheck, type LucideIcon } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import type { StageType } from "@multica/core/workflows";

// One small icon per stage type, so a person and an agent can be told apart at a glance: the robot is
// work an agent does, the person with a check is a human decision. Colours match each type's accent.
const ICON: Record<StageType, { icon: LucideIcon; tone: string }> = {
  agent: { icon: Bot, tone: "text-brand" },
  parallel: { icon: Columns3, tone: "text-brand" },
  human_gate: { icon: UserCheck, tone: "text-warning" },
  condition: { icon: Split, tone: "text-info" },
  end: { icon: Flag, tone: "text-muted-foreground" },
};

/** Decorative: the type's name is always written next to it, so it is hidden from assistive technology. */
export function StageIcon({ type, className }: { type: StageType; className?: string }) {
  const { icon: Icon, tone } = ICON[type];
  return <Icon aria-hidden="true" data-stage-icon={type} className={cn("size-3.5 shrink-0", tone, className)} />;
}
