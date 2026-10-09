"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import { STAGE_HANDLES, handleTarget, type Handle, type Positions, type WorkflowDefinition } from "@multica/core/workflows";
import { useT } from "../../i18n";
import { contentHeight, toFlowEdges, toFlowNodes } from "./flow";
import { nodeTypes } from "./nodes";

interface WorkflowDiagramProps {
  definition: WorkflowDefinition;
  positions: Positions;
  /** Stage id to the number of problems the server reported on it. */
  problemsByStage?: Readonly<Record<string, number>>;
}

const NO_PROBLEMS: Readonly<Record<string, number>> = {};

/**
 * A read-only picture of one workflow version, drawn with React Flow. This module is the
 * only place the canvas library is imported for viewing, and it is loaded on demand
 * (see `LazyWorkflowDiagram`), so pages that never open a diagram never download it.
 * Every string is server text and is drawn as text.
 */
function WorkflowDiagram({ definition, positions, problemsByStage = NO_PROBLEMS }: WorkflowDiagramProps) {
  const { t } = useT("workflows");
  const { resolvedTheme } = useTheme();

  const labels = useMemo<Partial<Record<Handle, string>>>(
    () => ({
      approve: t(($) => $.designer.edge.approve),
      reject: t(($) => $.designer.edge.reject),
      then: t(($) => $.designer.edge.then),
      else: t(($) => $.designer.edge.else),
    }),
    [t],
  );
  const nodes = useMemo(() => toFlowNodes(definition, positions, problemsByStage, true), [definition, positions, problemsByStage]);
  const edges = useMemo(() => toFlowEdges(definition, true, (handle) => labels[handle]), [definition, labels]);

  // As tall as the stages need, within reason: a long chain squeezed into a short box is unreadable.
  const height = Math.min(920, Math.max(360, contentHeight(definition, positions) + 120));

  return (
    <div className="flex flex-col gap-2">
      <div
        style={{ height }}
        className="overflow-hidden rounded-lg border bg-muted/20"
        role="group"
        aria-label={t(($) => $.designer.aria_label, { count: definition.stages.length })}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // The page scrolls over the picture; zoom with the controls or a pinch.
          zoomOnScroll={false}
          preventScrolling={false}
          minZoom={0.2}
          maxZoom={1.5}
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="text-caption text-muted-foreground">{t(($) => $.designer.legend)}</p>
      {/* The picture is not readable by a screen reader, so the same facts are listed. */}
      <ul className="sr-only">
        {definition.stages.flatMap((stage) => [
          <li key={stage.id}>{`${stage.name ?? stage.id} (${stage.type})`}</li>,
          ...STAGE_HANDLES[stage.type].flatMap((handle) => {
            const target = handleTarget(stage, handle);
            return target === "" ? [] : [<li key={`${stage.id}:${handle}`}>{t(($) => $.designer.transition, { from: stage.name ?? stage.id, to: target })}</li>];
          }),
        ])}
      </ul>
    </div>
  );
}

export default function WorkflowDiagramWithProvider(props: WorkflowDiagramProps) {
  return (
    <ReactFlowProvider>
      <WorkflowDiagram {...props} />
    </ReactFlowProvider>
  );
}
