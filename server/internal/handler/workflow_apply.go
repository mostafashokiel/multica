package handler

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	workflowAuditApply = "apply"

	workflowErrSquadHasWorkflow = "squad_has_workflow"
	workflowErrBlockInvalid     = "managed_block_invalid"

	// workflowSquadFallbackName stands in for the squad's name when a briefing is
	// previewed without choosing a squad and the definition names none.
	workflowSquadFallbackName = "this squad"
)

// WorkflowRenderResponse is a workflow version rendered as a squad briefing.
type WorkflowRenderResponse struct {
	WorkflowKey string `json:"workflow_key"`
	Version     int32  `json:"version"`
	ContentHash string `json:"content_hash"`
	SquadName   string `json:"squad_name"`
	// Instructions is the managed block exactly as apply writes it.
	Instructions string `json:"instructions"`
	// Labels are the labels the workflow implies; create them in the workspace.
	Labels []string `json:"labels"`
	// Members are the agents and approvers the workflow names, with what apply
	// would do about each. Empty when no squad was chosen.
	Members []WorkflowMemberResponse `json:"members"`
}

// WorkflowApplyResponse reports what applying a workflow did to a squad.
type WorkflowApplyResponse struct {
	// Applied is false when the squad already held exactly this briefing.
	Applied     bool     `json:"applied"`
	SquadID     string   `json:"squad_id"`
	WorkflowKey string   `json:"workflow_key"`
	Version     int32    `json:"version"`
	ContentHash string   `json:"content_hash"`
	Replaced    string   `json:"replaced_workflow,omitempty"`
	Labels      []string `json:"labels"`
	// Members are the agents and approvers the workflow names and what happened
	// to each: added to the squad, already in it, or not found in the workspace.
	Members []WorkflowMemberResponse `json:"members"`
}

// loadRenderableVersion loads the requested version of wf (the newest when
// requested is 0) and parses it. A version with validation problems is not
// renderable: the problems are answered as 400 invalid_definition.
func (h *Handler) loadRenderableVersion(
	w http.ResponseWriter, r *http.Request, q *db.Queries, wf db.Workflow, requested int32,
) (db.WorkflowVersion, *workflow.Definition, bool) {
	number := requested
	if number == 0 {
		number = wf.LatestVersion
	}
	if number < 1 {
		writeError(w, http.StatusConflict, "the workflow has no saved version")
		return db.WorkflowVersion{}, nil, false
	}
	v, err := q.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
		WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: number,
	})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "version not found")
		} else {
			slog.Warn("load workflow version failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to load version")
		}
		return db.WorkflowVersion{}, nil, false
	}
	def, issues := workflow.Parse([]byte(v.Definition))
	if len(issues) > 0 {
		slog.Error("stored workflow version cannot be parsed",
			append(logger.RequestAttrs(r), "workflow_id", uuidToString(wf.ID), "version", number)...)
		writeError(w, http.StatusInternalServerError, "the stored version cannot be read")
		return db.WorkflowVersion{}, nil, false
	}
	if problems := workflow.Validate(def); len(problems) > 0 {
		writeInvalidDefinition(w, "this version has problems and cannot be rendered", problems)
		return db.WorkflowVersion{}, nil, false
	}
	return v, def, true
}

// renderBlock renders def for squadName and wraps it in the managed block.
// members names the approvers the briefing mentions; it may be empty.
func renderBlock(def *workflow.Definition, hash, squadName string, members []WorkflowMemberResponse) string {
	people := map[string]string{}
	for _, m := range members {
		if m.Kind == workflowMemberPerson && m.Name != "" {
			people[m.Ref] = m.Name
		}
	}
	return workflow.WrapBlock(def, hash, workflow.RenderLeaderInstructionsFor(def, squadName, people))
}

type workflowRenderRequest struct {
	Version int32  `json:"version"`
	SquadID string `json:"squad_id"`
}

// RenderWorkflow previews the briefing a version would give a squad leader. It
// changes nothing, so any member may call it.
func (h *Handler) RenderWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	var req workflowRenderRequest
	if r.ContentLength != 0 && !decodeWorkflowBody(w, r, &req) {
		return
	}
	if req.Version < 0 {
		writeError(w, http.StatusBadRequest, "version must be positive")
		return
	}
	v, def, ok := h.loadRenderableVersion(w, r, h.Queries, wf, req.Version)
	if !ok {
		return
	}

	squadName := workflowSquadFallbackName
	if def.Target != nil && def.Target.SquadName != "" {
		squadName = def.Target.SquadName
	}
	members := []WorkflowMemberResponse{}
	if req.SquadID != "" {
		squadUUID, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id")
		if !ok {
			return
		}
		squad, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{
			ID: squadUUID, WorkspaceID: wf.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusNotFound, "squad not found")
			return
		}
		squadName = squad.Name
		if members, err = resolveWorkflowMembers(r.Context(), h.Queries, wf.WorkspaceID, squad.ID, def); err != nil {
			slog.Warn("render workflow: resolve members failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to preview the members")
			return
		}
		h.markWhoCanWakeTheLeader(r.Context(), members, squad.LeaderID, wf.WorkspaceID)
	}

	writeJSON(w, http.StatusOK, WorkflowRenderResponse{
		WorkflowKey:  wf.Key,
		Version:      v.Version,
		ContentHash:  v.ContentHash,
		SquadName:    squadName,
		Instructions: renderBlock(def, v.ContentHash, squadName, members),
		Labels:       workflow.Labels(def),
		Members:      members,
	})
}

type workflowApplyRequest struct {
	SquadID string `json:"squad_id"`
	Version int32  `json:"version"`
	// Replace lets this workflow take over a squad that already carries a
	// different workflow's briefing. Without it that is a conflict.
	Replace bool `json:"replace"`
}

// ApplyWorkflow writes a workflow version's briefing into a squad's
// instructions, between its marker lines. Text the squad already has outside
// those lines is untouched. Applying the same version again changes nothing.
//
// Only human owners and admins may apply: the briefing decides who approves
// what, so an agent must not be able to rewrite it.
func (h *Handler) ApplyWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	var req workflowApplyRequest
	if !decodeWorkflowBody(w, r, &req) {
		return
	}
	if req.Version < 0 {
		writeError(w, http.StatusBadRequest, "version must be positive")
		return
	}
	squadUUID, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	// The squad lock is taken first, in the same order UpdateSquad takes it, and
	// the instructions are read under it: a concurrent edit of the squad cannot
	// be lost by the read-modify-write below.
	squad, err := qtx.LockSquadForUpdate(r.Context(), db.LockSquadForUpdateParams{ID: squadUUID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "squad not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		}
		return
	}
	if squad.ArchivedAt.Valid {
		writeError(w, http.StatusConflict, "an archived squad cannot be changed")
		return
	}
	wf, err := qtx.GetWorkflowForUpdate(r.Context(), db.GetWorkflowForUpdateParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "workflow not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		}
		return
	}
	if wf.Status == workflowStatusArchived {
		writeError(w, http.StatusConflict, "an archived workflow cannot be applied; restore it first")
		return
	}
	v, def, ok := h.loadRenderableVersion(w, r, qtx, wf, req.Version)
	if !ok {
		return
	}

	existing, _, _, found, err := workflow.FindBlock(squad.Instructions)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": fmt.Sprintf("cannot apply: %s; fix or remove it in the squad's instructions first", err),
			"code":  workflowErrBlockInvalid,
		})
		return
	}
	replaced := ""
	if found && existing.Workflow != wf.Key {
		if !req.Replace {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":    fmt.Sprintf("this squad already follows workflow %q; pass replace to switch it", existing.Workflow),
				"code":     workflowErrSquadHasWorkflow,
				"workflow": existing.Workflow,
			})
			return
		}
		replaced = existing.Workflow
	}

	members, err := resolveWorkflowMembers(r.Context(), qtx, wf.WorkspaceID, squad.ID, def)
	if err != nil {
		slog.Warn("apply workflow: resolve members failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		return
	}
	h.markWhoCanWakeTheLeader(r.Context(), members, squad.LeaderID, wf.WorkspaceID)
	updatedText, err := workflow.ApplyBlock(squad.Instructions, renderBlock(def, v.ContentHash, squad.Name, members))
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": workflowErrBlockInvalid})
		return
	}

	resp := WorkflowApplyResponse{
		Applied:     updatedText != squad.Instructions,
		SquadID:     uuidToString(squad.ID),
		WorkflowKey: wf.Key,
		Version:     v.Version,
		ContentHash: v.ContentHash,
		Replaced:    replaced,
		Labels:      workflow.Labels(def),
		Members:     members,
	}

	// The squad is written when its text changes or a named agent or approver is
	// missing from it. Applying again after the missing ones were registered adds
	// them without touching the briefing.
	updated := squad
	if resp.Applied {
		updated, err = qtx.UpdateSquad(r.Context(), db.UpdateSquadParams{
			ID:           squad.ID,
			Instructions: pgtype.Text{String: updatedText, Valid: true},
		})
		if err != nil {
			slog.Warn("apply workflow: update squad failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to apply workflow")
			return
		}
	}
	added, err := addWorkflowMembers(r.Context(), qtx, squad.ID, resp.Members)
	if err != nil {
		slog.Warn("apply workflow: add members failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		return
	}
	if !resp.Applied && added == 0 {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	ww := workflowWriter{h: h, q: qtx, userID: parseUUID(userID), request: r}
	detail := map[string]any{"squad_id": resp.SquadID, "squad_name": squad.Name}
	if replaced != "" {
		detail["replaced_workflow"] = replaced
	}
	if added > 0 {
		var names []string
		for _, m := range resp.Members {
			if m.Status == workflowMemberAdded {
				names = append(names, m.Name)
			}
		}
		detail["members_added"] = names
	}
	if !resp.Applied {
		detail["briefing_unchanged"] = true
	}
	if err := ww.audit(wf, pgtype.Int4{Int32: v.Version, Valid: true}, workflowAuditApply, detail); err != nil {
		slog.Warn("apply workflow: audit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to apply workflow")
		return
	}

	if squadResp, err := h.squadToResponseWithPreview(r.Context(), updated); err == nil {
		h.publish(protocol.EventSquadUpdated, workspaceID, "member", userID, map[string]any{"squad": squadResp})
	} else {
		slog.Warn("apply workflow: squad preview failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	h.publish(protocol.EventWorkflowUpdated, workspaceID, "member", userID, map[string]any{
		"workflow": workflowToResponse(wf),
	})
	writeJSON(w, http.StatusOK, resp)
}
