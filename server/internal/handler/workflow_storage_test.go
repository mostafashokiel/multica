package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// These tests cover the workflow tables and their queries directly, before any
// endpoint exists to reach them.

func storageWorkspace(t *testing.T, slug string) pgtype.UUID {
	t.Helper()
	ctx := context.Background()
	_, _ = testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)
	var id pgtype.UUID
	if err := testPool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, description) VALUES ($1, $1, '') RETURNING id`, slug).Scan(&id); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, id) })
	return id
}

// storageWorkflow inserts a workflow with one version and one audit row.
func storageWorkflow(t *testing.T, ws pgtype.UUID, key string) db.Workflow {
	t.Helper()
	ctx := context.Background()
	user := parseUUID(testUserID)
	wf, err := testHandler.Queries.CreateWorkflow(ctx, db.CreateWorkflowParams{
		WorkspaceID: ws, Key: key, Name: key, CreatedByType: "member", CreatedByID: user,
	})
	if err != nil {
		t.Fatalf("CreateWorkflow(%s): %v", key, err)
	}
	if _, err := testHandler.Queries.InsertWorkflowVersion(ctx, db.InsertWorkflowVersionParams{
		WorkspaceID: ws, WorkflowID: wf.ID, Version: 1, Definition: "kind: Workflow\n", ContentHash: strings.Repeat("a", 64),
		Layout: []byte(`{}`), CreatedByType: "member", CreatedByID: user,
	}); err != nil {
		t.Fatalf("InsertWorkflowVersion: %v", err)
	}
	if err := testHandler.Queries.InsertWorkflowAudit(ctx, db.InsertWorkflowAuditParams{
		WorkspaceID: ws, WorkflowID: wf.ID, Version: pgtype.Int4{Int32: 1, Valid: true}, Action: "create",
		ActorType: "member", ActorID: user, Detail: []byte(`{}`),
	}); err != nil {
		t.Fatalf("InsertWorkflowAudit: %v", err)
	}
	return wf
}

func countWorkflowRows(t *testing.T, ws pgtype.UUID) (workflows, versions, audits int) {
	t.Helper()
	for table, dst := range map[string]*int{"workflow": &workflows, "workflow_version": &versions, "workflow_audit": &audits} {
		if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM `+table+` WHERE workspace_id = $1`, ws).Scan(dst); err != nil {
			t.Fatal(err)
		}
	}
	return
}

func TestDeleteWorkspaceSweepsItsWorkflowsAndOnlyThose(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	doomed := storageWorkspace(t, "handler-tests-workflow-delete")
	kept := storageWorkspace(t, "handler-tests-workflow-kept")
	for _, ws := range []pgtype.UUID{doomed, kept} {
		storageWorkflow(t, ws, "flow-a")
		storageWorkflow(t, ws, "flow-b")
	}
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, doomed, testUserID); err != nil {
		t.Fatalf("create owner member: %v", err)
	}

	if w, v, a := countWorkflowRows(t, doomed); w != 2 || v != 2 || a != 2 {
		t.Fatalf("seed rows = %d/%d/%d, want 2/2/2", w, v, a)
	}

	id := uuidToString(doomed)
	rec := httptest.NewRecorder()
	testHandler.DeleteWorkspace(rec, withURLParam(newRequest(http.MethodDelete, "/api/workspaces/"+id, nil), "id", id))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DeleteWorkspace: expected 204, got %d: %s", rec.Code, rec.Body.String())
	}

	if w, v, a := countWorkflowRows(t, doomed); w != 0 || v != 0 || a != 0 {
		t.Errorf("deleted workspace still has workflow rows: %d workflows, %d versions, %d audit", w, v, a)
	}
	if w, v, a := countWorkflowRows(t, kept); w != 2 || v != 2 || a != 2 {
		t.Errorf("another workspace lost workflow rows: %d/%d/%d, want 2/2/2", w, v, a)
	}
}

func TestWorkflowKeyIsUniquePerWorkspaceAndKeptOutOfListsWhenArchived(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	one := storageWorkspace(t, "handler-tests-workflow-key-1")
	two := storageWorkspace(t, "handler-tests-workflow-key-2")

	first := storageWorkflow(t, one, "same-key")
	storageWorkflow(t, two, "same-key") // the same key in another workspace is fine

	_, err := testHandler.Queries.CreateWorkflow(ctx, db.CreateWorkflowParams{
		WorkspaceID: one, Key: "same-key", Name: "dup", CreatedByType: "member", CreatedByID: parseUUID(testUserID),
	})
	if err == nil {
		t.Fatal("a second workflow with the same key in one workspace must be refused")
	}

	archived := "archived"
	if _, err := testHandler.Queries.UpdateWorkflowDetails(ctx, db.UpdateWorkflowDetailsParams{
		ID: first.ID, WorkspaceID: one, ExpectedRevision: first.Revision, Status: pgtype.Text{String: archived, Valid: true},
	}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	active, _ := testHandler.Queries.ListWorkflows(ctx, db.ListWorkflowsParams{WorkspaceID: one})
	all, _ := testHandler.Queries.ListWorkflows(ctx, db.ListWorkflowsParams{WorkspaceID: one, IncludeArchived: true})
	if len(active) != 0 || len(all) != 1 {
		t.Errorf("active=%d all=%d, want 0 and 1", len(active), len(all))
	}
}

func TestWorkflowQueriesAreScopedToTheirWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	mine := storageWorkspace(t, "handler-tests-workflow-scope-1")
	theirs := storageWorkspace(t, "handler-tests-workflow-scope-2")
	wf := storageWorkflow(t, mine, "scoped")

	if _, err := testHandler.Queries.GetWorkflow(ctx, db.GetWorkflowParams{ID: wf.ID, WorkspaceID: theirs}); err == nil {
		t.Error("GetWorkflow found another workspace's workflow")
	}
	if _, err := testHandler.Queries.GetWorkflowVersion(ctx, db.GetWorkflowVersionParams{WorkflowID: wf.ID, WorkspaceID: theirs, Version: 1}); err == nil {
		t.Error("GetWorkflowVersion found another workspace's version")
	}
	// Writes with the wrong workspace match nothing.
	if _, err := testHandler.Queries.SetWorkflowLatestVersion(ctx, db.SetWorkflowLatestVersionParams{ID: wf.ID, WorkspaceID: theirs, LatestVersion: 9}); err == nil {
		t.Error("SetWorkflowLatestVersion moved another workspace's head")
	}
	got, err := testHandler.Queries.GetWorkflow(ctx, db.GetWorkflowParams{ID: wf.ID, WorkspaceID: mine})
	if err != nil || got.LatestVersion != 0 {
		t.Errorf("head changed or unreadable: %+v %v", got, err)
	}
}

func TestWorkflowRevisionGuardRejectsAStaleHead(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	ws := storageWorkspace(t, "handler-tests-workflow-revision")
	wf := storageWorkflow(t, ws, "guarded")

	rename := func(revision int64, name string) error {
		_, err := testHandler.Queries.UpdateWorkflowDetails(ctx, db.UpdateWorkflowDetailsParams{
			ID: wf.ID, WorkspaceID: ws, ExpectedRevision: revision, Name: pgtype.Text{String: name, Valid: true},
		})
		return err
	}
	if err := rename(wf.Revision, "first"); err != nil {
		t.Fatalf("rename with the current revision: %v", err)
	}
	if err := rename(wf.Revision, "second"); err == nil {
		t.Fatal("a rename with a stale revision must match no row")
	}
	got, _ := testHandler.Queries.GetWorkflow(ctx, db.GetWorkflowParams{ID: wf.ID, WorkspaceID: ws})
	if got.Name != "first" || got.Revision != wf.Revision+1 {
		t.Errorf("after one winning rename: name=%q revision=%d (was %d)", got.Name, got.Revision, wf.Revision)
	}
}

func TestWorkflowTablesRefuseValuesTheHandlersNeverWrite(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	ws := storageWorkspace(t, "handler-tests-workflow-checks")
	wf := storageWorkflow(t, ws, "checked")
	user := parseUUID(testUserID)

	if _, err := testHandler.Queries.InsertWorkflowVersion(ctx, db.InsertWorkflowVersionParams{
		WorkspaceID: ws, WorkflowID: wf.ID, Version: 1, Definition: "x", ContentHash: "h", Layout: []byte(`{}`),
		CreatedByType: "member", CreatedByID: user,
	}); err == nil {
		t.Error("a second row for the same (workflow, version) must be refused: versions are immutable")
	}
	if _, err := testHandler.Queries.CreateWorkflow(ctx, db.CreateWorkflowParams{
		WorkspaceID: ws, Key: "bad-actor", Name: "x", CreatedByType: "robot", CreatedByID: user,
	}); err == nil {
		t.Error("an unknown created_by_type must be refused")
	}
	if err := testHandler.Queries.InsertWorkflowAudit(ctx, db.InsertWorkflowAuditParams{
		WorkspaceID: ws, WorkflowID: wf.ID, Action: "explode", ActorType: "member", ActorID: user, Detail: []byte(`{}`),
	}); err == nil {
		t.Error("an unknown audit action must be refused")
	}
}
