package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	// workflowPipelineLimit caps how many issues one pipeline answer carries.
	workflowPipelineLimit = 500

	// workflowPipelineChildLimit caps how many sub-issues one pipeline answer carries.
	workflowPipelineChildLimit = 5000

	workflowPhasePrefix = "phase:"

	// workflowPipelineNoSquad is the squad filter that keeps only the issues
	// assigned to no squad (to a person or an agent, or to nobody).
	workflowPipelineNoSquad = "none"
)

// WorkflowPipelineIssue is one issue in a workflow, as the pipeline shows it.
type WorkflowPipelineIssue struct {
	ID           string `json:"id"`
	Identifier   string `json:"identifier"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	AssigneeType string `json:"assignee_type,omitempty"`
	AssigneeID   string `json:"assignee_id,omitempty"`
	UpdatedAt    string `json:"updated_at"`
	// Phases are the phase:* labels the issue carries, only filled where they
	// do not name exactly one of the workflow's stages.
	Phases []string `json:"phases,omitempty"`
	// Children are the issue's sub-issues, oldest first (never null). A parallel
	// stage hands each branch to an agent as one, so these are its progress.
	Children []WorkflowPipelineChild `json:"children"`
}

// WorkflowPipelineChild is one sub-issue of an issue in a workflow.
type WorkflowPipelineChild struct {
	ID           string `json:"id"`
	Identifier   string `json:"identifier"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	AssigneeType string `json:"assignee_type,omitempty"`
	AssigneeID   string `json:"assignee_id,omitempty"`
	CreatedAt    string `json:"created_at"`
	// Closed is true once the sub-issue's status is done or cancelled: the
	// states that wake the squad leader again. Cancelled is true for the latter.
	Closed    bool `json:"closed"`
	Cancelled bool `json:"cancelled"`
}

// WorkflowPipelineApprover is one person a human gate waits for.
type WorkflowPipelineApprover struct {
	// Ref is the entry as the workflow writes it (user:<id>).
	Ref string `json:"ref"`
	// ID and Name are filled for a registered member of the workspace; an entry
	// that is not one (a placeholder, a stranger) has neither.
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// WorkflowPipelineStage is one stage where work can wait, with the issues in it.
type WorkflowPipelineStage struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	// Approvers are the people a human gate waits for, in the order the workflow lists them.
	Approvers []WorkflowPipelineApprover `json:"approvers"`
	Issues    []WorkflowPipelineIssue    `json:"issues"`
}

// WorkflowPipelineResponse says where the issues of a workflow stand.
type WorkflowPipelineResponse struct {
	WorkflowKey string `json:"workflow_key"`
	// Version is the workflow's newest version; its stages are the columns.
	Version int32                   `json:"version"`
	Stages  []WorkflowPipelineStage `json:"stages"`
	// NoStage have the workflow's label but no phase:* label: the leader has not
	// started them yet.
	NoStage []WorkflowPipelineIssue `json:"no_stage"`
	// Conflicting carry more than one phase:* label; the leader is told to stop
	// and ask a human to fix that.
	Conflicting []WorkflowPipelineIssue `json:"conflicting"`
	// UnknownStage carry one phase:* label that names no stage of the newest
	// version (a stage that was renamed or removed since).
	UnknownStage []WorkflowPipelineIssue `json:"unknown_stage"`
	Total        int                     `json:"total"`
	// Truncated is true when more issues carry the label than the answer holds.
	Truncated bool `json:"truncated"`
}

// WorkflowPipeline lists the issues that follow a workflow, by the stage they
// are in. ?squad=<id> keeps the issues assigned to that squad, ?squad=none those
// assigned to no squad. It reads the labels the squad leader maintains, so it shows what the
// leader recorded, not what Multica enforced. Condition stages hold nothing and
// are not columns.
func (h *Handler) WorkflowPipeline(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}

	resp := WorkflowPipelineResponse{
		WorkflowKey: wf.Key, Version: wf.LatestVersion,
		Stages: []WorkflowPipelineStage{}, NoStage: []WorkflowPipelineIssue{},
		Conflicting: []WorkflowPipelineIssue{}, UnknownStage: []WorkflowPipelineIssue{},
	}
	index := map[string]int{}
	if wf.LatestVersion >= 1 {
		v, err := h.Queries.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
			WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: wf.LatestVersion,
		})
		if err != nil {
			slog.Warn("workflow pipeline: load newest version failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to load the pipeline")
			return
		}
		// A version that cannot be read has no stages to show; its issues still count.
		if def, issues := workflow.Parse([]byte(v.Definition)); len(issues) == 0 {
			for _, s := range def.Stages {
				if s.Type == workflow.StageCondition {
					continue
				}
				name := s.Name
				if name == "" {
					name = s.ID
				}
				index[s.ID] = len(resp.Stages)
				stage := WorkflowPipelineStage{
					ID: s.ID, Name: name, Type: s.Type,
					Approvers: []WorkflowPipelineApprover{}, Issues: []WorkflowPipelineIssue{},
				}
				if s.Type == workflow.StageHumanGate {
					if stage.Approvers, err = h.pipelineApprovers(r.Context(), wf.WorkspaceID, def.Approvers[s.Approvers]); err != nil {
						slog.Warn("workflow pipeline: resolve approvers failed", append(logger.RequestAttrs(r), "error", err)...)
						writeError(w, http.StatusInternalServerError, "failed to load the pipeline")
						return
					}
				}
				resp.Stages = append(resp.Stages, stage)
			}
		}
	}

	params := db.ListWorkflowPipelineIssuesParams{
		WorkspaceID: wf.WorkspaceID,
		WfLabel:     "wf:" + wf.Key,
		RowLimit:    workflowPipelineLimit + 1,
	}
	switch squad := r.URL.Query().Get("squad"); squad {
	case "":
	case workflowPipelineNoSquad:
		params.WithoutSquad = true
	default:
		if err := params.SquadID.Scan(squad); err != nil {
			writeError(w, http.StatusBadRequest, "squad must be a squad id or \""+workflowPipelineNoSquad+"\"")
			return
		}
	}
	rows, err := h.Queries.ListWorkflowPipelineIssues(r.Context(), params)
	if err != nil {
		slog.Warn("workflow pipeline: list issues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the pipeline")
		return
	}
	if len(rows) > workflowPipelineLimit {
		rows, resp.Truncated = rows[:workflowPipelineLimit], true
	}
	prefix := h.getIssuePrefix(r.Context(), wf.WorkspaceID)
	children, err := h.pipelineChildren(r.Context(), wf.WorkspaceID, prefix, rows)
	if err != nil {
		slog.Warn("workflow pipeline: list sub-issues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load the pipeline")
		return
	}

	for _, row := range rows {
		item := WorkflowPipelineIssue{
			ID:         uuidToString(row.ID),
			Identifier: prefix + "-" + strconv.Itoa(int(row.Number)),
			Title:      row.Title,
			Status:     row.Status,
			UpdatedAt:  timestampToString(row.UpdatedAt),
			Children:   []WorkflowPipelineChild{},
		}
		if kids, ok := children[uuidToString(row.ID)]; ok {
			item.Children = kids
		}
		if row.AssigneeType.Valid && row.AssigneeID.Valid {
			item.AssigneeType, item.AssigneeID = row.AssigneeType.String, uuidToString(row.AssigneeID)
		}
		switch len(row.Phases) {
		case 0:
			resp.NoStage = append(resp.NoStage, item)
		case 1:
			stage := strings.TrimPrefix(row.Phases[0], workflowPhasePrefix)
			if i, known := index[stage]; known {
				resp.Stages[i].Issues = append(resp.Stages[i].Issues, item)
			} else {
				item.Phases = row.Phases
				resp.UnknownStage = append(resp.UnknownStage, item)
			}
		default:
			item.Phases = row.Phases
			resp.Conflicting = append(resp.Conflicting, item)
		}
	}
	resp.Total = len(rows)
	writeJSON(w, http.StatusOK, resp)
}

// pipelineChildren reads the sub-issues of the listed issues in one query and groups them by parent
// id. A status counts as closed by its category, with done and cancelled as the fallback for a
// workspace that has no status rows.
func (h *Handler) pipelineChildren(ctx context.Context, workspaceID pgtype.UUID, prefix string, parents []db.ListWorkflowPipelineIssuesRow) (map[string][]WorkflowPipelineChild, error) {
	out := map[string][]WorkflowPipelineChild{}
	if len(parents) == 0 {
		return out, nil
	}
	ids := make([]pgtype.UUID, len(parents))
	for i, p := range parents {
		ids[i] = p.ID
	}
	rows, err := h.Queries.ListWorkflowPipelineChildren(ctx, db.ListWorkflowPipelineChildrenParams{
		WorkspaceID: workspaceID, ParentIds: ids, RowLimit: workflowPipelineChildLimit,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		child := WorkflowPipelineChild{
			ID:         uuidToString(row.ID),
			Identifier: prefix + "-" + strconv.Itoa(int(row.Number)),
			Title:      row.Title,
			Status:     row.Status,
			CreatedAt:  timestampToString(row.CreatedAt),
			Closed:     row.Closed || row.Status == "done" || row.Status == "cancelled",
			Cancelled:  row.Cancelled || row.Status == "cancelled",
		}
		if row.AssigneeType.Valid && row.AssigneeID.Valid {
			child.AssigneeType, child.AssigneeID = row.AssigneeType.String, uuidToString(row.AssigneeID)
		}
		parent := uuidToString(row.ParentIssueID)
		out[parent] = append(out[parent], child)
	}
	return out, nil
}

// pipelineApprovers names the people of an approver group that are registered
// members of the workspace; every other entry is kept as written, without a name.
func (h *Handler) pipelineApprovers(ctx context.Context, workspaceID pgtype.UUID, entries []string) ([]WorkflowPipelineApprover, error) {
	out := make([]WorkflowPipelineApprover, 0, len(entries))
	for _, ref := range entries {
		a := WorkflowPipelineApprover{Ref: ref}
		var userID pgtype.UUID
		if id, ok := strings.CutPrefix(ref, workflowUserRefPrefix); ok && userID.Scan(id) == nil {
			_, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
				UserID: userID, WorkspaceID: workspaceID,
			})
			switch {
			case err == nil:
				user, err := h.Queries.GetUser(ctx, userID)
				if err != nil {
					return nil, err
				}
				a.ID, a.Name = uuidToString(userID), user.Name
			case !isNotFound(err):
				return nil, err
			}
		}
		out = append(out, a)
	}
	return out, nil
}
