package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/workflow"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Workflows are versioned definitions of the stages work moves through. This
// file is the HTTP surface for them; parsing, validation and the canonical
// text live in internal/workflow. Nothing here moves an issue.
//
// Reads are open to every workspace member. Writes are limited to human
// owners and admins: a workflow decides who approves what, so an agent must
// not be able to rewrite it.

const (
	maxWorkflowNameLen           = 120
	maxWorkflowDescriptionLen    = 2000
	maxWorkflowNoteLen           = 500
	maxActiveWorkflowsPerSpace   = 200
	maxWorkflowLayoutEntries     = 2000
	maxWorkflowLayoutKeyLen      = 100
	maxWorkflowLayoutCoordinate  = 1_000_000
	maxWorkflowRequestBytes      = 2 << 20
	workflowAuditPageSize        = 100
	workflowRestoreNoteFormat    = "Restored from version %d"
	workflowStatusActive         = "active"
	workflowStatusArchived       = "archived"
	workflowAuditCreate          = "create"
	workflowAuditSave            = "save"
	workflowAuditRestore         = "restore"
	workflowAuditArchive         = "archive"
	workflowAuditUnarchive       = "unarchive"
	workflowAuditRename          = "rename"
	workflowErrDisabled          = "workflows_disabled"
	workflowErrInvalidDefinition = "invalid_definition"
	workflowErrVersionConflict   = "version_conflict"
)

func (h *Handler) workflowsV1Enabled(ctx context.Context) bool {
	return featureflags.WorkflowsV1Enabled(ctx, h.FeatureFlags)
}

func (h *Handler) requireWorkflowsV1(w http.ResponseWriter, r *http.Request) bool {
	if h.workflowsV1Enabled(r.Context()) {
		return true
	}
	writeFeatureDisabled(w, workflowErrDisabled, "Workflows are not enabled")
	return false
}

// requireWorkflowReader admits any workspace member.
func (h *Handler) requireWorkflowReader(w http.ResponseWriter, r *http.Request) (workspaceID string, ok bool) {
	if !h.requireWorkflowsV1(w, r) {
		return "", false
	}
	workspaceID = h.resolveWorkspaceID(r)
	if _, ok = requireUserID(w, r); !ok {
		return "", false
	}
	if _, ok = h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return "", false
	}
	return workspaceID, true
}

// requireWorkflowManager admits human owners and admins only.
func (h *Handler) requireWorkflowManager(w http.ResponseWriter, r *http.Request) (workspaceID, userID string, ok bool) {
	if !h.requireWorkflowsV1(w, r) {
		return "", "", false
	}
	workspaceID = h.resolveWorkspaceID(r)
	userID, ok = requireUserID(w, r)
	if !ok {
		return "", "", false
	}
	if actorType, _ := h.resolveActor(r, userID, workspaceID); actorType == "agent" {
		writeError(w, http.StatusForbidden, "agents cannot manage workflows")
		return "", "", false
	}
	if _, ok = h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return "", "", false
	}
	return workspaceID, userID, true
}

// ---- responses -------------------------------------------------------------

type WorkflowResponse struct {
	ID            string `json:"id"`
	Key           string `json:"key"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Status        string `json:"status"`
	LatestVersion int32  `json:"latest_version"`
	Revision      int64  `json:"revision"`
	CreatedByType string `json:"created_by_type"`
	CreatedByID   string `json:"created_by_id"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

func workflowToResponse(wf db.Workflow) WorkflowResponse {
	return WorkflowResponse{
		ID:            uuidToString(wf.ID),
		Key:           wf.Key,
		Name:          wf.Name,
		Description:   wf.Description,
		Status:        wf.Status,
		LatestVersion: wf.LatestVersion,
		Revision:      wf.Revision,
		CreatedByType: wf.CreatedByType,
		CreatedByID:   uuidToString(wf.CreatedByID),
		CreatedAt:     timestampToString(wf.CreatedAt),
		UpdatedAt:     timestampToString(wf.UpdatedAt),
	}
}

// WorkflowVersionResponse is one saved version. `definition` and `layout` are
// present when a single version is fetched and left out of history lists.
type WorkflowVersionResponse struct {
	ID            string          `json:"id"`
	WorkflowID    string          `json:"workflow_id"`
	Version       int32           `json:"version"`
	ContentHash   string          `json:"content_hash"`
	Note          string          `json:"note"`
	CreatedByType string          `json:"created_by_type"`
	CreatedByID   string          `json:"created_by_id"`
	CreatedAt     string          `json:"created_at"`
	Definition    *string         `json:"definition,omitempty"`
	Layout        json.RawMessage `json:"layout,omitempty"`
	// Issues are the validation problems in this version's definition. Saving
	// a version with problems is allowed; using it is up to the caller.
	Issues []workflow.Issue `json:"issues,omitempty"`
}

func workflowVersionToResponse(v db.WorkflowVersion) WorkflowVersionResponse {
	definition := v.Definition
	resp := WorkflowVersionResponse{
		ID:            uuidToString(v.ID),
		WorkflowID:    uuidToString(v.WorkflowID),
		Version:       v.Version,
		ContentHash:   v.ContentHash,
		Note:          v.Note,
		CreatedByType: v.CreatedByType,
		CreatedByID:   uuidToString(v.CreatedByID),
		CreatedAt:     timestampToString(v.CreatedAt),
		Definition:    &definition,
		Layout:        json.RawMessage(v.Layout),
	}
	if def, issues := workflow.Parse([]byte(v.Definition)); len(issues) == 0 {
		resp.Issues = workflow.Validate(def)
	}
	return resp
}

func workflowVersionSummary(row db.ListWorkflowVersionsRow) WorkflowVersionResponse {
	return WorkflowVersionResponse{
		ID:            uuidToString(row.ID),
		WorkflowID:    uuidToString(row.WorkflowID),
		Version:       row.Version,
		ContentHash:   row.ContentHash,
		Note:          row.Note,
		CreatedByType: row.CreatedByType,
		CreatedByID:   uuidToString(row.CreatedByID),
		CreatedAt:     timestampToString(row.CreatedAt),
	}
}

type workflowWithVersionResponse struct {
	Workflow WorkflowResponse         `json:"workflow"`
	Version  *WorkflowVersionResponse `json:"version,omitempty"`
}

// ---- requests --------------------------------------------------------------

func decodeWorkflowBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// writeInvalidDefinition answers 400 with every problem found, so a client can
// show them all at once.
func writeInvalidDefinition(w http.ResponseWriter, message string, issues []workflow.Issue) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error":  message,
		"code":   workflowErrInvalidDefinition,
		"issues": issues,
	})
}

func trimmedWorkflowText(w http.ResponseWriter, raw string, limit int, field string) (string, bool) {
	value := strings.TrimSpace(raw)
	if len([]rune(value)) > limit {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("%s is longer than %d characters", field, limit))
		return "", false
	}
	return value, true
}

// normalizeWorkflowLayout accepts the designer's node positions,
// `{ "<stage id>": { "x": 1, "y": 2 } }`, and nothing else. It bounds the size
// and the coordinates so the column cannot be used as a general blob store.
func normalizeWorkflowLayout(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage(`{}`), nil
	}
	var layout map[string]struct {
		X *float64 `json:"x"`
		Y *float64 `json:"y"`
	}
	if err := json.Unmarshal(raw, &layout); err != nil {
		return nil, fmt.Errorf("layout must be an object of {x, y} positions")
	}
	if len(layout) > maxWorkflowLayoutEntries {
		return nil, fmt.Errorf("layout has more than %d entries", maxWorkflowLayoutEntries)
	}
	for key, p := range layout {
		if len(key) > maxWorkflowLayoutKeyLen {
			return nil, fmt.Errorf("layout key is longer than %d characters", maxWorkflowLayoutKeyLen)
		}
		if p.X == nil || p.Y == nil ||
			math.IsNaN(*p.X) || math.IsNaN(*p.Y) ||
			math.Abs(*p.X) > maxWorkflowLayoutCoordinate || math.Abs(*p.Y) > maxWorkflowLayoutCoordinate {
			return nil, fmt.Errorf("layout position of %q is not a number within range", key)
		}
	}
	return json.RawMessage(strings.TrimSpace(string(raw))), nil
}

// ---- reads -----------------------------------------------------------------

func (h *Handler) ListWorkflows(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	rows, err := h.Queries.ListWorkflows(r.Context(), db.ListWorkflowsParams{
		WorkspaceID:     wsUUID,
		IncludeArchived: r.URL.Query().Get("include_archived") == "true",
	})
	if err != nil {
		slog.Warn("list workflows failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflows")
		return
	}
	out := make([]WorkflowResponse, 0, len(rows))
	for _, wf := range rows {
		out = append(out, workflowToResponse(wf))
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": out})
}

// loadWorkflow fetches a workflow of this workspace by the {id} URL parameter.
func (h *Handler) loadWorkflow(w http.ResponseWriter, r *http.Request, workspaceID string) (db.Workflow, bool) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return db.Workflow{}, false
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return db.Workflow{}, false
	}
	wf, err := h.Queries.GetWorkflow(r.Context(), db.GetWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "workflow not found")
		} else {
			slog.Warn("get workflow failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to load workflow")
		}
		return db.Workflow{}, false
	}
	return wf, true
}

func parseWorkflowVersionParam(w http.ResponseWriter, r *http.Request) (int32, bool) {
	n, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 32)
	if err != nil || n < 1 {
		writeError(w, http.StatusNotFound, "version not found")
		return 0, false
	}
	return int32(n), true
}

// GetWorkflow returns the workflow with its newest version (if it has one).
func (h *Handler) GetWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	resp := workflowWithVersionResponse{Workflow: workflowToResponse(wf)}
	if wf.LatestVersion > 0 {
		v, err := h.Queries.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
			WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: wf.LatestVersion,
		})
		if err != nil {
			slog.Warn("get latest workflow version failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to load workflow version")
			return
		}
		vr := workflowVersionToResponse(v)
		resp.Version = &vr
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListWorkflowVersions(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListWorkflowVersions(r.Context(), db.ListWorkflowVersionsParams{
		WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID,
	})
	if err != nil {
		slog.Warn("list workflow versions failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list versions")
		return
	}
	out := make([]WorkflowVersionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, workflowVersionSummary(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
}

func (h *Handler) GetWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	version, ok := parseWorkflowVersionParam(w, r)
	if !ok {
		return
	}
	v, err := h.Queries.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
		WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: version,
	})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "version not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load version")
		}
		return
	}
	writeJSON(w, http.StatusOK, workflowVersionToResponse(v))
}

func (h *Handler) ListWorkflowAudit(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.requireWorkflowReader(w, r)
	if !ok {
		return
	}
	wf, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListWorkflowAudit(r.Context(), db.ListWorkflowAuditParams{
		WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Limit: workflowAuditPageSize,
	})
	if err != nil {
		slog.Warn("list workflow audit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list audit entries")
		return
	}
	type entry struct {
		Action    string          `json:"action"`
		Version   *int32          `json:"version,omitempty"`
		ActorType string          `json:"actor_type"`
		ActorID   string          `json:"actor_id"`
		Detail    json.RawMessage `json:"detail"`
		CreatedAt string          `json:"created_at"`
	}
	out := make([]entry, 0, len(rows))
	for _, row := range rows {
		e := entry{
			Action:    row.Action,
			ActorType: row.ActorType,
			ActorID:   uuidToString(row.ActorID),
			Detail:    json.RawMessage(row.Detail),
			CreatedAt: timestampToString(row.CreatedAt),
		}
		if row.Version.Valid {
			v := row.Version.Int32
			e.Version = &v
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit": out})
}

// ValidateWorkflowDefinition checks a definition without saving anything, so
// an editor can show problems as someone types. It answers 200 whether or not
// the definition is valid; `valid` and `issues` carry the verdict. When the text
// parses, `canonical` is the form a save would store.
func (h *Handler) ValidateWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireWorkflowReader(w, r); !ok {
		return
	}
	var req struct {
		Definition string `json:"definition"`
	}
	if !decodeWorkflowBody(w, r, &req) {
		return
	}
	def, parseIssues := workflow.Parse([]byte(req.Definition))
	if len(parseIssues) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"parsed": false, "valid": false, "issues": parseIssues})
		return
	}
	issues := workflow.Validate(def)
	if issues == nil {
		// A clean definition has an empty list, not null: clients read `issues` as an array.
		issues = []workflow.Issue{}
	}
	// The canonical text is what a save would store, so an editor can preview it
	// without carrying its own copy of the canonical form.
	canonical, err := workflow.Marshal(def)
	if err != nil {
		slog.Warn("canonicalise workflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to canonicalise the definition")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"parsed": true, "valid": len(issues) == 0, "issues": issues, "canonical": string(canonical),
	})
}

// ---- writes ----------------------------------------------------------------

type workflowWriter struct {
	h       *Handler
	q       *db.Queries
	userID  pgtype.UUID
	request *http.Request
}

// saveVersion inserts the next version of wf from def and moves the head to
// it, under the row lock the caller already holds. The version number is
// stamped into the definition so the stored text names its own version.
func (ww workflowWriter) saveVersion(
	wf db.Workflow, def *workflow.Definition, layout json.RawMessage, note, action string, detail map[string]any,
) (db.Workflow, db.WorkflowVersion, error) {
	ctx := ww.request.Context()
	next := wf.LatestVersion + 1
	def.Metadata.Version = int(next)
	canonical, err := workflow.Marshal(def)
	if err != nil {
		return db.Workflow{}, db.WorkflowVersion{}, err
	}
	version, err := ww.q.InsertWorkflowVersion(ctx, db.InsertWorkflowVersionParams{
		WorkspaceID:   wf.WorkspaceID,
		WorkflowID:    wf.ID,
		Version:       next,
		Definition:    string(canonical),
		ContentHash:   workflow.ContentHash(canonical),
		Layout:        layout,
		Note:          note,
		CreatedByType: "member",
		CreatedByID:   ww.userID,
	})
	if err != nil {
		return db.Workflow{}, db.WorkflowVersion{}, err
	}
	head, err := ww.q.SetWorkflowLatestVersion(ctx, db.SetWorkflowLatestVersionParams{
		ID: wf.ID, WorkspaceID: wf.WorkspaceID, LatestVersion: next,
	})
	if err != nil {
		return db.Workflow{}, db.WorkflowVersion{}, err
	}
	if err := ww.audit(head, pgtype.Int4{Int32: next, Valid: true}, action, detail); err != nil {
		return db.Workflow{}, db.WorkflowVersion{}, err
	}
	return head, version, nil
}

func (ww workflowWriter) audit(wf db.Workflow, version pgtype.Int4, action string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	return ww.q.InsertWorkflowAudit(ww.request.Context(), db.InsertWorkflowAuditParams{
		WorkspaceID: wf.WorkspaceID,
		WorkflowID:  wf.ID,
		Version:     version,
		Action:      action,
		ActorType:   "member",
		ActorID:     ww.userID,
		Detail:      raw,
	})
}

// CreateWorkflow creates a workflow and its first version from a definition.
// The workflow's key is the definition's metadata.id.
func (h *Handler) CreateWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	var req struct {
		Definition string          `json:"definition"`
		Name       string          `json:"name"`
		Layout     json.RawMessage `json:"layout"`
		Note       string          `json:"note"`
	}
	if !decodeWorkflowBody(w, r, &req) {
		return
	}
	def, issues := workflow.Parse([]byte(req.Definition))
	if len(issues) > 0 {
		writeInvalidDefinition(w, "the definition could not be read", issues)
		return
	}
	key := def.Metadata.ID
	if !workflow.ValidID(key) {
		writeInvalidDefinition(w, "metadata.id must be lowercase kebab-case (a-z, 0-9, single hyphens), at most 40 characters",
			[]workflow.Issue{{Path: "metadata.id", Message: "must be lowercase kebab-case, at most 40 characters"}})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = strings.TrimSpace(def.Metadata.Description)
	}
	if name == "" {
		name = key
	}
	name, ok = trimmedWorkflowText(w, name, maxWorkflowNameLen, "name")
	if !ok {
		return
	}
	description, ok := trimmedWorkflowText(w, def.Metadata.Description, maxWorkflowDescriptionLen, "description")
	if !ok {
		return
	}
	note, ok := trimmedWorkflowText(w, req.Note, maxWorkflowNoteLen, "note")
	if !ok {
		return
	}
	layout, err := normalizeWorkflowLayout(req.Layout)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if n, err := h.Queries.CountActiveWorkflows(r.Context(), wsUUID); err == nil && n >= maxActiveWorkflowsPerSpace {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("a workspace can have at most %d active workflows; archive one first", maxActiveWorkflowsPerSpace))
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create workflow")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	ww := workflowWriter{h: h, q: qtx, userID: parseUUID(userID), request: r}

	wf, err := qtx.CreateWorkflow(r.Context(), db.CreateWorkflowParams{
		WorkspaceID: wsUUID, Key: key, Name: name, Description: description,
		CreatedByType: "member", CreatedByID: parseUUID(userID),
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, fmt.Sprintf("a workflow with the key %q already exists", key))
			return
		}
		slog.Warn("create workflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create workflow")
		return
	}
	head, version, err := ww.saveVersion(wf, def, layout, note, workflowAuditCreate, map[string]any{"key": key})
	if err != nil {
		slog.Warn("create workflow version failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create workflow")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create workflow")
		return
	}

	resp := workflowToResponse(head)
	h.publish(protocol.EventWorkflowCreated, workspaceID, "member", userID, map[string]any{"workflow": resp})
	vr := workflowVersionToResponse(version)
	writeJSON(w, http.StatusCreated, workflowWithVersionResponse{Workflow: resp, Version: &vr})
}

// SaveWorkflowVersion saves a new version on top of base_version, which must
// still be the newest: a stale base answers 409 and writes nothing.
func (h *Handler) SaveWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	var req struct {
		Definition  string          `json:"definition"`
		BaseVersion *int32          `json:"base_version"`
		Layout      json.RawMessage `json:"layout"`
		Note        string          `json:"note"`
	}
	if !decodeWorkflowBody(w, r, &req) {
		return
	}
	if req.BaseVersion == nil {
		writeError(w, http.StatusBadRequest, "base_version is required")
		return
	}
	def, issues := workflow.Parse([]byte(req.Definition))
	if len(issues) > 0 {
		writeInvalidDefinition(w, "the definition could not be read", issues)
		return
	}
	note, ok := trimmedWorkflowText(w, req.Note, maxWorkflowNoteLen, "note")
	if !ok {
		return
	}
	layout, err := normalizeWorkflowLayout(req.Layout)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.saveLockedVersion(w, r, workspaceID, userID, func(wf db.Workflow) (*workflow.Definition, json.RawMessage, string, string, map[string]any, bool) {
		if *req.BaseVersion != wf.LatestVersion {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":          "a newer version was saved first",
				"code":           workflowErrVersionConflict,
				"latest_version": wf.LatestVersion,
			})
			return nil, nil, "", "", nil, false
		}
		if def.Metadata.ID != wf.Key {
			writeInvalidDefinition(w, "metadata.id cannot be changed", []workflow.Issue{{
				Path:    "metadata.id",
				Message: fmt.Sprintf("must stay %q (it is the workflow's key)", wf.Key),
			}})
			return nil, nil, "", "", nil, false
		}
		return def, layout, note, workflowAuditSave, nil, true
	})
}

// RestoreWorkflowVersion saves an old version's content as the newest version.
// History is never rewritten: the old version stays as it was.
func (h *Handler) RestoreWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	from, ok := parseWorkflowVersionParam(w, r)
	if !ok {
		return
	}
	h.saveLockedVersion(w, r, workspaceID, userID, func(wf db.Workflow) (*workflow.Definition, json.RawMessage, string, string, map[string]any, bool) {
		old, err := h.Queries.GetWorkflowVersion(r.Context(), db.GetWorkflowVersionParams{
			WorkflowID: wf.ID, WorkspaceID: wf.WorkspaceID, Version: from,
		})
		if err != nil {
			if isNotFound(err) {
				writeError(w, http.StatusNotFound, "version not found")
			} else {
				writeError(w, http.StatusInternalServerError, "failed to load version")
			}
			return nil, nil, "", "", nil, false
		}
		def, issues := workflow.Parse([]byte(old.Definition))
		if len(issues) > 0 {
			slog.Error("stored workflow version cannot be parsed", append(logger.RequestAttrs(r), "workflow_id", uuidToString(wf.ID), "version", from)...)
			writeError(w, http.StatusInternalServerError, "the stored version cannot be read")
			return nil, nil, "", "", nil, false
		}
		return def, json.RawMessage(old.Layout), fmt.Sprintf(workflowRestoreNoteFormat, from), workflowAuditRestore,
			map[string]any{"from_version": from}, true
	})
}

// saveLockedVersion is the shared tail of save and restore: take the workflow
// row lock, let `prepare` check it and produce what to save (or answer the
// request itself and return false), insert the version, commit, announce it.
func (h *Handler) saveLockedVersion(
	w http.ResponseWriter, r *http.Request, workspaceID, userID string,
	prepare func(wf db.Workflow) (def *workflow.Definition, layout json.RawMessage, note, action string, detail map[string]any, ok bool),
) {
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
		writeError(w, http.StatusInternalServerError, "failed to save version")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	wf, err := qtx.GetWorkflowForUpdate(r.Context(), db.GetWorkflowForUpdateParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "workflow not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load workflow")
		}
		return
	}
	if wf.Status == workflowStatusArchived {
		writeError(w, http.StatusConflict, "an archived workflow cannot be changed; restore it first")
		return
	}
	def, layout, note, action, detail, ok := prepare(wf)
	if !ok {
		return
	}
	ww := workflowWriter{h: h, q: qtx, userID: parseUUID(userID), request: r}
	head, version, err := ww.saveVersion(wf, def, layout, note, action, detail)
	if err != nil {
		slog.Warn("save workflow version failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save version")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save version")
		return
	}

	resp := workflowToResponse(head)
	vr := workflowVersionToResponse(version)
	h.publish(protocol.EventWorkflowVersionCreated, workspaceID, "member", userID, map[string]any{
		"workflow": resp,
		"version":  map[string]any{"version": vr.Version, "content_hash": vr.ContentHash, "note": vr.Note},
	})
	writeJSON(w, http.StatusCreated, workflowWithVersionResponse{Workflow: resp, Version: &vr})
}

// UpdateWorkflow renames, re-describes, archives or unarchives a workflow.
// `revision` must be the one the caller loaded: a stale one answers 409.
func (h *Handler) UpdateWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireWorkflowManager(w, r)
	if !ok {
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		Revision    *int64  `json:"revision"`
	}
	if !decodeWorkflowBody(w, r, &req) {
		return
	}
	if req.Revision == nil {
		writeError(w, http.StatusBadRequest, "revision is required")
		return
	}
	if req.Name == nil && req.Description == nil && req.Status == nil {
		writeError(w, http.StatusBadRequest, "nothing to update")
		return
	}
	params := db.UpdateWorkflowDetailsParams{ExpectedRevision: *req.Revision}
	if req.Name != nil {
		name, ok := trimmedWorkflowText(w, *req.Name, maxWorkflowNameLen, "name")
		if !ok {
			return
		}
		if name == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty")
			return
		}
		params.Name = pgtype.Text{String: name, Valid: true}
	}
	if req.Description != nil {
		description, ok := trimmedWorkflowText(w, *req.Description, maxWorkflowDescriptionLen, "description")
		if !ok {
			return
		}
		params.Description = pgtype.Text{String: description, Valid: true}
	}
	if req.Status != nil {
		if *req.Status != workflowStatusActive && *req.Status != workflowStatusArchived {
			writeError(w, http.StatusBadRequest, "status must be active or archived")
			return
		}
		params.Status = pgtype.Text{String: *req.Status, Valid: true}
	}

	current, ok := h.loadWorkflow(w, r, workspaceID)
	if !ok {
		return
	}
	params.ID, params.WorkspaceID = current.ID, current.WorkspaceID

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update workflow")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	updated, err := qtx.UpdateWorkflowDetails(r.Context(), params)
	if err != nil {
		if isNotFound(err) {
			// The revision guard matched nothing: report what it is now.
			if latest, lerr := h.Queries.GetWorkflow(r.Context(), db.GetWorkflowParams{ID: current.ID, WorkspaceID: current.WorkspaceID}); lerr == nil {
				writeRevisionConflict(w, "workflow", current.ID, *req.Revision, latest.Revision)
				return
			}
			writeError(w, http.StatusNotFound, "workflow not found")
			return
		}
		slog.Warn("update workflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update workflow")
		return
	}
	ww := workflowWriter{h: h, q: qtx, userID: parseUUID(userID), request: r}
	action := workflowAuditRename
	switch {
	case updated.Status != current.Status && updated.Status == workflowStatusArchived:
		action = workflowAuditArchive
	case updated.Status != current.Status:
		action = workflowAuditUnarchive
	}
	if err := ww.audit(updated, pgtype.Int4{}, action, map[string]any{"status": updated.Status, "name": updated.Name}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update workflow")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update workflow")
		return
	}
	resp := workflowToResponse(updated)
	h.publish(protocol.EventWorkflowUpdated, workspaceID, "member", userID, map[string]any{"workflow": resp})
	writeJSON(w, http.StatusOK, resp)
}
