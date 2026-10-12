/**
 * A length of time as people read it on a clock: "39s", "13m 29s", "2h 14m", "3d 4h". Two units at most, the
 * larger first, and nothing finer than a minute once it is an hour or more, so a column of times stays easy to
 * compare. The units are the same letters in every language.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  if (s < 60) return `${String(s)}s`;
  const minutes = Math.floor(s / 60);
  if (s < 3600) return `${String(minutes)}m ${String(s % 60)}s`;
  const hours = Math.floor(s / 3600);
  if (s < 86400) return `${String(hours)}h ${String(minutes % 60)}m`;
  const days = Math.floor(s / 86400);
  return `${String(days)}d ${String(hours % 24)}h`;
}

/** Whole seconds between two ISO times, never negative; 0 when either cannot be read. */
export function secondsBetween(fromIso: string | undefined, toMs: number): number {
  if (fromIso === undefined) return 0;
  const from = Date.parse(fromIso);
  return Number.isNaN(from) ? 0 : Math.max(0, Math.floor((toMs - from) / 1000));
}
