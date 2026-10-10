"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { LayoutGrid, Redo2, Save, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  STAGE_TYPES,
  addApproverGroup,
  addStage,
  autoLayout,
  canRedo,
  canUndo,
  commit,
  connect,
  createHistory,
  currentSnapshot,
  disconnect,
  redo,
  removeApproverGroup,
  removeStage,
  addBranch,
  removeBranch,
  renameApproverGroup,
  renamePositions,
  renameStage,
  setApproverGroup,
  setStart,
  stringifyDefinition,
  parseDefinitionText,
  resolvePositions,
  undo,
  updateMetadata,
  updateBranch,
  updateStage,
  useCreateWorkflow,
  useRestoreWorkflowVersion,
  useSaveWorkflowVersion,
  workflowVersionOptions,
  type EditRefusal,
  type Handle,
  type History,
  type Positions,
  type Snapshot,
  type StageType,
  type WorkflowDefinition,
} from "@multica/core/workflows";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { parseEdgeId, sizeOf, toFlowEdges, toFlowNodes } from "./flow";
import { nodeTypes } from "./nodes";
import { StageProperties, WorkflowSettings } from "./panels";
import { StageIcon } from "./stage-icon";
import { ProblemsPanel, ValidationBadge } from "./problems-panel";
import { useDefinitionValidation } from "./use-validation";
import { VersionsPanel } from "./versions-panel";
import { YamlEditor } from "./yaml-editor";

const DRAG_TYPE = "application/x-multica-workflow-stage";
const isStageType = (value: string): value is StageType => (STAGE_TYPES as readonly string[]).includes(value);

export interface DesignerInitial {
  definition: WorkflowDefinition;
  positions: Positions;
  /** 0 for a workflow that has never been saved. */
  version: number;
}

export interface WorkflowDesignerProps {
  /** Null while creating. */
  workflowId: string | null;
  initial: DesignerInitial;
  /** Called with the new workflow's id once the first version is saved. */
  onCreated: (id: string) => void;
  /** Open on the YAML tab, to import a workflow from text. */
  initialTab?: "canvas" | "yaml";
}

/** Positions of the stages that exist, rounded: what is stored with a version and compared for changes. */
function prune(def: WorkflowDefinition, positions: Positions): Positions {
  const out: Positions = {};
  for (const stage of def.stages) {
    const p = positions[stage.id];
    if (p !== undefined) out[stage.id] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return out;
}

function fingerprint(def: WorkflowDefinition, positions: Positions): string {
  const entries = Object.entries(prune(def, positions)).sort(([a], [b]) => a.localeCompare(b));
  return `${stringifyDefinition(def)}\n#${JSON.stringify(entries)}`;
}

type Tab = "canvas" | "yaml" | "versions";

type Banner = { kind: "conflict"; latest: number } | { kind: "key_taken"; key: string } | { kind: "invalid"; issues: string[] } | { kind: "failed" } | null;

function DesignerInner({ workflowId, initial, onCreated, initialTab }: WorkflowDesignerProps) {
  const { t } = useT("workflows");
  const wsId = useWorkspaceId();
  const flow = useReactFlow();
  const { resolvedTheme } = useTheme();
  const qc = useQueryClient();
  const create = useCreateWorkflow(wsId);
  const saveVersion = useSaveWorkflowVersion(wsId, workflowId ?? "");
  const restore = useRestoreWorkflowVersion(wsId, workflowId ?? "");

  const [history, setHistory] = useState<History>(() => createHistory({ definition: initial.definition, positions: initial.positions }));
  const { definition, positions } = currentSnapshot(history);

  // What was last saved: the version it got and a fingerprint to tell whether anything changed since.
  const [saved, setSaved] = useState(() => ({ version: initial.version, fingerprint: fingerprint(initial.definition, initial.positions) }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A branch picked on a parallel stage's node; the panel highlights it. Keyed by stage so a stale pick never shows on another one.
  const [branchPick, setBranchPick] = useState<{ stageId: string; index: number } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Positions>({});
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab ?? "canvas");
  const [working, setWorking] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // The server's opinion of what is on screen: problems, and the text a save would store.
  const text = useMemo(() => stringifyDefinition(definition), [definition]);
  const validation = useDefinitionValidation(wsId, text);
  const problemsByStage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of validation.issues) if (issue.stage_id) counts[issue.stage_id] = (counts[issue.stage_id] ?? 0) + 1;
    return counts;
  }, [validation.issues]);

  const dirty = fingerprint(definition, positions) !== saved.fingerprint;
  const isNew = saved.version === 0;
  const canSave = !saving && definition.metadata.id.trim() !== "" && (dirty || isNew);

  // ---- editing --------------------------------------------------------------------------------

  const edit = useCallback((change: (snapshot: Snapshot) => Snapshot | null, mergeKey?: string) => {
    setHistory((h) => {
      const current = currentSnapshot(h);
      const next = change(current);
      // A change that leaves everything as it was is not an undo step.
      if (next === null || JSON.stringify(next) === JSON.stringify(current)) return h;
      return commit(h, next, mergeKey === undefined ? {} : { mergeKey });
    });
  }, []);

  // Undo and redo from the keyboard, except while typing (text fields have their own undo).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        setHistory(undo);
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        setHistory(redo);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ---- canvas wiring ----------------------------------------------------------------------------

  const shownPositions = useMemo(() => ({ ...positions, ...dragged }), [positions, dragged]);
  const labels = useMemo<Partial<Record<Handle, string>>>(
    () => ({
      approve: t(($) => $.designer.edge.approve),
      reject: t(($) => $.designer.edge.reject),
      then: t(($) => $.designer.edge.then),
      else: t(($) => $.designer.edge.else),
    }),
    [t],
  );
  const branchEdit = useCallback(
    (stageId: string) => ({
      selectedBranch: branchPick?.stageId === stageId ? branchPick.index : null,
      onBranchSelect: (index: number) => setBranchPick({ stageId, index }),
      onBranchAdd: () => edit((s) => ({ ...s, definition: addBranch(s.definition, stageId) })),
      onBranchRemove: (index: number) => {
        setBranchPick(null);
        edit((s) => ({ ...s, definition: removeBranch(s.definition, stageId, index) }));
      },
    }),
    [branchPick, edit],
  );
  const nodes = useMemo(
    () => toFlowNodes(definition, shownPositions, problemsByStage, false, selectedId, branchEdit),
    [definition, shownPositions, problemsByStage, selectedId, branchEdit],
  );
  const edges = useMemo(() => toFlowEdges(definition, false, (h) => labels[h], selectedEdgeId), [definition, labels, selectedEdgeId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position !== undefined) {
        const { id, position } = change;
        setDragged((d) => ({ ...d, [id]: position }));
      } else if (change.type === "select") {
        if (change.selected) {
          setSelectedId(change.id);
          setSelectedEdgeId(null);
        } else {
          setSelectedId((current) => (current === change.id ? null : current));
        }
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "select") {
        if (change.selected) {
          setSelectedEdgeId(change.id);
          setSelectedId(null);
        } else {
          setSelectedEdgeId((current) => (current === change.id ? null : current));
        }
      }
    }
  }, []);

  const onNodeDragStop = useCallback(() => {
    const finished = dragged;
    setDragged({});
    if (Object.keys(finished).length === 0) return;
    edit((s) => ({ ...s, positions: { ...s.positions, ...finished } }));
  }, [dragged, edit]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.sourceHandle === null || connection.source === "") return;
      const handle = connection.sourceHandle as Handle;
      edit((s) => ({ ...s, definition: connect(s.definition, connection.source, handle, connection.target) }));
    },
    [edit],
  );

  const deleteStages = useCallback(
    (ids: string[]) => {
      // A deleted stage's connections are reported separately; one key keeps it one undo step.
      edit((s) => ({ ...s, definition: ids.reduce((d, id) => removeStage(d, id), s.definition) }), "delete");
      setSelectedId(null);
    },
    [edit],
  );

  const deleteEdges = useCallback(
    (ids: string[]) => {
      edit(
        (s) => ({
          ...s,
          definition: ids.reduce((d, id) => {
            const parsed = parseEdgeId(id);
            return parsed === undefined ? d : disconnect(d, parsed.source, parsed.handle);
          }, s.definition),
        }),
        "delete",
      );
      setSelectedEdgeId(null);
    },
    [edit],
  );

  const addAt = useCallback(
    (type: StageType, position: { x: number; y: number }) => {
      // The same id the edit below will give it, because both start from the same definition.
      const added = addStage(definition, type);
      edit((s) => {
        const result = addStage(s.definition, type);
        return { definition: result.definition, positions: { ...s.positions, [result.id]: position } };
      });
      setSelectedId(added.id);
      setSelectedEdgeId(null);
    },
    [definition, edit],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(DRAG_TYPE);
      if (!isStageType(type)) return;
      addAt(type, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addAt, flow],
  );

  const addAtCenter = (type: StageType) => {
    const box = wrapper.current?.getBoundingClientRect();
    const offset = (definition.stages.length % 6) * 28;
    const centre = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 100, y: 100 };
    addAt(type, { x: centre.x - 116 + offset, y: centre.y - 45 + offset });
  };

  const runAutoLayout = () => {
    edit((s) => ({ ...s, positions: autoLayout(s.definition, sizeOf) }));
    requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 200 }));
  };

  // ---- edits that can be refused: the panel says why --------------------------------------------

  /** Renaming rewrites every reference; the stage keeps its place and stays selected. */
  const renameSelected = (from: string, to: string): EditRefusal | null => {
    const result = renameStage(definition, from, to);
    if (!result.ok) return result;
    edit((s) => {
      const renamed = renameStage(s.definition, from, to);
      return renamed.ok ? { definition: renamed.definition, positions: renamePositions(s.positions, from, to) } : null;
    });
    setSelectedId(to);
    return null;
  };

  const renameGroup = (from: string, to: string): EditRefusal | null => {
    const result = renameApproverGroup(definition, from, to);
    if (!result.ok) return result;
    edit((s) => {
      const renamed = renameApproverGroup(s.definition, from, to);
      return renamed.ok ? { ...s, definition: renamed.definition } : null;
    });
    return null;
  };

  const addGroup = (name: string): EditRefusal | null => {
    const result = addApproverGroup(definition, name);
    if (!result.ok) return result;
    edit((s) => {
      const added = addApproverGroup(s.definition, name);
      return added.ok ? { ...s, definition: added.definition } : null;
    });
    return null;
  };

  // ---- problems and versions --------------------------------------------------------------------

  /** Put text that was edited or pasted on the canvas: one change that can be undone, keeping the places of stages that are still there. */
  const applyYaml = (next: WorkflowDefinition) => {
    edit((s) => ({ definition: next, positions: resolvePositions(next, s.positions, sizeOf) }));
    setSelectedId(null);
    setSelectedEdgeId(null);
    setBranchPick(null);
    setTab("canvas");
  };

  // What the YAML editor starts from: the server's form of the canvas, or, when the server cannot read the
  // canvas yet (a new workflow has no key), the canvas as plain text, so there is always somewhere to paste.
  const yamlStart = validation.canonical ?? (validation.known && !validation.checking ? text : undefined);

  const selectStage = (id: string) => {
    setTab("canvas");
    setSelectedId(id);
    setSelectedEdgeId(null);
    void flow.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 });
  };

  /** Read one saved version into an editor state; null when it cannot be read. */
  const readVersion = (version: { definition?: string | undefined; layout?: unknown } | null): Snapshot | null => {
    if (version === null || version.definition === undefined) return null;
    const parsed = parseDefinitionText(version.definition);
    if (!parsed.ok) return null;
    return { definition: parsed.definition, positions: resolvePositions(parsed.definition, version.layout, sizeOf) };
  };

  /** An old version's content becomes an ordinary edit: undoable, and saved as the newest on Save. */
  const openVersion = async (number: number) => {
    if (workflowId === null) return;
    setWorking(true);
    try {
      const snapshot = readVersion(await qc.fetchQuery(workflowVersionOptions(wsId, workflowId, number)));
      if (snapshot === null) throw new Error("unreadable");
      edit(() => snapshot);
      setTab("canvas");
      toast.success(t(($) => $.editor.versions.opened, { version: number }));
    } catch {
      toast.error(t(($) => $.editor.versions.open_failed));
    } finally {
      setWorking(false);
    }
  };

  /** The server saves the old content as the newest version; the editor then adopts it. */
  const restoreVersion = async (number: number) => {
    setWorking(true);
    try {
      const result = await restore.mutateAsync(number);
      const snapshot = readVersion(result.version);
      if (snapshot === null || result.version === null) throw new Error("unreadable");
      setHistory(createHistory(snapshot));
      setSaved({ version: result.version.version, fingerprint: fingerprint(snapshot.definition, snapshot.positions) });
      setSelectedId(null);
      setSelectedEdgeId(null);
      setBanner(null);
      setTab("canvas");
      toast.success(t(($) => $.editor.versions.restored, { from: number, to: result.version.version }));
    } catch {
      toast.error(t(($) => $.editor.versions.restore_failed));
    } finally {
      setWorking(false);
    }
  };

  // ---- saving -------------------------------------------------------------------------------------

  const save = async () => {
    setSaving(true);
    setBanner(null);
    const layout = prune(definition, positions);
    const body = { definition: stringifyDefinition(definition), layout, ...(note.trim() === "" ? {} : { note: note.trim() }) };
    try {
      const result = isNew
        ? await create.mutateAsync(body)
        : await saveVersion.mutateAsync({ ...body, base_version: saved.version });
      const version = result.version?.version ?? saved.version + 1;
      const problems = (result.version?.issues ?? []).length;
      setSaved({ version, fingerprint: fingerprint(definition, positions) });
      setNote("");
      toast.success(problems === 0 ? t(($) => $.editor.saved, { version }) : t(($) => $.editor.saved_with_problems, { version }));
      if (isNew) onCreated(result.workflow.id);
    } catch (error) {
      // Creating can only be refused with a conflict when the key is already used in this workspace.
      setBanner(isNew && error instanceof ApiError && error.status === 409 ? { kind: "key_taken", key: definition.metadata.id } : describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  // ---- selection panel ----------------------------------------------------------------------------

  const selectedStage = selectedId === null ? undefined : definition.stages.find((s) => s.id === selectedId);
  const selectedEdge = selectedEdgeId === null ? undefined : parseEdgeId(selectedEdgeId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="text-caption text-muted-foreground" data-testid="version-label">
          {isNew ? t(($) => $.editor.not_saved) : t(($) => $.editor.version, { version: saved.version })}
          {dirty && !isNew ? ` · ${t(($) => $.editor.unsaved)}` : ""}
        </span>
        <ValidationBadge validation={validation} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canUndo(history)} onClick={() => setHistory(undo)}>
            <Undo2 aria-hidden="true" className="size-3.5" />
            {t(($) => $.editor.undo)}
          </Button>
          <Button size="sm" variant="outline" disabled={!canRedo(history)} onClick={() => setHistory(redo)}>
            <Redo2 aria-hidden="true" className="size-3.5" />
            {t(($) => $.editor.redo)}
          </Button>
          <Button size="sm" variant="outline" disabled={definition.stages.length === 0} onClick={runAutoLayout}>
            <LayoutGrid aria-hidden="true" className="size-3.5" />
            {t(($) => $.editor.auto_layout)}
          </Button>
          <Input
            className="h-8 w-44"
            aria-label={t(($) => $.editor.note_label)}
            placeholder={t(($) => $.editor.note_placeholder)}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            <Save aria-hidden="true" className="size-3.5" />
            {saving ? t(($) => $.editor.saving) : t(($) => $.editor.save)}
          </Button>
        </div>
      </div>

      {banner === null ? null : <BannerView banner={banner} />}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-44 shrink-0 border-r p-3 md:block" aria-label={t(($) => $.editor.palette_title)}>
          <h2 className="mb-1 text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.editor.palette_title)}</h2>
          <p className="mb-3 text-caption text-muted-foreground">{t(($) => $.editor.palette_hint)}</p>
          <ul className="flex flex-col gap-2">
            {STAGE_TYPES.map((type) => (
              <li key={type}>
                <button
                  type="button"
                  draggable
                  data-stage-type={type}
                  className="flex w-full cursor-grab items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-body shadow-xs hover:bg-accent"
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => addAtCenter(type)}
                >
                  <StageIcon type={type} />
                  {typeLabel(t, type)}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div role="tablist" aria-label={t(($) => $.editor.views_label)} className="flex border-b px-2">
            {(["canvas", "yaml", ...(isNew ? [] : ["versions"])] as Tab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-body",
                  tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(id)}
              >
                {id === "canvas" ? t(($) => $.editor.tabs.canvas) : id === "yaml" ? t(($) => $.editor.tabs.yaml) : t(($) => $.editor.tabs.versions)}
              </button>
            ))}
          </div>
          <div className="relative min-h-0 flex-1">
        <div
          ref={wrapper}
          className={cn("absolute inset-0", tab !== "canvas" && "hidden")}
          aria-label={t(($) => $.editor.canvas_label)}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onNodesDelete={(deleted) => deleteStages(deleted.map((n) => n.id))}
            onEdgesDelete={(deleted) => deleteEdges(deleted.map((e) => e.id))}
            onPaneClick={() => {
              setSelectedId(null);
              setSelectedEdgeId(null);
            }}
            deleteKeyCode={["Backspace", "Delete"]}
            connectionRadius={30}
            minZoom={0.2}
            maxZoom={1.5}
            // Only an opened workflow is fitted to the screen; fitting a new canvas would move the
            // first stage away from where it was dropped.
            fitView={initial.definition.stages.length > 0}
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            colorMode={resolvedTheme === "dark" ? "dark" : "light"}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className={cn("hidden lg:block")} />
          </ReactFlow>
          {definition.stages.length === 0 ? (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-body text-muted-foreground">
              {t(($) => $.editor.empty_canvas)}
            </p>
          ) : null}
        </div>

            {tab === "yaml" ? (
              <section className="absolute inset-0" aria-label={t(($) => $.editor.tabs.yaml)}>
                {yamlStart === undefined ? (
                  <Skeleton className="m-4 h-64" aria-hidden="true" />
                ) : (
                  <YamlEditor canonical={yamlStart} lockedKey={isNew ? null : definition.metadata.id} onApply={applyYaml} />
                )}
              </section>
            ) : null}
            {tab === "versions" && workflowId !== null ? (
              <section className="absolute inset-0" aria-label={t(($) => $.editor.tabs.versions)}>
                <VersionsPanel
                  workflowId={workflowId}
                  latestVersion={saved.version}
                  dirty={dirty}
                  busy={working}
                  onOpen={(n) => void openVersion(n)}
                  onRestore={(n) => void restoreVersion(n)}
                />
              </section>
            ) : null}
          </div>
          <ProblemsPanel validation={validation} onSelect={selectStage} />
        </div>

        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label={t(($) => $.editor.properties_label)}>
          {selectedStage !== undefined ? (
            <StageProperties
              definition={definition}
              stage={selectedStage}
              onEdit={(partial, key) => edit((s) => ({ ...s, definition: updateStage(s.definition, selectedStage.id, partial) }), key)}
              onRename={(next) => renameSelected(selectedStage.id, next)}
              selectedBranch={branchPick?.stageId === selectedStage.id ? branchPick.index : null}
              onBranchAdd={() => edit((s) => ({ ...s, definition: addBranch(s.definition, selectedStage.id) }))}
              onBranchRemove={(index) => {
                setBranchPick(null);
                edit((s) => ({ ...s, definition: removeBranch(s.definition, selectedStage.id, index) }));
              }}
              onBranchEdit={(index, partial, key) => edit((s) => ({ ...s, definition: updateBranch(s.definition, selectedStage.id, index, partial) }), key)}
              onSetStart={() => edit((s) => ({ ...s, definition: setStart(s.definition, selectedStage.id) }))}
              onDisconnect={(handle) => edit((s) => ({ ...s, definition: disconnect(s.definition, selectedStage.id, handle) }))}
              onDelete={() => deleteStages([selectedStage.id])}
              onGroupMembers={(name, members) => edit((s) => ({ ...s, definition: setApproverGroup(s.definition, name, members) }), `group:${name}`)}
            />
          ) : selectedEdge !== undefined ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-body font-medium">{t(($) => $.editor.connection)}</h2>
              <p className="text-body">
                {selectedEdge.source} ({selectedEdge.handle})
              </p>
              <Button size="sm" variant="outline" onClick={() => deleteEdges([selectedEdgeId ?? ""])}>
                {t(($) => $.editor.delete_connection)}
              </Button>
            </div>
          ) : (
            <WorkflowSettings
              definition={definition}
              idLocked={!isNew}
              onMetadata={(edit_, key) => edit((s) => ({ ...s, definition: updateMetadata(s.definition, edit_) }), key)}
              onStart={(id) => edit((s) => ({ ...s, definition: id === "" ? { ...s.definition, start: "" } : setStart(s.definition, id) }))}
              onGroupMembers={(name, members) => edit((s) => ({ ...s, definition: setApproverGroup(s.definition, name, members) }), `group:${name}`)}
              onGroupRename={renameGroup}
              onGroupRemove={(name) => edit((s) => ({ ...s, definition: removeApproverGroup(s.definition, name) }))}
              onGroupAdd={addGroup}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function typeLabel(t: ReturnType<typeof useT<"workflows">>["t"], type: StageType): string {
  switch (type) {
    case "agent":
      return t(($) => $.designer.type.agent);
    case "parallel":
      return t(($) => $.designer.type.parallel);
    case "human_gate":
      return t(($) => $.designer.type.human_gate);
    case "condition":
      return t(($) => $.designer.type.condition);
    case "end":
      return t(($) => $.designer.type.end);
  }
}

/** What the server said about a failed save, as something the banner can show. */
function describeFailure(error: unknown): Banner {
  if (error instanceof ApiError) {
    const body = error.body;
    const code = typeof body === "object" && body !== null && "code" in body ? (body as { code?: unknown }).code : undefined;
    if (error.status === 409 && code === "version_conflict") {
      const latest = typeof body === "object" && body !== null && "latest_version" in body ? Number((body as { latest_version?: unknown }).latest_version) : 0;
      return { kind: "conflict", latest };
    }
    if (error.status === 400 && code === "invalid_definition") {
      const issues = typeof body === "object" && body !== null && "issues" in body && Array.isArray((body as { issues?: unknown }).issues)
        ? ((body as { issues: { message?: unknown; path?: unknown }[] }).issues)
        : [];
      const lines = issues.map((i) => `${typeof i.path === "string" && i.path !== "" ? `${i.path}: ` : ""}${typeof i.message === "string" ? i.message : ""}`);
      return { kind: "invalid", issues: lines };
    }
  }
  return { kind: "failed" };
}

function BannerView({ banner }: { banner: NonNullable<Banner> }) {
  const { t } = useT("workflows");
  return (
    <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-body text-destructive">
      {banner.kind === "conflict" ? (
        <p>{t(($) => $.editor.conflict, { version: banner.latest })}</p>
      ) : banner.kind === "key_taken" ? (
        <p>{t(($) => $.editor.key_taken, { key: banner.key })}</p>
      ) : banner.kind === "invalid" ? (
        <>
          <p>{t(($) => $.editor.invalid)}</p>
          <ul className="list-disc pl-5 text-caption">
            {banner.issues.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t(($) => $.editor.save_failed)}</p>
      )}
    </div>
  );
}

export default function WorkflowDesigner(props: WorkflowDesignerProps) {
  return (
    <ReactFlowProvider>
      <DesignerInner {...props} />
    </ReactFlowProvider>
  );
}
