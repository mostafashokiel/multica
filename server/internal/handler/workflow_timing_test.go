package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// timingWorkflow is a workflow whose gate lists the test user, so the user's comment answers it.
func timingWorkflow(t *testing.T) workflowCreated {
	t.Helper()
	key := freshWorkflowKey()
	def := strings.Replace(workflowYAML(key, ""), "qa: [user:u1]", "qa: ['user:"+testUserID+"']", 1)
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{"definition": def})).
		Want(http.StatusCreated).JSON(&out)
	return out
}

// stageEvent records an entry or exit that happened `ago` minutes ago, as the label trigger would have.
func stageEvent(t *testing.T, issue, stage, kind string, agoMinutes int) {
	t.Helper()
	dbfx.Exec(t, `INSERT INTO workflow_stage_event (workspace_id, issue_id, stage_id, kind, occurred_at)
		VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))`, testWorkspaceID, issue, stage, kind, agoMinutes)
}

func agentRun(t *testing.T, agentName, issue string, startAgo, endAgo int) {
	t.Helper()
	agent := createHandlerTestAgent(t, agentName, nil)
	dbfx.Exec(t, `INSERT INTO agent_task_queue (agent_id, issue_id, status, started_at, completed_at)
		VALUES ($1, $2, 'completed', now() - make_interval(mins => $3), now() - make_interval(mins => $4))`, agent, issue, startAgo, endAgo)
}

func memberCommentAgo(t *testing.T, issue string, agoMinutes int) {
	t.Helper()
	dbfx.Exec(t, `INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, created_at)
		VALUES ($1, $2, 'member', $3, 'ok', now() - make_interval(mins => $4))`, issue, testWorkspaceID, testUserID, agoMinutes)
}

func getRun(t *testing.T, issue string) *testutil.Response {
	t.Helper()
	return testutil.Call(t, testHandler.WorkflowRun, withURLParam(newRequest("GET", "/x", nil), "issue_id", issue))
}

func countEvents(t *testing.T, issue string) int {
	t.Helper()
	return countRows(t, `SELECT count(*) FROM workflow_stage_event WHERE issue_id = $1`, issue)
}

func TestPhaseLabelChangesAreRecordedAsStageEvents(t *testing.T) {
	enableWorkflows(t)
	build, review := pipelineLabel(t, "phase:build"), pipelineLabel(t, "phase:review")
	other := pipelineLabel(t, "wf:"+freshWorkflowKey())
	issue := dbfx.Issue(t, "labelled", testutil.Cols{"status": "todo"})

	dbfx.Exec(t, `INSERT INTO issue_to_label (issue_id, label_id) VALUES ($1, $2)`, issue, other)
	if n := countEvents(t, issue); n != 0 {
		t.Fatalf("a label that is not a phase is not a stage: %d events", n)
	}
	dbfx.Exec(t, `INSERT INTO issue_to_label (issue_id, label_id) VALUES ($1, $2)`, issue, build)
	dbfx.Exec(t, `INSERT INTO issue_to_label (issue_id, label_id) VALUES ($1, $2)`, issue, review)
	dbfx.Exec(t, `DELETE FROM issue_to_label WHERE issue_id = $1 AND label_id = $2`, issue, build)

	rows, err := testPool.Query(context.Background(), `SELECT stage_id || ':' || kind FROM workflow_stage_event WHERE issue_id = $1 ORDER BY occurred_at, id`, issue)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		got = append(got, s)
	}
	if want := "build:entered review:entered build:left"; strings.Join(got, " ") != want {
		t.Errorf("events = %v, want %s", got, want)
	}

	// Deleting the issue deletes its labels; that must not write more events for an issue that is gone.
	before := countRows(t, `SELECT count(*) FROM workflow_stage_event`)
	dbfx.Exec(t, `DELETE FROM issue WHERE id = $1`, issue)
	if after := countRows(t, `SELECT count(*) FROM workflow_stage_event`); after != before {
		t.Errorf("deleting an issue wrote %d stage events", after-before)
	}
}

func TestWorkflowRunMeasuresWhereTheTimeWent(t *testing.T) {
	enableWorkflows(t)
	created := timingWorkflow(t)
	wfLabel := pipelineLabel(t, "wf:"+created.Workflow.Key)
	issue := pipelineIssue(t, "a finished run", "done", wfLabel)

	// build 60 -> 40 minutes ago (the agent worked 59 -> 41), then the gate until the issue was approved
	// 30 minutes ago, left 29 minutes ago for the end stage.
	stageEvent(t, issue, "build", "entered", 60)
	stageEvent(t, issue, "build", "left", 40)
	stageEvent(t, issue, "review", "entered", 40)
	stageEvent(t, issue, "review", "left", 29)
	stageEvent(t, issue, "done", "entered", 29)
	agentRun(t, "builder", issue, 59, 41)
	memberCommentAgo(t, issue, 30)

	var got WorkflowRunResponse
	getRun(t, issue).Want(http.StatusOK).JSON(&got)

	if got.Workflow.Key != created.Workflow.Key || got.Issue.Title != "a finished run" || got.Issue.Identifier == "" {
		t.Errorf("header = %+v %+v", got.Workflow, got.Issue)
	}
	tl := got.Timeline
	if tl.Open || tl.EndedAt == nil || len(tl.Visits) != 3 {
		t.Fatalf("a run that reached the end stage is finished: %+v", tl)
	}
	// Allow a second or two for the time the test itself took between inserting rows and asking.
	near := func(label string, got, want int64) {
		t.Helper()
		if got < want-2 || got > want+2 {
			t.Errorf("%s = %d, want about %d", label, got, want)
		}
	}
	near("elapsed", tl.ElapsedSeconds, 31*60)
	near("agent", tl.AgentSeconds, 18*60)
	near("people", tl.PeopleSeconds, 10*60)
	near("handoffs", tl.HandoffSeconds, 3*60)
	build, review := tl.Visits[0], tl.Visits[1]
	near("build elapsed", build.ElapsedSeconds, 20*60)
	near("review wait", review.WaitSeconds, 10*60)
	if review.Outcome != "approved" || review.DecidedBy == nil || review.DecidedBy.Ref != "user:"+testUserID || review.DecidedBy.Name == "" {
		t.Errorf("the gate was answered by the test user, named: %+v", review)
	}
	if build.Agent != "builder" || build.Name == "" || tl.Visits[2].Type != "end" {
		t.Errorf("visits = %+v", tl.Visits)
	}
}

func TestWorkflowRunCountsAnOpenRunUpToNow(t *testing.T) {
	enableWorkflows(t)
	created := timingWorkflow(t)
	issue := pipelineIssue(t, "waiting at the gate", "in_progress", pipelineLabel(t, "wf:"+created.Workflow.Key))
	stageEvent(t, issue, "review", "entered", 90)

	var got WorkflowRunResponse
	getRun(t, issue).Want(http.StatusOK).JSON(&got)

	v := got.Timeline.Visits[0]
	if !got.Timeline.Open || !v.Open || v.Outcome != "waiting" || v.WaitSeconds < 90*60-2 {
		t.Errorf("a gate nobody answered keeps counting: %+v", v)
	}
}

func TestWorkflowRunRefusesWhatIsNotAWorkflowRun(t *testing.T) {
	enableWorkflows(t)
	plain := dbfx.Issue(t, "no workflow", testutil.Cols{"status": "todo"})

	w := getRun(t, plain).Want(http.StatusNotFound)
	if !strings.Contains(w.Body.String(), "not_in_workflow") {
		t.Errorf("want not_in_workflow, got %s", w.Body.String())
	}
	getRun(t, "00000000-0000-0000-0000-000000000000").Want(http.StatusNotFound)
	getRun(t, "not-a-uuid").Want(http.StatusBadRequest)
}

func TestPipelineSaysWhenIssuesEnteredTheirStageAndWhatIsTypical(t *testing.T) {
	enableWorkflows(t)
	created := timingWorkflow(t)
	wf, build := pipelineLabel(t, "wf:"+created.Workflow.Key), pipelineLabel(t, "phase:build")
	current := pipelineIssue(t, "current", "in_progress", wf, build) // the label trigger writes its entry
	// Two issues that already went through build: 10 and 30 minutes there, so the typical time is 20.
	for _, c := range []struct {
		title    string
		from, to int
	}{{"fast", 100, 90}, {"slow", 100, 70}} {
		id := pipelineIssue(t, c.title, "todo", wf)
		stageEvent(t, id, "build", "entered", c.from)
		stageEvent(t, id, "build", "left", c.to)
	}

	got := getPipeline(t, created.Workflow.ID)

	var item WorkflowPipelineIssue
	for _, i := range got.Stages[0].Issues {
		if i.ID == current {
			item = i
		}
	}
	if item.StageEnteredAt == nil || item.RunStartedAt == nil || *item.StageEnteredAt != *item.RunStartedAt {
		t.Errorf("an issue that has been in its first stage since it began: %+v", item)
	}
	stage := got.Stages[0]
	if stage.ID != "build" || stage.TypicalSeconds == nil || *stage.TypicalSeconds != 20*60 || stage.TypicalSamples != 2 {
		t.Errorf("typical time of build = %+v (%d samples)", stage.TypicalSeconds, stage.TypicalSamples)
	}
	// One finished stay is not enough to call anything typical.
	if got.Stages[1].TypicalSeconds != nil {
		t.Errorf("review has no finished stays: %+v", got.Stages[1])
	}
}

func TestWorkflowInsightsSummariseRunsAndRefuseABadWindow(t *testing.T) {
	enableWorkflows(t)
	created := timingWorkflow(t)
	wf := pipelineLabel(t, "wf:"+created.Workflow.Key)
	issue := pipelineIssue(t, "finished", "done", wf)
	stageEvent(t, issue, "build", "entered", 60)
	stageEvent(t, issue, "build", "left", 40)
	stageEvent(t, issue, "review", "entered", 40)
	stageEvent(t, issue, "review", "left", 29)
	stageEvent(t, issue, "done", "entered", 29)
	agentRun(t, "builder", issue, 59, 41)
	memberCommentAgo(t, issue, 30)
	// An older run, outside a one-day window.
	old := pipelineIssue(t, "old", "done", wf)
	dbfx.Exec(t, `INSERT INTO workflow_stage_event (workspace_id, issue_id, stage_id, kind, occurred_at)
		VALUES ($1, $2, 'build', 'entered', now() - interval '10 days')`, testWorkspaceID, old)

	call := func(query string) *testutil.Response {
		req := withURLParam(newRequest("GET", "/x"+query, nil), "id", created.Workflow.ID)
		return testutil.Call(t, testHandler.WorkflowInsights, req)
	}
	var got WorkflowInsightsResponse
	call("?days=1").Want(http.StatusOK).JSON(&got)

	if got.Runs != 1 || got.Finished != 1 || got.Open != 0 || got.Days != 1 {
		t.Fatalf("one finished run in the window: %+v", got)
	}
	if got.BottleneckStageID != "build" || len(got.Stages) < 2 || got.Stages[0].StageID != "build" {
		t.Errorf("stages = %+v, bottleneck %q", got.Stages, got.BottleneckStageID)
	}
	if len(got.Agents) != 1 || got.Agents[0].Agent != "builder" || got.Agents[0].Runs != 1 {
		t.Errorf("agents = %+v", got.Agents)
	}
	if len(got.Approvers) != 1 || got.Approvers[0].Decisions != 1 || got.Approvers[0].Name == "" {
		t.Errorf("approvers = %+v", got.Approvers)
	}
	call("?days=30").Want(http.StatusOK).JSON(&got)
	if got.Runs != 2 {
		t.Errorf("a 30-day window also holds the older run: %d", got.Runs)
	}
	for _, bad := range []string{"?days=0", "?days=9999", "?days=x"} {
		call(bad).Want(http.StatusBadRequest)
	}
}
