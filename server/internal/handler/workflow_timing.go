package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	// workflowInsightsLimit caps how many runs one insights answer measures.
	workflowInsightsLimit = 500
	// workflowInsightsDefaultDays and workflowInsightsMaxDays bound the window of runs it looks at.
	workflowInsightsDefaultDays = 30
	workflowInsightsMaxDays     = 365
	workflowRunCommentLimit     = 20000
)

// ---- responses ---------------------------------------------------------------

type WorkflowRunBranch struct {
	ID             string  `json:"id"`
	Identifier     string  `json:"identifier"`
	Title          string  `json:"title"`
	Agent          string  `json:"agent,omitempty"`
	Status         string  `json:"status"`
	StartedAt      string  `json:"started_at"`
	EndedAt        *string `json:"ended_at,omitempty"`
	WorkSeconds    int64   `json:"work_seconds"`
	ElapsedSeconds int64   `json:"elapsed_seconds"`
	Closed         bool    `json:"closed"`
	Cancelled      bool    `json:"cancelled"`
}

type WorkflowRunVisit struct {
	StageID        string              `json:"stage_id"`
	Name           string              `json:"name"`
	Type           string              `json:"type"`
	Number         int                 `json:"number"`
	EnteredAt      string              `json:"entered_at"`
	LeftAt         *string             `json:"left_at,omitempty"`
	Open           bool                `json:"open"`
	ElapsedSeconds int64               `json:"elapsed_seconds"`
	Agent          string              `json:"agent,omitempty"`
	AgentSeconds   int64               `json:"agent_seconds"`
	Branches       []WorkflowRunBranch `json:"branches"`
	WaitSeconds    int64               `json:"wait_seconds"`
	DecidedAt      *string             `json:"decided_at,omitempty"`
	// DecidedBy is the person who answered the gate, named when they are a member of the workspace.
	DecidedBy *WorkflowPipelineApprover `json:"decided_by,omitempty"`
	Outcome   string                    `json:"outcome,omitempty"`
}

type WorkflowRunTimeline struct {
	StartedAt            *string            `json:"started_at,omitempty"`
	EndedAt              *string            `json:"ended_at,omitempty"`
	Open                 bool               `json:"open"`
	ElapsedSeconds       int64              `json:"elapsed_seconds"`
	AgentSeconds         int64              `json:"agent_seconds"`
	PeopleSeconds        int64              `json:"people_seconds"`
	HandoffSeconds       int64              `json:"handoff_seconds"`
	Reworks              int                `json:"reworks"`
	ParallelSavedSeconds int64              `json:"parallel_saved_seconds"`
	Visits               []WorkflowRunVisit `json:"visits"`
}

type WorkflowRunResponse struct {
	Workflow struct {
		ID   string `json:"id"`
		Key  string `json:"key"`
		Name string `json:"name"`
	} `json:"workflow"`
	Issue struct {
		ID         string `json:"id"`
		Identifier string `json:"identifier"`
		Title      string `json:"title"`
		Status     string `json:"status"`
	} `json:"issue"`
	Timeline WorkflowRunTimeline `json:"timeline"`
}

type WorkflowInsightStage struct {
	StageID       string `json:"stage_id"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Visits        int    `json:"visits"`
	OpenVisits    int    `json:"open_visits"`
	MedianSeconds int64  `json:"median_seconds"`
	P90Seconds    int64  `json:"p90_seconds"`
	TotalSeconds  int64  `json:"total_seconds"`
	Rejected      int    `json:"rejected"`
}

type WorkflowInsightAgent struct {
	Agent         string `json:"agent"`
	Runs          int    `json:"runs"`
	MedianSeconds int64  `json:"median_seconds"`
	P90Seconds    int64  `json:"p90_seconds"`
	TotalSeconds  int64  `json:"total_seconds"`
}

type WorkflowInsightApprover struct {
	WorkflowPipelineApprover
	Decisions      int   `json:"decisions"`
	MedianSeconds  int64 `json:"median_seconds"`
	P90Seconds     int64 `json:"p90_seconds"`
	SlowestSeconds int64 `json:"slowest_seconds"`
}

type WorkflowInsightsResponse struct {
	WorkflowKey          string                    `json:"workflow_key"`
	Days                 int                       `json:"days"`
	Runs                 int                       `json:"runs"`
	Finished             int                       `json:"finished"`
	Open                 int                       `json:"open"`
	Truncated            bool                      `json:"truncated"`
	MedianElapsedSeconds int64                     `json:"median_elapsed_seconds"`
	P90ElapsedSeconds    int64                     `json:"p90_elapsed_seconds"`
	MedianAgentSeconds   int64                     `json:"median_agent_seconds"`
	MedianPeopleSeconds  int64                     `json:"median_people_seconds"`
	MedianHandoffSeconds int64                     `json:"median_handoff_seconds"`
	Reworks              int                       `json:"reworks"`
	BottleneckStageID    string                    `json:"bottleneck_stage_id"`
	Stages               []WorkflowInsightStage    `json:"stages"`
	Agents               []WorkflowInsightAgent    `json:"agents"`
	Approvers            []WorkflowInsightApprover `json:"approvers"`
}

// ---- reading the facts -------------------------------------------------------

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func tsPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := ts(*t)
	return &s
}

// workflowRunInputs reads, for the given issues, everything BuildTimeline needs, in a fixed number of
// queries however many issues there are, and groups it by issue.
func (h *Handler) workflowRunInputs(ctx context.Context, wf db.Workflow, def *workflow.Definition, issues []pgtype.UUID, now time.Time) (map[string]workflow.RunInput, error) {
	ids := make([]string, 0, len(issues))
	inputs := make(map[string]workflow.RunInput, len(issues))
	for _, id := range issues {
		key := uuidToString(id)
		ids = append(ids, key)
		inputs[key] = workflow.RunInput{Def: def, IssueID: key, Now: now}
	}
	if len(issues) == 0 {
		return inputs, nil
	}
	prefix := h.getIssuePrefix(ctx, wf.WorkspaceID)

	events, err := h.Queries.ListWorkflowStageEvents(ctx, db.ListWorkflowStageEventsParams{WorkspaceID: wf.WorkspaceID, IssueIds: issues})
	if err != nil {
		return nil, err
	}
	for _, e := range events {
		in := inputs[uuidToString(e.IssueID)]
		in.Events = append(in.Events, workflow.StageEvent{StageID: e.StageID, Kind: e.Kind, At: e.OccurredAt.Time})
		inputs[uuidToString(e.IssueID)] = in
	}

	children, err := h.Queries.ListWorkflowPipelineChildren(ctx, db.ListWorkflowPipelineChildrenParams{
		WorkspaceID: wf.WorkspaceID, ParentIds: issues, RowLimit: workflowPipelineChildLimit,
	})
	if err != nil {
		return nil, err
	}
	allIssues := append([]pgtype.UUID(nil), issues...)
	for _, c := range children {
		parent := uuidToString(c.ParentIssueID)
		in := inputs[parent]
		branch := workflow.BranchIssue{
			ID: uuidToString(c.ID), Identifier: prefix + "-" + strconv.Itoa(int(c.Number)), Title: c.Title,
			Agent: c.AssigneeName, Status: c.Status, CreatedAt: c.CreatedAt.Time,
			Closed: c.Closed || c.Status == "done" || c.Status == "cancelled", Cancelled: c.Cancelled || c.Status == "cancelled",
		}
		if c.ClosedAt.Valid {
			t := c.ClosedAt.Time
			branch.ClosedAt = &t
		} else if branch.Closed {
			t := c.UpdatedAt.Time
			branch.ClosedAt = &t
		}
		in.Children = append(in.Children, branch)
		inputs[parent] = in
		allIssues = append(allIssues, c.ID)
	}

	tasks, err := h.Queries.ListWorkflowRunTasks(ctx, db.ListWorkflowRunTasksParams{IssueIds: allIssues, WorkspaceID: wf.WorkspaceID})
	if err != nil {
		return nil, err
	}
	owner := map[string]string{} // sub-issue id -> its parent
	for parent, in := range inputs {
		for _, c := range in.Children {
			owner[c.ID] = parent
		}
	}
	for _, t := range tasks {
		issue := uuidToString(t.IssueID)
		parent, isChild := owner[issue]
		if !isChild {
			parent = issue
		}
		in, ok := inputs[parent]
		if !ok {
			continue
		}
		run := workflow.AgentRun{IssueID: issue, Agent: t.AgentName, Started: t.StartedAt.Time}
		if t.CompletedAt.Valid {
			c := t.CompletedAt.Time
			run.Completed = &c
		}
		in.Runs = append(in.Runs, run)
		inputs[parent] = in
	}

	comments, err := h.Queries.ListWorkflowRunComments(ctx, db.ListWorkflowRunCommentsParams{WorkspaceID: wf.WorkspaceID, IssueIds: issues, RowLimit: workflowRunCommentLimit})
	if err != nil {
		return nil, err
	}
	for _, c := range comments {
		in := inputs[uuidToString(c.IssueID)]
		in.Comments = append(in.Comments, workflow.Comment{AuthorRef: workflowUserRefPrefix + uuidToString(c.AuthorID), At: c.CreatedAt.Time})
		inputs[uuidToString(c.IssueID)] = in
	}
	return inputs, nil
}

// workflowDefinition reads a workflow's newest version, or nil when it has none or cannot be read: a
// timeline is still worth drawing then, with stage ids for names.
func (h *Handler) workflowDefinition(ctx context.Context, wf db.Workflow) *workflow.Definition {
	if wf.LatestVersion < 1 {
		return nil
	}
	v, err := h.Queries.GetWorkflowVersion(ctx, db.GetWorkflowVersionParams{WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: wf.LatestVersion})
	if err != nil {
		return nil
	}
	def, issues := workflow.Parse([]byte(v.Definition))
	if len(issues) > 0 {
		return nil
	}
	return def
}

func runTimelineResponse(tl workflow.Timeline, people map[string]WorkflowPipelineApprover) WorkflowRunTimeline {
	out := WorkflowRunTimeline{
		StartedAt: tsPtr(tl.StartedAt), EndedAt: tsPtr(tl.EndedAt), Open: tl.Open,
		ElapsedSeconds: tl.ElapsedSeconds, AgentSeconds: tl.AgentSeconds, PeopleSeconds: tl.PeopleSeconds,
		HandoffSeconds: tl.HandoffSeconds, Reworks: tl.Reworks, ParallelSavedSeconds: tl.ParallelSavedSeconds,
		Visits: []WorkflowRunVisit{},
	}
	for _, v := range tl.Visits {
		item := WorkflowRunVisit{
			StageID: v.StageID, Name: v.Name, Type: v.Type, Number: v.Number, EnteredAt: ts(v.EnteredAt),
			LeftAt: tsPtr(v.LeftAt), Open: v.Open, ElapsedSeconds: v.ElapsedSeconds, Agent: v.Agent, AgentSeconds: v.AgentSeconds,
			Branches: []WorkflowRunBranch{}, WaitSeconds: v.WaitSeconds, DecidedAt: tsPtr(v.DecidedAt), Outcome: v.Outcome,
		}
		if v.DecidedBy != "" {
			who, ok := people[v.DecidedBy]
			if !ok {
				who = WorkflowPipelineApprover{Ref: v.DecidedBy}
			}
			item.DecidedBy = &who
		}
		for _, b := range v.Branches {
			item.Branches = append(item.Branches, WorkflowRunBranch{
				ID: b.ID, Identifier: b.Identifier, Title: b.Title, Agent: b.Agent, Status: b.Status, StartedAt: ts(b.StartedAt),
				EndedAt: tsPtr(b.EndedAt), WorkSeconds: b.WorkSeconds, ElapsedSeconds: b.ElapsedSeconds, Closed: b.Closed, Cancelled: b.Cancelled,
			})
		}
		out.Visits = append(out.Visits, item)
	}
	return out
}

// resolvePeople names the people behind user:<id> entries that are members of the workspace.
func (h *Handler) resolvePeople(ctx context.Context, workspaceID pgtype.UUID, refs []string) (map[string]WorkflowPipelineApprover, error) {
	out := map[string]WorkflowPipelineApprover{}
	if len(refs) == 0 {
		return out, nil
	}
	people, err := h.pipelineApprovers(ctx, workspaceID, refs)
	if err != nil {
		return nil, err
	}
	for _, p := range people {
		out[p.Ref] = p
	}
	return out, nil
}

// ---- endpoints ---------------------------------------------------------------

// WorkflowRun measures one run of a workflow: the issue's stages in order, how long each took, and where
// the time went. GET /api/workflows/runs/{issue_id}. The workflow is the one the issue's wf:<key> label names.
func (h *Handler) WorkflowRun(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	issueUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "issue_id"), "issue id")
	if !ok {
		return
	}
	issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{ID: issueUUID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		slog.Warn("workflow run: load issue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the run")
		return
	}
	key, err := h.Queries.GetIssueWorkflowKey(r.Context(), db.GetIssueWorkflowKeyParams{IssueID: issue.ID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "this issue does not follow a workflow", "code": "not_in_workflow"})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load the run")
		return
	}
	wf, err := h.Queries.GetWorkflowByKey(r.Context(), db.GetWorkflowByKeyParams{WorkspaceID: wsUUID, Key: key})
	if err != nil {
		if isNotFound(err) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "the workflow this issue follows no longer exists", "code": "not_in_workflow"})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load the run")
		return
	}
	def := h.workflowDefinition(r.Context(), wf)
	inputs, err := h.workflowRunInputs(r.Context(), wf, def, []pgtype.UUID{issue.ID}, time.Now())
	if err != nil {
		slog.Warn("workflow run: read facts failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the run")
		return
	}
	tl := workflow.BuildTimeline(inputs[uuidToString(issue.ID)])
	var refs []string
	for _, v := range tl.Visits {
		if v.DecidedBy != "" {
			refs = append(refs, v.DecidedBy)
		}
	}
	people, err := h.resolvePeople(r.Context(), wsUUID, refs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load the run")
		return
	}

	var resp WorkflowRunResponse
	resp.Workflow.ID, resp.Workflow.Key, resp.Workflow.Name = uuidToString(wf.ID), wf.Key, wf.Name
	resp.Issue.ID, resp.Issue.Title, resp.Issue.Status = uuidToString(issue.ID), issue.Title, issue.Status
	resp.Issue.Identifier = h.getIssuePrefix(r.Context(), wsUUID) + "-" + strconv.Itoa(int(issue.Number))
	resp.Timeline = runTimelineResponse(tl, people)
	writeJSON(w, http.StatusOK, resp)
}

// WorkflowInsights summarises the runs of a workflow that began in the last ?days=N days (30 by default):
// per stage, per agent and per approver, and the stage that took most of the time.
func (h *Handler) WorkflowInsights(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	days := workflowInsightsDefaultDays
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > workflowInsightsMaxDays {
			writeError(w, http.StatusBadRequest, "days must be a whole number from 1 to "+strconv.Itoa(workflowInsightsMaxDays))
			return
		}
		days = n
	}
	now := time.Now()
	rows, err := h.Queries.ListWorkflowRunIssues(r.Context(), db.ListWorkflowRunIssuesParams{
		WorkspaceID: wf.WorkspaceID, WfLabel: "wf:" + wf.Key,
		Since: pgtype.Timestamptz{Time: now.AddDate(0, 0, -days), Valid: true}, RowLimit: workflowInsightsLimit + 1,
	})
	if err != nil {
		slog.Warn("workflow insights: list runs failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the insights")
		return
	}
	truncated := len(rows) > workflowInsightsLimit
	if truncated {
		rows = rows[:workflowInsightsLimit]
	}
	ids := make([]pgtype.UUID, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	def := h.workflowDefinition(r.Context(), wf)
	inputs, err := h.workflowRunInputs(r.Context(), wf, def, ids, now)
	if err != nil {
		slog.Warn("workflow insights: read facts failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the insights")
		return
	}
	timelines := make([]workflow.Timeline, 0, len(ids))
	for _, id := range ids {
		timelines = append(timelines, workflow.BuildTimeline(inputs[uuidToString(id)]))
	}
	var order []string
	if def != nil {
		for _, s := range def.OrderedStages() {
			order = append(order, s.ID)
		}
	}
	got := workflow.BuildInsights(timelines, order)

	refs := make([]string, 0, len(got.Approvers))
	for _, a := range got.Approvers {
		refs = append(refs, a.Ref)
	}
	people, err := h.resolvePeople(r.Context(), wf.WorkspaceID, refs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load the insights")
		return
	}
	resp := WorkflowInsightsResponse{
		WorkflowKey: wf.Key, Days: days, Runs: got.Runs, Finished: got.Finished, Open: got.Open, Truncated: truncated,
		MedianElapsedSeconds: got.MedianElapsedSeconds, P90ElapsedSeconds: got.P90ElapsedSeconds,
		MedianAgentSeconds: got.MedianAgentSeconds, MedianPeopleSeconds: got.MedianPeopleSeconds, MedianHandoffSeconds: got.MedianHandoffSeconds,
		Reworks: got.Reworks, BottleneckStageID: got.BottleneckStageID,
		Stages: []WorkflowInsightStage{}, Agents: []WorkflowInsightAgent{}, Approvers: []WorkflowInsightApprover{},
	}
	for _, s := range got.Stages {
		resp.Stages = append(resp.Stages, WorkflowInsightStage{
			StageID: s.StageID, Name: s.Name, Type: s.Type, Visits: s.Visits, OpenVisits: s.OpenVisits,
			MedianSeconds: s.MedianSeconds, P90Seconds: s.P90Seconds, TotalSeconds: s.TotalSeconds, Rejected: s.Rejected,
		})
	}
	for _, a := range got.Agents {
		resp.Agents = append(resp.Agents, WorkflowInsightAgent{Agent: a.Agent, Runs: a.Runs, MedianSeconds: a.MedianSeconds, P90Seconds: a.P90Seconds, TotalSeconds: a.TotalSeconds})
	}
	for _, a := range got.Approvers {
		who, ok := people[a.Ref]
		if !ok {
			who = WorkflowPipelineApprover{Ref: a.Ref}
		}
		resp.Approvers = append(resp.Approvers, WorkflowInsightApprover{
			WorkflowPipelineApprover: who, Decisions: a.Decisions, MedianSeconds: a.MedianSeconds, P90Seconds: a.P90Seconds, SlowestSeconds: a.SlowestSeconds,
		})
	}
	writeJSON(w, http.StatusOK, resp)
}
