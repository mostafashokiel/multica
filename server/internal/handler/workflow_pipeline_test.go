package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func pipelineLabel(t *testing.T, name string) string {
	t.Helper()
	return dbfx.Insert(t, "issue_label", testutil.Cols{
		"workspace_id": testWorkspaceID, "name": name, "color": "#888888", "resource_type": "issue",
	})
}

func pipelineIssue(t *testing.T, title, status string, labels ...string) string {
	t.Helper()
	id := dbfx.Issue(t, title, testutil.Cols{"status": status})
	for _, l := range labels {
		dbfx.Exec(t, `INSERT INTO issue_to_label (issue_id, label_id) VALUES ($1, $2)`, id, l)
	}
	return id
}

func getPipeline(t *testing.T, id string) WorkflowPipelineResponse {
	t.Helper()
	var out WorkflowPipelineResponse
	testutil.Call(t, testHandler.WorkflowPipeline, withURLParam(newRequest("GET", "/x", nil), "id", id)).
		Want(http.StatusOK).JSON(&out)
	return out
}

func titles(items []WorkflowPipelineIssue) []string {
	out := []string{}
	for _, i := range items {
		out = append(out, i.Title)
	}
	return out
}

func TestWorkflowPipelineIsOffByDefault(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	w := testutil.Call(t, testHandler.WorkflowPipeline,
		withURLParam(newRequest("GET", "/x", nil), "id", "00000000-0000-0000-0000-000000000000")).Want(http.StatusForbidden)
	if !strings.Contains(w.Body.String(), "workflows_disabled") {
		t.Errorf("want workflows_disabled, got %s", w.Body.String())
	}
}

func TestWorkflowPipelineSortsIssuesIntoTheStagesTheLabelsName(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	created := createWorkflowFor(t, key)
	wf := pipelineLabel(t, "wf:"+key)
	build, review := pipelineLabel(t, "phase:build"), pipelineLabel(t, "phase:review")
	gone := pipelineLabel(t, "phase:renamed-away")

	pipelineIssue(t, "in build", "in_progress", wf, build)
	pipelineIssue(t, "in review", "in_review", wf, review)
	pipelineIssue(t, "just started", "todo", wf)
	pipelineIssue(t, "two phases", "todo", wf, build, review)
	pipelineIssue(t, "stale phase", "todo", wf, gone)
	pipelineIssue(t, "cancelled", "cancelled", wf, build)
	pipelineIssue(t, "other workflow", "todo", build) // no wf label: not ours

	got := getPipeline(t, created.Workflow.ID)

	if got.WorkflowKey != key || got.Version != 1 {
		t.Errorf("unexpected header: %+v", got)
	}
	// Columns follow the definition (build, review, done); no condition stage exists here.
	ids := []string{}
	for _, s := range got.Stages {
		ids = append(ids, s.ID)
	}
	if strings.Join(ids, ",") != "build,review,done" {
		t.Fatalf("stages = %v", ids)
	}
	if g := titles(got.Stages[0].Issues); len(g) != 1 || g[0] != "in build" {
		t.Errorf("build: %v", g)
	}
	if g := titles(got.Stages[1].Issues); len(g) != 1 || g[0] != "in review" {
		t.Errorf("review: %v", g)
	}
	if len(got.Stages[2].Issues) != 0 {
		t.Errorf("done should be empty: %v", titles(got.Stages[2].Issues))
	}
	if g := titles(got.NoStage); len(g) != 1 || g[0] != "just started" {
		t.Errorf("no stage: %v", g)
	}
	if g := titles(got.Conflicting); len(g) != 1 || g[0] != "two phases" || len(got.Conflicting[0].Phases) != 2 {
		t.Errorf("conflicting: %+v", got.Conflicting)
	}
	if g := titles(got.UnknownStage); len(g) != 1 || g[0] != "stale phase" || got.UnknownStage[0].Phases[0] != "phase:renamed-away" {
		t.Errorf("unknown: %+v", got.UnknownStage)
	}
	if got.Total != 5 || got.Truncated {
		t.Errorf("total/truncated = %d/%v (cancelled and unlabelled issues do not count)", got.Total, got.Truncated)
	}
	first := got.Stages[0].Issues[0]
	if !strings.Contains(first.Identifier, "-") || first.Status != "in_progress" || first.ID == "" || first.UpdatedAt == "" {
		t.Errorf("an issue should carry identifier, status, id and time: %+v", first)
	}
}

func TestWorkflowPipelineWithNoIssuesShowsEmptyColumns(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	got := getPipeline(t, created.Workflow.ID)
	if got.Total != 0 || len(got.Stages) != 3 {
		t.Errorf("an empty workflow still has its stages as empty columns: %+v", got)
	}
}

func TestWorkflowPipelineIsScopedToTheWorkspace(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	outsider := dbfx.User(t, "WF Pipeline Outsider", "wf-pipeline-outsider@example.test")
	testutil.Call(t, testHandler.WorkflowPipeline,
		withURLParam(newRequestAs(outsider, "GET", "/x", nil), "id", created.Workflow.ID)).Want(http.StatusNotFound)
}

func TestWorkflowPipelineNamesWhoAHumanGateWaitsFor(t *testing.T) {
	enableWorkflows(t)
	person := dbfx.User(t, "WF Gate Person", "wf-gate-person@example.test")
	dbfx.Member(t, testWorkspaceID, person, "member")
	stranger := dbfx.User(t, "WF Gate Stranger", "wf-gate-stranger@example.test")
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), "builder",
		"user:"+person, "user:"+stranger, "user:<multica-user-id>"))

	got := getPipeline(t, created.Workflow.ID)

	byID := map[string]WorkflowPipelineStage{}
	for _, s := range got.Stages {
		byID[s.ID] = s
	}
	if len(byID["build"].Approvers) != 0 || len(byID["done"].Approvers) != 0 {
		t.Errorf("only a human gate waits for people: %+v", got.Stages)
	}
	gate := byID["review"].Approvers
	if len(gate) != 3 {
		t.Fatalf("review should list its three entries in order: %+v", gate)
	}
	if gate[0].Name != "WF Gate Person" || gate[0].ID != person || gate[0].Ref != "user:"+person {
		t.Errorf("a registered member is named: %+v", gate[0])
	}
	for _, a := range gate[1:] {
		if a.Name != "" || a.ID != "" {
			t.Errorf("someone who is not a member of the workspace has no name and no id: %+v", a)
		}
	}
}

func TestWorkflowPipelineCanBeFilteredBySquad(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	created := createWorkflowFor(t, key)
	wf := pipelineLabel(t, "wf:"+key)
	build := pipelineLabel(t, "phase:build")
	mine, other := newTestSquad(t, "Pipeline Mine"), newTestSquad(t, "Pipeline Other")

	own := pipelineIssue(t, "owned by mine", "in_progress", wf, build)
	elsewhere := pipelineIssue(t, "owned by other", "in_progress", wf, build)
	pipelineIssue(t, "owned by nobody", "todo", wf, build)
	for id, squad := range map[string]string{own: mine.ID, elsewhere: other.ID} {
		dbfx.Exec(t, `UPDATE issue SET assignee_type = 'squad', assignee_id = $2 WHERE id = $1`, id, squad)
	}

	pipeline := func(query string) WorkflowPipelineResponse {
		var out WorkflowPipelineResponse
		testutil.Call(t, testHandler.WorkflowPipeline,
			withURLParam(newRequest("GET", "/x"+query, nil), "id", created.Workflow.ID)).Want(http.StatusOK).JSON(&out)
		return out
	}
	all := pipeline("")
	if all.Total != 3 {
		t.Errorf("no filter keeps everything: %d", all.Total)
	}
	if g := titles(pipeline("?squad=" + mine.ID).Stages[0].Issues); len(g) != 1 || g[0] != "owned by mine" {
		t.Errorf("one squad: %v", g)
	}
	if g := titles(pipeline("?squad=none").Stages[0].Issues); len(g) != 1 || g[0] != "owned by nobody" {
		t.Errorf("no squad: %v", g)
	}
	// Columns do not depend on the filter; an unknown squad matches nothing.
	if got := pipeline("?squad=00000000-0000-0000-0000-000000000000"); got.Total != 0 || len(got.Stages) != 3 {
		t.Errorf("unknown squad: %+v", got)
	}
	testutil.Call(t, testHandler.WorkflowPipeline,
		withURLParam(newRequest("GET", "/x?squad=nonsense", nil), "id", created.Workflow.ID)).Want(http.StatusBadRequest)
}
