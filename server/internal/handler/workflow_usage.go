package handler

import (
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
)

// WorkflowSquadResponse is one squad whose instructions carry this workflow's
// managed block.
type WorkflowSquadResponse struct {
	SquadID     string `json:"squad_id"`
	Name        string `json:"name"`
	Version     int    `json:"version"`
	ContentHash string `json:"content_hash"`
	// UpToDate is true when the squad holds the workflow's newest version, byte
	// for byte (the hash matches), not merely a block with the same number.
	UpToDate bool `json:"up_to_date"`
}

// ListWorkflowSquads lists the active squads that follow a workflow, read from
// the marker lines in their instructions, which are the only record apply keeps
// on the squad. A squad whose marker is damaged is left out: nothing reliable can
// be said about it, and apply reports the damage when someone tries it.
func (h *Handler) ListWorkflowSquads(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	latestHash := ""
	if wf.LatestVersion >= 1 {
		v, err := h.Queries.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
			WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: wf.LatestVersion,
		})
		if err != nil {
			slog.Warn("list workflow squads: load newest version failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to list squads")
			return
		}
		latestHash = v.ContentHash
	}
	squads, err := h.Queries.ListSquads(r.Context(), wf.WorkspaceID)
	if err != nil {
		slog.Warn("list workflow squads failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list squads")
		return
	}

	out := []WorkflowSquadResponse{}
	for _, s := range squads {
		// Cheap pre-check: most squads have no marker at all.
		if !strings.Contains(s.Instructions, "workflow-managed:begin") {
			continue
		}
		block, _, _, found, err := workflow.FindBlock(s.Instructions)
		if err != nil || !found || block.Workflow != wf.Key {
			continue
		}
		out = append(out, WorkflowSquadResponse{
			SquadID:     uuidToString(s.ID),
			Name:        s.Name,
			Version:     block.Version,
			ContentHash: block.SHA256,
			UpToDate:    latestHash != "" && block.SHA256 == latestHash,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].SquadID < out[j].SquadID
	})
	writeJSON(w, http.StatusOK, map[string]any{"squads": out})
}
