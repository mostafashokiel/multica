"use client";

import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { LOOP_HEAD_CLEARANCE } from "./flow";

type Point = { x: number; y: number };

/** A path through the points with rounded corners: straight lines, each corner replaced by a small curve. */
export function roundedPath(points: Point[], radius: number): string {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  let d = `M${String(first.x)} ${String(first.y)}`;
  for (let i = 0; i < rest.length; i++) {
    const here = rest[i] as Point;
    const before = (points[i] as Point);
    const after = rest[i + 1];
    if (after === undefined) {
      d += ` L${String(here.x)} ${String(here.y)}`;
      break;
    }
    const lenIn = Math.hypot(here.x - before.x, here.y - before.y);
    const lenOut = Math.hypot(after.x - here.x, after.y - here.y);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    if (r === 0) {
      d += ` L${String(here.x)} ${String(here.y)}`;
      continue;
    }
    const inPoint = { x: here.x - ((here.x - before.x) / lenIn) * r, y: here.y - ((here.y - before.y) / lenIn) * r };
    const outPoint = { x: here.x + ((after.x - here.x) / lenOut) * r, y: here.y + ((after.y - here.y) / lenOut) * r };
    d += ` L${String(inPoint.x)} ${String(inPoint.y)} Q${String(here.x)} ${String(here.y)} ${String(outPoint.x)} ${String(outPoint.y)}`;
  }
  return d;
}

/** The corners of a rework loop: out to the corridor, along it, back to just above the target, then down into it. */
export function loopPoints(source: Point, target: Point, corridorX: number): Point[] {
  const turnY = target.y - LOOP_HEAD_CLEARANCE;
  return [source, { x: corridorX, y: source.y }, { x: corridorX, y: turnY }, { x: target.x, y: turnY }, target];
}

/**
 * A rework loop (see `loopCorridors` in flow.ts): it runs outside the diagram, so it never crosses a stage.
 * The label sits on the corridor, where nothing else is.
 */
export function LoopEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, selected, data }: EdgeProps) {
  const corridorX = typeof data?.corridorX === "number" ? data.corridorX : sourceX + 56;
  const points = loopPoints({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, corridorX);
  const turnY = (points[2] as Point).y;
  return (
    <BaseEdge
      path={roundedPath(points, 8)}
      markerEnd={markerEnd}
      style={{ ...style, ...(selected === true ? { strokeWidth: 3 } : {}) }}
      interactionWidth={16}
      label={label}
      labelX={corridorX}
      labelY={(sourceY + turnY) / 2}
      labelStyle={labelStyle}
      labelShowBg
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}

export const edgeTypes = { loop: LoopEdge };
