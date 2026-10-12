import { describe, expect, it } from "vitest";
import { formatDuration, secondsBetween } from "./duration";

describe("formatDuration", () => {
  it("writes what a clock would", () => {
    const cases: [number, string][] = [
      [0, "0s"],
      [39, "39s"],
      [59, "59s"],
      [60, "1m 0s"],
      [809, "13m 29s"],
      [3599, "59m 59s"],
      [3600, "1h 0m"],
      [8040, "2h 14m"],
      [86399, "23h 59m"],
      [86400, "1d 0h"],
      [3 * 86400 + 4 * 3600 + 59, "3d 4h"],
    ];
    for (const [seconds, text] of cases) expect(formatDuration(seconds), String(seconds)).toBe(text);
  });

  it("rounds, and never shows a negative or a broken number", () => {
    expect(formatDuration(59.6)).toBe("1m 0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("secondsBetween", () => {
  it("counts whole seconds up to a moment, and is 0 for what it cannot read", () => {
    const from = "2026-10-10T21:00:00Z";
    expect(secondsBetween(from, Date.parse("2026-10-10T21:01:30.900Z"))).toBe(90);
    expect(secondsBetween(from, Date.parse("2026-10-10T20:00:00Z"))).toBe(0);
    expect(secondsBetween("garbage", Date.now())).toBe(0);
    expect(secondsBetween(undefined, Date.now())).toBe(0);
  });
});
