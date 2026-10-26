package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func archiveWorkflow(t *testing.T, id string, revision int64) WorkflowResponse {
	t.Helper()
	var out WorkflowResponse
	testutil.Call(t, testHandler.UpdateWorkflow, withURLParam(newRequest("PATCH", "/x", map[string]any{"status": "archived", "revision": revision}), "id", id)).
		Want(http.StatusOK).JSON(&out)
	return out
}

func deleteWorkflow(t *testing.T, id string) *testutil.Response {
	t.Helper()
	return testutil.Call(t, testHandler.DeleteWorkflow, withURLParam(newRequest("DELETE", "/x", nil), "id", id))
}

func countRows(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeleteWorkflowNeedsItToBeArchivedFirst(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())

	w := deleteWorkflow(t, created.Workflow.ID).Want(http.StatusConflict)

	if !strings.Contains(w.Body.String(), "workflow_not_archived") {
		t.Errorf("want workflow_not_archived, got %s", w.Body.String())
	}
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", created.Workflow.ID)).Want(http.StatusOK)
}

func TestDeleteWorkflowIsRefusedWhileASquadStillFollowsIt(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id := created.Workflow.ID
	squad := newTestSquad(t, "Delete Follower")
	apply(t, id, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK)
	archived := archiveWorkflow(t, id, mustRevision(t, id))

	w := deleteWorkflow(t, id).Want(http.StatusConflict)

	if body := w.Body.String(); !strings.Contains(body, "workflow_in_use") || !strings.Contains(body, "Delete Follower") {
		t.Errorf("want workflow_in_use naming the squad, got %s", body)
	}
	if countRows(t, `SELECT count(*) FROM workflow WHERE id = $1`, id) != 1 || archived.Status != "archived" {
		t.Error("a refused delete must leave the workflow where it was")
	}

	// Once the squad no longer carries the block, the delete goes through.
	setSquadInstructions(t, squad.ID, "")
	deleteWorkflow(t, id).Want(http.StatusNoContent)
}

func TestDeleteWorkflowRemovesItsVersionsAndAuditAndNothingElse(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	created := createWorkflowFor(t, key)
	id := created.Workflow.ID
	saveWorkflowVersion(t, id, map[string]any{"definition": workflowYAML(key, "second"), "base_version": 1}).Want(http.StatusCreated)
	keep := createWorkflowFor(t, freshWorkflowKey())
	wfLabel := pipelineLabel(t, "wf:"+key)
	issue := pipelineIssue(t, "follows it", "todo", wfLabel)
	archiveWorkflow(t, id, mustRevision(t, id))
	if countRows(t, `SELECT count(*) FROM workflow_version WHERE workflow_id = $1`, id) != 2 {
		t.Fatal("setup: two versions expected")
	}

	deleteWorkflow(t, id).Want(http.StatusNoContent)

	for table, q := range map[string]string{
		"workflow":         `SELECT count(*) FROM workflow WHERE id = $1`,
		"workflow_version": `SELECT count(*) FROM workflow_version WHERE workflow_id = $1`,
		"workflow_audit":   `SELECT count(*) FROM workflow_audit WHERE workflow_id = $1`,
	} {
		if n := countRows(t, q, id); n != 0 {
			t.Errorf("%s still has %d rows for the deleted workflow", table, n)
		}
	}
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusNotFound)
	// Another workflow keeps its history, and the issue keeps its label.
	if countRows(t, `SELECT count(*) FROM workflow_version WHERE workflow_id = $1`, keep.Workflow.ID) != 1 {
		t.Error("another workflow lost its versions")
	}
	if countRows(t, `SELECT count(*) FROM issue_to_label WHERE issue_id = $1`, issue) != 1 {
		t.Error("the issue lost its label")
	}
	// A second delete finds nothing.
	deleteWorkflow(t, id).Want(http.StatusNotFound)
}

func mustRevision(t *testing.T, id string) int64 {
	t.Helper()
	var n int64
	if err := testPool.QueryRow(context.Background(), `SELECT revision FROM workflow WHERE id = $1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
