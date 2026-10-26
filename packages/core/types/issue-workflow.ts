/**
 * Workspace workflows (MUL-7420).
 *
 * A workflow is a whole pipeline: an ordered pick from the shared status
 * catalog plus who each column hands an issue to. Every workflow lists todo,
 * done and cancelled; backlog and blocked are optional, and the five keep fixed
 * places at the ends. Entering a column through a status change assigns the
 * issue to the column's handler and, for an agent, starts its run with the
 * column's instructions. A project only picks a workflow; projects that name
 * none use the workspace's Default workflow.
 */

export type IssueWorkflowHandlerType =
  | "none"
  | "agent"
  | "squad"
  | "member"
  | "project_lead"
  | "creator";

export interface IssueWorkflowHandler {
  type: IssueWorkflowHandlerType;
  /** Set only for agent, squad and member handlers. */
  id?: string;
}

/** A column with its handoff; handler "none" keeps the assignee. */
export interface IssueWorkflowStep {
  status_key: string;
  handler: IssueWorkflowHandler;
  instructions: string;
  /** Suggested status once the step is done; named in the handler's brief. */
  next_status_key?: string;
  /** Status to send the issue back to when it needs changes. */
  back_status_key?: string;
}

export interface IssueWorkflow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  /** The workspace Default: used by every project that names no workflow. */
  is_default: boolean;
  /** The member who owns the workflow and may edit it; null for Default. */
  owner_id: string | null;
  steps: IssueWorkflowStep[];
  /** Projects currently using this workflow. */
  project_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ListIssueWorkflowsResponse {
  workflows: IssueWorkflow[];
  total: number;
}

/** A status for a new column, created with the workflow write. */
export interface NewWorkflowStatus {
  name: string;
  category?: string;
  color?: string;
}

/** A column of a workflow write: an existing status or a new one, with its handoff. */
export type IssueWorkflowStepInput = ({ status_key: string } | { new_status: NewWorkflowStatus }) &
  Partial<SetWorkflowHandoffRequest>;

export interface IssueWorkflowWriteRequest {
  name?: string;
  description?: string;
  /**
   * Every column with its handoff. The server adds todo, done and cancelled
   * when missing and places the fixed columns; backlog and blocked are listed
   * only when included.
   */
  steps?: IssueWorkflowStepInput[];
  /** Destination for issues on statuses an edit removes, keyed by removed status. */
  status_mapping?: Record<string, string>;
  dry_run?: boolean;
}

/** A status some issues are on that the target workflow does not list. */
export interface IssueWorkflowMappingRequirement {
  status_key: string;
  issue_count: number;
  suggested_status_key: string;
}

/** A status some issues are on that both workflows list, so they keep it. */
export interface IssueWorkflowStatusCount {
  status_key: string;
  issue_count: number;
}

export interface IssueWorkflowMappingPlan {
  required: IssueWorkflowMappingRequirement[];
  unchanged: IssueWorkflowStatusCount[];
  total_issues: number;
  affected_issues: number;
}

export interface SetProjectWorkflowRequest {
  /** null switches the project back to the Default workflow. */
  workflow_id: string | null;
  status_mapping?: Record<string, string>;
  dry_run?: boolean;
}

export interface IssueWorkflowDryRunResponse {
  dry_run: true;
  plan: IssueWorkflowMappingPlan;
}

/** An active run of the agent a handoff takes the issue from. */
export interface WorkflowHandoffRun {
  task_id: string;
  agent_id: string;
  status: string;
  started_at: string | null;
}

/**
 * What moving an issue to a status would do under its project's workflow
 * (MUL-7420). `handoff` is false for the Default workflow and for steps that
 * keep the assignee.
 */
export interface WorkflowHandoffPreview {
  handoff: boolean;
  workflow_name: string;
  from_status: string;
  to_status: string;
  handler_type: "agent" | "squad" | "member" | null;
  handler_id: string | null;
  previous_assignee_type: string | null;
  previous_assignee_id: string | null;
  previous_runs: WorkflowHandoffRun[];
  /** The brief the handler's run receives; empty for a member handler. */
  brief: string;
}

/** A workflow's handoff for one column; handler "none" clears it. */
export interface SetWorkflowHandoffRequest {
  handler: IssueWorkflowHandler;
  instructions?: string;
  next_status_key?: string;
  back_status_key?: string;
}

/** What a visit to a workflow step was waiting on: who is expected to move the issue on. */
export type IssueWorkflowVisitKind = "agent" | "person" | "other" | "parked" | "end";
export type IssueWorkflowVisitOutcome = "passed" | "sent_back" | "blocked" | "waiting" | "";

/** One stay of an issue in one status of its project's workflow. */
export interface IssueWorkflowVisit {
  status_key: string;
  kind: IssueWorkflowVisitKind;
  handler: string;
  /** 1 for the first visit to this status, 2 after a rework. */
  number: number;
  entered_at: string;
  left_at: string | null;
  open: boolean;
  elapsed_seconds: number;
  agent_seconds: number;
  agent_ids: string[];
  /** Person steps: until their first comment, or until the issue left. */
  wait_seconds: number;
  answered_at: string | null;
  answered_by: string;
  outcome: IssueWorkflowVisitOutcome;
}

/**
 * How long one issue spent in each step of its project's workflow (MUL-7420),
 * measured from its status changes, agent runs and member comments.
 */
export interface IssueWorkflowTimeline {
  started_at: string | null;
  ended_at: string | null;
  /** Not finished: the totals count up to now. */
  open: boolean;
  elapsed_seconds: number;
  agent_seconds: number;
  people_seconds: number;
  other_seconds: number;
  reworks: number;
  visits: IssueWorkflowVisit[];
}

export interface IssueWorkflowStepInsight {
  status_key: string;
  kind: IssueWorkflowVisitKind;
  visits: number;
  open_visits: number;
  median_seconds: number;
  p90_seconds: number;
  total_seconds: number;
  sent_back: number;
}

export interface IssueWorkflowAgentInsight {
  agent_id: string;
  visits: number;
  median_seconds: number;
  p90_seconds: number;
  total_seconds: number;
}

export interface IssueWorkflowPersonInsight {
  user_id: string;
  answers: number;
  median_seconds: number;
  p90_seconds: number;
  slowest_seconds: number;
}

/** How the issues of one workflow moved through it over the last `days`. */
export interface IssueWorkflowInsights {
  days: number;
  runs: number;
  finished: number;
  open: number;
  /** More issues matched than one request reads. */
  truncated: boolean;
  median_elapsed_seconds: number;
  p90_elapsed_seconds: number;
  median_agent_seconds: number;
  median_people_seconds: number;
  median_other_seconds: number;
  sent_back: number;
  bottleneck_status_key: string;
  steps: IssueWorkflowStepInsight[];
  agents: IssueWorkflowAgentInsight[];
  people: IssueWorkflowPersonInsight[];
}

export type IssueWorkflowInsightsDays = 7 | 30 | 90;
