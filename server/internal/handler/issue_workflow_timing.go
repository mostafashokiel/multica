package handler

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/issueworkflow/timing"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Timing of project workflows (MUL-7420).
//
// How long an issue spent in each step, and how long the issues of a workflow
// do in general, measured from rows Multica already records: the issue's
// status changes (activity_log), its agent runs and the comments members
// wrote. Nothing is stored, so nothing can drift from the issue. Reads are
// open to any member, like the workflows themselves.

// timingNow is the clock the timing endpoints use; tests replace it.
var timingNow = time.Now

// insightsMaxIssues bounds how many issues one insights request reads.
const insightsMaxIssues = 500

// insightsDays are the windows the insights page offers.
var insightsDays = map[int]bool{7: true, 30: true, 90: true}

type IssueWorkflowVisitResponse struct {
	StatusKey      string   `json:"status_key"`
	Kind           string   `json:"kind"`
	Handler        string   `json:"handler"`
	Number         int      `json:"number"`
	EnteredAt      string   `json:"entered_at"`
	LeftAt         *string  `json:"left_at"`
	Open           bool     `json:"open"`
	ElapsedSeconds int64    `json:"elapsed_seconds"`
	AgentSeconds   int64    `json:"agent_seconds"`
	AgentIDs       []string `json:"agent_ids"`
	WaitSeconds    int64    `json:"wait_seconds"`
	AnsweredAt     *string  `json:"answered_at"`
	AnsweredBy     string   `json:"answered_by"`
	Outcome        string   `json:"outcome"`
}

type IssueWorkflowTimelineResponse struct {
	StartedAt      *string                      `json:"started_at"`
	EndedAt        *string                      `json:"ended_at"`
	Open           bool                         `json:"open"`
	ElapsedSeconds int64                        `json:"elapsed_seconds"`
	AgentSeconds   int64                        `json:"agent_seconds"`
	PeopleSeconds  int64                        `json:"people_seconds"`
	OtherSeconds   int64                        `json:"other_seconds"`
	Reworks        int                          `json:"reworks"`
	Visits         []IssueWorkflowVisitResponse `json:"visits"`
}

type IssueWorkflowStepInsightResponse struct {
	StatusKey     string `json:"status_key"`
	Kind          string `json:"kind"`
	Visits        int    `json:"visits"`
	OpenVisits    int    `json:"open_visits"`
	MedianSeconds int64  `json:"median_seconds"`
	P90Seconds    int64  `json:"p90_seconds"`
	TotalSeconds  int64  `json:"total_seconds"`
	SentBack      int    `json:"sent_back"`
}

type IssueWorkflowAgentInsightResponse struct {
	AgentID       string `json:"agent_id"`
	Visits        int    `json:"visits"`
	MedianSeconds int64  `json:"median_seconds"`
	P90Seconds    int64  `json:"p90_seconds"`
	TotalSeconds  int64  `json:"total_seconds"`
}

type IssueWorkflowPersonInsightResponse struct {
	UserID         string `json:"user_id"`
	Answers        int    `json:"answers"`
	MedianSeconds  int64  `json:"median_seconds"`
	P90Seconds     int64  `json:"p90_seconds"`
	SlowestSeconds int64  `json:"slowest_seconds"`
}

type IssueWorkflowInsightsResponse struct {
	Days                 int                                  `json:"days"`
	Runs                 int                                  `json:"runs"`
	Finished             int                                  `json:"finished"`
	Open                 int                                  `json:"open"`
	Truncated            bool                                 `json:"truncated"`
	MedianElapsedSeconds int64                                `json:"median_elapsed_seconds"`
	P90ElapsedSeconds    int64                                `json:"p90_elapsed_seconds"`
	MedianAgentSeconds   int64                                `json:"median_agent_seconds"`
	MedianPeopleSeconds  int64                                `json:"median_people_seconds"`
	MedianOtherSeconds   int64                                `json:"median_other_seconds"`
	SentBack             int                                  `json:"sent_back"`
	BottleneckStatusKey  string                               `json:"bottleneck_status_key"`
	Steps                []IssueWorkflowStepInsightResponse   `json:"steps"`
	Agents               []IssueWorkflowAgentInsightResponse  `json:"agents"`
	People               []IssueWorkflowPersonInsightResponse `json:"people"`
}

// GetIssueWorkflowTimeline returns the timeline of one issue in its project's workflow.
func (h *Handler) GetIssueWorkflowTimeline(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	def, _, err := issueworkflow.ForProject(r.Context(), h.Queries, issue.WorkspaceID, issue.ProjectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load project workflow")
		return
	}
	if def == nil {
		writeJSON(w, http.StatusOK, timelineResponse(timing.Timeline{}))
		return
	}
	inputs, err := h.timingInputs(r.Context(), *def, []timingIssue{{id: issue.ID, createdAt: issue.CreatedAt.Time, status: issue.Status}})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the issue's history")
		return
	}
	writeJSON(w, http.StatusOK, timelineResponse(timing.Build(inputs[0])))
}

// GetIssueWorkflowInsights summarises how the issues of a workflow moved through it.
func (h *Handler) GetIssueWorkflowInsights(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	days := 30
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || !insightsDays[n] {
			writeError(w, http.StatusBadRequest, "days must be 7, 30 or 90")
			return
		}
		days = n
	}
	row, err := h.Queries.GetIssueWorkflow(r.Context(), db.GetIssueWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	def, err := issueworkflow.Decode(row)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the workflow")
		return
	}
	now := timingNow()
	rows, err := h.Queries.ListWorkflowIssuesForTiming(r.Context(), db.ListWorkflowIssuesForTimingParams{
		WorkspaceID: wsUUID,
		Since:       pgtype.Timestamptz{Time: now.AddDate(0, 0, -days), Valid: true},
		WorkflowID:  idUUID,
		IsDefault:   row.IsDefault,
		MaxIssues:   insightsMaxIssues,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list the workflow's issues")
		return
	}
	issues := make([]timingIssue, len(rows))
	for i, ir := range rows {
		issues[i] = timingIssue{id: ir.ID, createdAt: ir.CreatedAt.Time, status: ir.Status}
	}
	inputs, err := h.timingInputs(r.Context(), def, issues)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the issues' history")
		return
	}
	timelines := make([]timing.Timeline, len(inputs))
	for i, in := range inputs {
		timelines[i] = timing.Build(in)
	}
	ins := timing.Summarise(timelines, def.StatusKeys())
	writeJSON(w, http.StatusOK, insightsResponse(ins, days, len(rows) == insightsMaxIssues))
}

// timingIssue is the part of an issue the timing needs.
type timingIssue struct {
	id        pgtype.UUID
	createdAt time.Time
	status    string
}

// timingInputs reads the history of the issues in three queries and groups it per issue.
func (h *Handler) timingInputs(ctx context.Context, def issueworkflow.Definition, issues []timingIssue) ([]timing.Input, error) {
	if len(issues) == 0 {
		return nil, nil
	}
	ids := make([]pgtype.UUID, len(issues))
	for i, is := range issues {
		ids[i] = is.id
	}
	changes, err := h.Queries.ListIssueStatusChanges(ctx, ids)
	if err != nil {
		return nil, err
	}
	runs, err := h.Queries.ListIssueRunsForTiming(ctx, ids)
	if err != nil {
		return nil, err
	}
	comments, err := h.Queries.ListIssueMemberCommentsForTiming(ctx, ids)
	if err != nil {
		return nil, err
	}

	steps := make([]timing.Step, len(def.Steps))
	for i, s := range def.Steps {
		steps[i] = timing.Step{Key: s.StatusKey, Handler: s.Handler.Type, Back: s.BackStatusKey}
	}
	now := timingNow()
	index := make(map[string]int, len(issues))
	inputs := make([]timing.Input, len(issues))
	for i, is := range issues {
		index[uuidToString(is.id)] = i
		inputs[i] = timing.Input{Steps: steps, Created: is.createdAt, CurrentStatus: is.status, Now: now}
	}
	for _, c := range changes {
		if i, ok := index[uuidToString(c.IssueID)]; ok {
			inputs[i].Changes = append(inputs[i].Changes, timing.StatusChange{From: c.FromStatus, To: c.ToStatus, At: c.CreatedAt.Time})
		}
	}
	for _, r := range runs {
		i, ok := index[uuidToString(r.IssueID)]
		if !ok {
			continue
		}
		run := timing.Run{Agent: uuidToString(r.AgentID), Started: r.StartedAt.Time}
		if r.CompletedAt.Valid {
			done := r.CompletedAt.Time
			run.Completed = &done
		}
		inputs[i].Runs = append(inputs[i].Runs, run)
	}
	for _, c := range comments {
		if i, ok := index[uuidToString(c.IssueID)]; ok {
			inputs[i].Comments = append(inputs[i].Comments, timing.Comment{Author: uuidToString(c.AuthorID), At: c.CreatedAt.Time})
		}
	}
	return inputs, nil
}

func timeString(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func timePtrString(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := timeString(*t)
	return &s
}

func timelineResponse(tl timing.Timeline) IssueWorkflowTimelineResponse {
	out := IssueWorkflowTimelineResponse{
		StartedAt: timePtrString(tl.StartedAt), EndedAt: timePtrString(tl.EndedAt), Open: tl.Open,
		ElapsedSeconds: tl.ElapsedSeconds, AgentSeconds: tl.AgentSeconds, PeopleSeconds: tl.PeopleSeconds,
		OtherSeconds: tl.OtherSeconds, Reworks: tl.Reworks, Visits: []IssueWorkflowVisitResponse{},
	}
	for _, v := range tl.Visits {
		agents := v.Agents
		if agents == nil {
			agents = []string{}
		}
		out.Visits = append(out.Visits, IssueWorkflowVisitResponse{
			StatusKey: v.Key, Kind: v.Kind, Handler: v.Handler, Number: v.Number,
			EnteredAt: timeString(v.EnteredAt), LeftAt: timePtrString(v.LeftAt), Open: v.Open,
			ElapsedSeconds: v.ElapsedSeconds, AgentSeconds: v.AgentSeconds, AgentIDs: agents,
			WaitSeconds: v.WaitSeconds, AnsweredAt: timePtrString(v.AnsweredAt), AnsweredBy: v.AnsweredBy, Outcome: v.Outcome,
		})
	}
	return out
}

func insightsResponse(in timing.Insights, days int, truncated bool) IssueWorkflowInsightsResponse {
	out := IssueWorkflowInsightsResponse{
		Days: days, Runs: in.Runs, Finished: in.Finished, Open: in.Open, Truncated: truncated,
		MedianElapsedSeconds: in.MedianElapsedSeconds, P90ElapsedSeconds: in.P90ElapsedSeconds,
		MedianAgentSeconds: in.MedianAgentSeconds, MedianPeopleSeconds: in.MedianPeopleSeconds, MedianOtherSeconds: in.MedianOtherSeconds,
		SentBack: in.SentBack, BottleneckStatusKey: in.BottleneckKey,
		Steps:  []IssueWorkflowStepInsightResponse{},
		Agents: []IssueWorkflowAgentInsightResponse{},
		People: []IssueWorkflowPersonInsightResponse{},
	}
	for _, s := range in.Steps {
		out.Steps = append(out.Steps, IssueWorkflowStepInsightResponse{
			StatusKey: s.Key, Kind: s.Kind, Visits: s.Visits, OpenVisits: s.OpenVisits,
			MedianSeconds: s.MedianSeconds, P90Seconds: s.P90Seconds, TotalSeconds: s.TotalSeconds, SentBack: s.SentBack,
		})
	}
	for _, a := range in.Agents {
		out.Agents = append(out.Agents, IssueWorkflowAgentInsightResponse{
			AgentID: a.Agent, Visits: a.Visits, MedianSeconds: a.MedianSeconds, P90Seconds: a.P90Seconds, TotalSeconds: a.TotalSeconds,
		})
	}
	for _, p := range in.People {
		out.People = append(out.People, IssueWorkflowPersonInsightResponse{
			UserID: p.Ref, Answers: p.Answers, MedianSeconds: p.MedianSeconds, P90Seconds: p.P90Seconds, SlowestSeconds: p.SlowestSeconds,
		})
	}
	return out
}
