/**
 * Workflows (flag `workflows_v1`): a workspace-level, versioned definition of
 * the stages work moves through. The server owns validation and the canonical
 * YAML text; the client only displays them.
 */

/** "active" | "archived" today; server-driven, so kept open. */
export type WorkflowStatus = string;

export interface Workflow {
  id: string;
  /** Stable kebab-case id from the definition's `metadata.id`. */
  key: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  latest_version: number;
  /** Optimistic-concurrency counter for the head; bumped on every change. */
  revision: number;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

/** One problem found while parsing or validating a definition. */
export interface WorkflowIssue {
  /** Stable rule code (V001...). Absent for parse problems. */
  code?: string;
  message: string;
  stage_id?: string;
  field?: string;
  /** Location of a parse problem in the YAML text. */
  path?: string;
  line?: number;
}

export interface WorkflowVersion {
  id: string;
  workflow_id: string;
  version: number;
  content_hash: string;
  note: string;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  /** Canonical YAML. Present on a single-version read, absent in the list. */
  definition?: string;
  /** Designer layout (positions); opaque to everything but the designer. */
  layout?: unknown;
  issues?: WorkflowIssue[];
}

export interface WorkflowWithVersion {
  workflow: Workflow;
  version: WorkflowVersion | null;
}

export interface WorkflowAuditEntry {
  action: string;
  version?: number;
  actor_type: string;
  actor_id: string;
  detail: unknown;
  created_at: string;
}

export interface ListWorkflowsResponse {
  workflows: Workflow[];
}

export interface ListWorkflowVersionsResponse {
  versions: WorkflowVersion[];
}

export interface ListWorkflowAuditResponse {
  audit: WorkflowAuditEntry[];
}

/**
 * An agent or person a workflow names, and what applying does (or did) about it.
 * `add` and `present` come from a preview; `added` and `present` from an apply.
 */
export interface WorkflowMember {
  kind: "agent" | "person";
  /** As the workflow writes it: an agent's name, or `user:<id>`. */
  ref: string;
  id?: string;
  name?: string;
  status: "add" | "added" | "present" | "unresolved";
  /**
   * For a registered person: whether their comment wakes the squad's leader. False when the
   * leader is private to its owner. Absent for agents and when it could not be told.
   */
  can_wake_leader?: boolean;
  /**
   * For a registered person: the workflow's agents that work delegated after their comment
   * cannot reach, because those agents are private to someone else. Absent when none.
   */
  cannot_run_agents?: string[];
}

/** A version rendered as the briefing a squad leader follows (nothing is written). */
export interface WorkflowRender {
  workflow_key: string;
  version: number;
  content_hash: string;
  squad_name: string;
  /** The managed block exactly as "apply" writes it into a squad's instructions. */
  instructions: string;
  /** Labels the workflow implies; they must exist in the workspace. */
  labels: string[];
  /** The agents and approvers the workflow names, for the chosen squad. */
  members: WorkflowMember[];
}

export interface RenderWorkflowRequest {
  /** Defaults to the newest version. */
  version?: number;
  squad_id?: string;
}

export interface ApplyWorkflowRequest {
  squad_id: string;
  /** Defaults to the newest version. */
  version?: number;
  /** Take over a squad that already follows a different workflow. */
  replace?: boolean;
}

export interface WorkflowApplyResult {
  /** False when the squad already held exactly this briefing. */
  applied: boolean;
  squad_id: string;
  workflow_key: string;
  version: number;
  content_hash: string;
  replaced_workflow?: string;
  labels: string[];
  members: WorkflowMember[];
}

/** A squad whose instructions carry this workflow's managed block. */
export interface WorkflowSquad {
  squad_id: string;
  name: string;
  /** The version the squad holds. */
  version: number;
  content_hash: string;
  /** True when the squad holds the newest version, byte for byte. */
  up_to_date: boolean;
}

export interface ListWorkflowSquadsResponse {
  squads: WorkflowSquad[];
}

/** One issue in a workflow's pipeline. */
export interface WorkflowPipelineIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee_type?: string;
  assignee_id?: string;
  updated_at: string;
  /** The phase:* labels the issue carries; only filled where they do not name exactly one stage. */
  phases?: string[];
  /** The issue's sub-issues, oldest first. A parallel stage hands each branch to an agent as one. */
  children?: WorkflowPipelineChild[];
  /** When the issue entered the stage it is in now, and when its run started; absent when nothing was recorded. */
  stage_entered_at?: string;
  run_started_at?: string;
}

/** One sub-issue of an issue in a workflow's pipeline. */
export interface WorkflowPipelineChild {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee_type?: string;
  assignee_id?: string;
  created_at: string;
  /** How long agents have worked on it, in seconds. */
  work_seconds?: number;
  closed_at?: string;
  /** Done or cancelled: the states that wake the squad leader again. */
  closed: boolean;
  cancelled: boolean;
}

/** A person a human gate waits for. `id` and `name` are set only for a registered member of the workspace. */
export interface WorkflowPipelineApprover {
  /** As the workflow writes it (`user:<id>`). */
  ref: string;
  id?: string;
  name?: string;
}

/** A stage where work can wait, with the issues in it. */
export interface WorkflowPipelineStage {
  id: string;
  name: string;
  type: string;
  /** Who a human gate waits for, in the workflow's order; empty for other stages. */
  approvers: WorkflowPipelineApprover[];
  issues: WorkflowPipelineIssue[];
  /** The median time issues stayed in this stage, when at least two stays are over. */
  typical_seconds?: number;
  typical_samples?: number;
}

/** Where the issues that follow a workflow stand, read from the labels the squad leader keeps. */
export interface WorkflowPipeline {
  workflow_key: string;
  /** The newest version; its stages are the columns. */
  version: number;
  stages: WorkflowPipelineStage[];
  /** Carry the workflow's label but no phase label: not started. */
  no_stage: WorkflowPipelineIssue[];
  /** Carry more than one phase label. */
  conflicting: WorkflowPipelineIssue[];
  /** Carry a phase label that names no stage of the newest version. */
  unknown_stage: WorkflowPipelineIssue[];
  total: number;
  /** More issues carry the label than the answer holds. */
  truncated: boolean;
}

/** What the server says about a definition it was asked to check; nothing is saved. */
export interface ValidateWorkflowResult {
  /** False when the text could not be read at all (then there is no canonical text). */
  parsed: boolean;
  valid: boolean;
  issues: WorkflowIssue[];
  /** The text a save would store, when the definition parsed, problems or not. */
  canonical?: string;
}

/** Node positions by stage id; stored with a version and opaque to the server. */
export type WorkflowLayout = Record<string, { x: number; y: number }>;

export interface CreateWorkflowRequest {
  definition: string;
  /** Display name; defaults to the description, then the key. */
  name?: string;
  layout?: WorkflowLayout;
  note?: string;
}

/** Change a workflow's name or description, or archive or restore it. `revision` is the one the caller loaded: a stale one answers 409. */
export interface UpdateWorkflowRequest {
  name?: string;
  description?: string;
  /** Archive (hide, stop edits and applies) or restore. */
  status?: "active" | "archived";
  revision: number;
}

export interface SaveWorkflowVersionRequest {
  definition: string;
  /** The newest version the editor loaded; a newer one saved since answers 409. */
  base_version: number;
  layout?: WorkflowLayout;
  note?: string;
}

// ---- timing ---------------------------------------------------------------------------------

/** One branch of a parallel stage, as it ran. */
export interface WorkflowRunBranch {
  id: string;
  identifier: string;
  title: string;
  agent?: string;
  status: string;
  started_at: string;
  ended_at?: string;
  /** How long agents worked on it. */
  work_seconds: number;
  /** From its creation to its closing (or now). */
  elapsed_seconds: number;
  closed: boolean;
  cancelled: boolean;
}

/** One stay of an issue in one stage. An issue sent back for rework visits a stage again. */
export interface WorkflowRunVisit {
  stage_id: string;
  name: string;
  type: string;
  /** 1 for the first visit to the stage, 2 after a rework. */
  number: number;
  entered_at: string;
  left_at?: string;
  /** The issue is in this stage now. */
  open: boolean;
  elapsed_seconds: number;
  agent?: string;
  /** Agent time on the critical path: the stage agent's runs, or the slowest branch. */
  agent_seconds: number;
  branches: WorkflowRunBranch[];
  /** Human gates: the wait until an approver's first comment. */
  wait_seconds: number;
  decided_at?: string;
  decided_by?: WorkflowPipelineApprover;
  /** approved, rejected or waiting; empty for other stages. */
  outcome?: string;
}

export interface WorkflowRunTimeline {
  started_at?: string;
  ended_at?: string;
  /** Not finished: the totals count up to now. */
  open: boolean;
  elapsed_seconds: number;
  agent_seconds: number;
  people_seconds: number;
  handoff_seconds: number;
  reworks: number;
  parallel_saved_seconds: number;
  visits: WorkflowRunVisit[];
}

/** How long one run of a workflow took, and where the time went. */
export interface WorkflowRun {
  workflow: { id: string; key: string; name: string };
  issue: { id: string; identifier: string; title: string; status: string };
  timeline: WorkflowRunTimeline;
}

export interface WorkflowInsightStage {
  stage_id: string;
  name: string;
  type: string;
  visits: number;
  open_visits: number;
  median_seconds: number;
  p90_seconds: number;
  total_seconds: number;
  rejected: number;
}

export interface WorkflowInsightAgent {
  agent: string;
  runs: number;
  median_seconds: number;
  p90_seconds: number;
  total_seconds: number;
}

export interface WorkflowInsightApprover {
  ref: string;
  id?: string;
  name?: string;
  decisions: number;
  median_seconds: number;
  p90_seconds: number;
  slowest_seconds: number;
}

/** The runs of a workflow that began in a window, summarised. */
export interface WorkflowInsights {
  workflow_key: string;
  days: number;
  runs: number;
  finished: number;
  open: number;
  truncated: boolean;
  median_elapsed_seconds: number;
  p90_elapsed_seconds: number;
  median_agent_seconds: number;
  median_people_seconds: number;
  median_handoff_seconds: number;
  reworks: number;
  bottleneck_stage_id: string;
  stages: WorkflowInsightStage[];
  agents: WorkflowInsightAgent[];
  approvers: WorkflowInsightApprover[];
}
