package handler

import (
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// squadNamesFollowing names the squads whose instructions carry this workflow's managed block, read
// from the marker lines as ListWorkflowSquads does. A squad with a damaged marker is not counted.
func (h *Handler) squadNamesFollowing(r *http.Request, workspaceID pgtype.UUID, key string) ([]string, error) {
	squads, err := h.Queries.ListSquads(r.Context(), workspaceID)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, s := range squads {
		if !strings.Contains(s.Instructions, "workflow-managed:begin") {
			continue
		}
		if block, _, _, found, err := workflow.FindBlock(s.Instructions); err == nil && found && block.Workflow == key {
			names = append(names, s.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

// DeleteWorkflow removes an archived workflow with all its versions and its audit trail. Two steps on
// purpose: archiving is reversible and hides the workflow, deleting is not. A workflow that a squad
// still follows is refused, because the squad's leader would keep a briefing for a workflow that no
// longer exists; apply another workflow to the squad, or take the block out, first. Issues that carry
// its labels are left alone.
func (h *Handler) DeleteWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	if wf.Status != workflowStatusArchived {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "archive the workflow before deleting it",
			"code":  "workflow_not_archived",
		})
		return
	}
	squads, err := h.squadNamesFollowing(r, wf.WorkspaceID, wf.Key)
	if err != nil {
		slog.Warn("delete workflow: list squads failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	if len(squads) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  "squads still follow this workflow",
			"code":   "workflow_in_use",
			"squads": squads,
		})
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	removed, err := qtx.DeleteArchivedWorkflow(r.Context(), db.DeleteArchivedWorkflowParams{ID: wf.ID, WorkspaceID: wf.WorkspaceID})
	if err != nil {
		slog.Warn("delete workflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	if removed == 0 {
		// Restored (or already deleted) since it was read.
		writeJSON(w, http.StatusConflict, map[string]any{"error": "archive the workflow before deleting it", "code": "workflow_not_archived"})
		return
	}
	for _, step := range []func() error{
		func() error {
			return qtx.DeleteWorkflowVersions(r.Context(), db.DeleteWorkflowVersionsParams{WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID})
		},
		func() error {
			return qtx.DeleteWorkflowAudit(r.Context(), db.DeleteWorkflowAuditParams{WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID})
		},
	} {
		if err := step(); err != nil {
			slog.Warn("delete workflow: remove history failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to delete workflow")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	// The audit trail went with the workflow, so the log is the only record of who did it.
	slog.Info("workflow deleted", append(logger.RequestAttrs(r), "workflow_id", uuidToString(wf.ID), "key", wf.Key, "user_id", userID)...)
	h.publish(protocol.EventWorkflowDeleted, workspaceID, "member", userID, map[string]any{"workflow_id": uuidToString(wf.ID), "key": wf.Key})
	w.WriteHeader(http.StatusNoContent)
}
