package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func listWorkflowSquads(t *testing.T, id string) []WorkflowSquadResponse {
	t.Helper()
	var out struct {
		Squads []WorkflowSquadResponse `json:"squads"`
	}
	testutil.Call(t, testHandler.ListWorkflowSquads, withURLParam(newRequest("GET", "/x", nil), "id", id)).
		Want(http.StatusOK).JSON(&out)
	return out.Squads
}

func TestListWorkflowSquadsReadsTheMarkersAndSaysWhoIsBehind(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	other := createWorkflowFor(t, freshWorkflowKey())
	id, key := created.Workflow.ID, created.Workflow.Key
	if got := listWorkflowSquads(t, id); len(got) != 0 {
		t.Fatalf("no squad follows it yet: %+v", got)
	}

	zed := newTestSquad(t, "Usage Zed")
	alpha := newTestSquad(t, "usage alpha")
	elsewhere := newTestSquad(t, "Usage Elsewhere")
	plain := newTestSquad(t, "Usage Plain")
	setSquadInstructions(t, plain.ID, "Mentions workflow-managed:begin in prose only.\n")
	apply(t, id, map[string]any{"squad_id": zed.ID}).Want(http.StatusOK)
	apply(t, id, map[string]any{"squad_id": alpha.ID}).Want(http.StatusOK)
	apply(t, other.Workflow.ID, map[string]any{"squad_id": elsewhere.ID}).Want(http.StatusOK)

	got := listWorkflowSquads(t, id)
	if len(got) != 2 || got[0].Name != "usage alpha" || got[1].Name != "Usage Zed" {
		t.Fatalf("want the two squads, ordered by name without regard to case: %+v", got)
	}
	for _, s := range got {
		if s.Version != 1 || !s.UpToDate || s.ContentHash != created.Version.ContentHash {
			t.Errorf("a freshly applied squad is up to date: %+v", s)
		}
	}

	// A new version leaves both behind until they are applied again.
	saveWorkflowVersion(t, id, map[string]any{"definition": workflowYAML(key, "second text"), "base_version": 1}).
		Want(http.StatusCreated)
	apply(t, id, map[string]any{"squad_id": alpha.ID}).Want(http.StatusOK)
	got = listWorkflowSquads(t, id)
	if len(got) != 2 || got[0].Version != 2 || !got[0].UpToDate || got[1].Version != 1 || got[1].UpToDate {
		t.Fatalf("alpha moved to version 2, zed is behind: %+v", got)
	}

	// An archived squad no longer counts; a damaged marker is left out, not guessed at.
	setSquadInstructions(t, zed.ID, strings.Split(squadInstructions(t, zed.ID), "\n<!-- workflow-managed:end")[0])
	got = listWorkflowSquads(t, id)
	if len(got) != 1 || got[0].SquadID != alpha.ID {
		t.Fatalf("zed's block lost its closing marker: %+v", got)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE squad SET archived_at = now() WHERE id = $1`, alpha.ID); err != nil {
		t.Fatal(err)
	}
	if got = listWorkflowSquads(t, id); len(got) != 0 {
		t.Fatalf("archived squads are not listed: %+v", got)
	}
}

func TestListWorkflowSquadsRespectsTheFlagAndTheWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	id := "00000000-0000-0000-0000-000000000000"
	testutil.Call(t, testHandler.ListWorkflowSquads, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusForbidden)

	enableWorkflows(t)
	testutil.Call(t, testHandler.ListWorkflowSquads, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusNotFound)
	outsider := dbfx.User(t, "WF Usage Outsider", "wf-usage-outsider@example.test")
	created := createWorkflowFor(t, freshWorkflowKey())
	testutil.Call(t, testHandler.ListWorkflowSquads,
		withURLParam(newRequestAs(outsider, "GET", "/x", nil), "id", created.Workflow.ID)).Want(http.StatusNotFound)
}
