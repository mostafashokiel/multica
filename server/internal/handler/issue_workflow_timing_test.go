package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Timing of project workflows (MUL-7420).

// issueTimingWorkflow is a workflow whose steps an agent builds, an agent reviews and a member signs off,
// used by a fresh project. It returns the workflow, the project and the agent.
func issueTimingWorkflow(t *testing.T) (workflow IssueWorkflowResponse, projectID, agentID string) {
	t.Helper()
	runtimeID := dbfx.Runtime(t, "timing-runtime-"+workflowTestSuffix())
	agentID = dbfx.Agent(t, "timing-agent-"+workflowTestSuffix(), runtimeID)
	workflow = createTestWorkflowSteps(t, "Timing "+workflowTestSuffix(), []map[string]any{
		{"status_key": "backlog"},
		{"status_key": "in_progress", "handler": map[string]any{"type": "agent", "id": agentID}, "instructions": "Build it."},
		{"status_key": "in_review", "handler": map[string]any{"type": "member", "id": testUserID}, "back_status_key": "in_progress"},
		{"status_key": "blocked"},
	})
	projectID = createWorkflowTestProject(t, "Timing project "+workflowTestSuffix())
	dbfx.Exec(t, `UPDATE project SET workflow_id = $1 WHERE id = $2`, workflow.ID, projectID)
	return workflow, projectID, agentID
}

// issueTimedIssue inserts an issue that moved todo -> in_progress -> in_review -> done, with one agent run
// while it was built and one comment from the member who signed it off. build is how long the agent
// took, review how long the sign-off waited for the comment.
func issueTimedIssue(t *testing.T, projectID, agentID string, created time.Time, build, review time.Duration) string {
	t.Helper()
	issueID := dbfx.Issue(t, "Timed "+workflowTestSuffix(), testutil.Cols{
		"project_id": projectID, "status": "done", "created_at": created,
	})
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })

	inReview := created.Add(build + 2*time.Minute)
	done := inReview.Add(review + time.Minute)
	for _, c := range []struct {
		from, to string
		at       time.Time
	}{
		{"todo", "in_progress", created},
		{"in_progress", "in_review", inReview},
		{"in_review", "done", done},
	} {
		details, _ := json.Marshal(map[string]string{"from": c.from, "to": c.to})
		dbfx.Insert(t, "activity_log", testutil.Cols{
			"workspace_id": testWorkspaceID, "issue_id": issueID, "actor_type": "member", "actor_id": testUserID,
			"action": "status_changed", "details": string(details), "created_at": c.at,
		})
	}
	dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issueID, "status": "completed",
		"started_at": created.Add(time.Minute), "completed_at": created.Add(time.Minute + build),
	})
	dbfx.Comment(t, issueID, "Looks good", testutil.Cols{"created_at": inReview.Add(review)})
	return issueID
}

// pinIssueTimingClock fixes the clock the timing endpoints use.
func pinIssueTimingClock(t *testing.T, now time.Time) {
	t.Helper()
	previous := timingNow
	timingNow = func() time.Time { return now }
	t.Cleanup(func() { timingNow = previous })
}

func getIssueWorkflowTimeline(t *testing.T, issueID string) IssueWorkflowTimelineResponse {
	t.Helper()
	req := withURLParam(newRequest("GET", "/api/issues/"+issueID+"/workflow-timeline", nil), "id", issueID)
	var out IssueWorkflowTimelineResponse
	testutil.Call(t, testHandler.GetIssueWorkflowTimeline, req).Want(http.StatusOK).JSON(&out)
	return out
}

func getIssueWorkflowInsights(t *testing.T, workflowID, query string) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest("GET", "/api/issue-workflows/"+workflowID+"/insights?workspace_id="+testWorkspaceID+query, nil), "id", workflowID)
	return testutil.Call(t, testHandler.GetIssueWorkflowInsights, req)
}

func TestIssueWorkflowTimeline(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	pinIssueTimingClock(t, now)
	_, projectID, agentID := issueTimingWorkflow(t)
	created := now.Add(-2 * time.Hour)
	issueID := issueTimedIssue(t, projectID, agentID, created, 28*time.Minute, 30*time.Minute)

	tl := getIssueWorkflowTimeline(t, issueID)
	if tl.Open || tl.EndedAt == nil {
		t.Fatalf("an issue that reached done is finished: %+v", tl)
	}
	// created -> in review is 28 + 2 minutes, then 30 + 1 minutes at the review.
	if tl.ElapsedSeconds != 61*60 {
		t.Errorf("elapsed = %d, want %d", tl.ElapsedSeconds, 61*60)
	}
	if tl.AgentSeconds != 28*60 || tl.PeopleSeconds != 30*60 {
		t.Errorf("agent %d people %d, want %d and %d", tl.AgentSeconds, tl.PeopleSeconds, 28*60, 30*60)
	}
	if tl.AgentSeconds+tl.PeopleSeconds+tl.OtherSeconds != tl.ElapsedSeconds {
		t.Errorf("the parts do not add up to the total: %+v", tl)
	}
	var review *IssueWorkflowVisitResponse
	for i := range tl.Visits {
		if tl.Visits[i].StatusKey == "in_review" {
			review = &tl.Visits[i]
		}
	}
	if review == nil || review.Kind != "person" || review.AnsweredBy != testUserID || review.WaitSeconds != 30*60 || review.Outcome != "passed" {
		t.Fatalf("review visit = %+v", review)
	}
	for _, v := range tl.Visits {
		if v.StatusKey == "in_progress" && (len(v.AgentIDs) != 1 || v.AgentIDs[0] != agentID) {
			t.Errorf("the build visit names its agent: %+v", v)
		}
	}
}

func TestIssueWorkflowTimelineWithoutAProjectIsEmpty(t *testing.T) {
	issueID := dbfx.Issue(t, "No project "+workflowTestSuffix())
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })
	tl := getIssueWorkflowTimeline(t, issueID)
	if len(tl.Visits) != 0 || tl.StartedAt != nil {
		t.Fatalf("an issue outside any project has no run: %+v", tl)
	}
}

func TestIssueWorkflowInsights(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	pinIssueTimingClock(t, now)
	wf, projectID, agentID := issueTimingWorkflow(t)
	issueTimedIssue(t, projectID, agentID, now.Add(-5*time.Hour), 20*time.Minute, 10*time.Minute)
	issueTimedIssue(t, projectID, agentID, now.Add(-3*time.Hour), 40*time.Minute, 50*time.Minute)
	// Outside the window, and in another project: neither counts.
	issueTimedIssue(t, projectID, agentID, now.AddDate(0, 0, -45), time.Minute, time.Minute)
	otherProject := createWorkflowTestProject(t, "Other timing project "+workflowTestSuffix())
	issueTimedIssue(t, otherProject, agentID, now.Add(-4*time.Hour), time.Minute, time.Minute)

	var in IssueWorkflowInsightsResponse
	getIssueWorkflowInsights(t, wf.ID, "&days=30").Want(http.StatusOK).JSON(&in)
	if in.Days != 30 || in.Runs != 2 || in.Finished != 2 || in.Open != 0 || in.Truncated {
		t.Fatalf("insights = %+v", in)
	}
	steps := map[string]IssueWorkflowStepInsightResponse{}
	for _, s := range in.Steps {
		steps[s.StatusKey] = s
	}
	if s := steps["in_review"]; s.Visits != 2 || s.MedianSeconds != (11*60+51*60)/2 || s.Kind != "person" {
		t.Errorf("in_review = %+v", s)
	}
	if in.BottleneckStatusKey != "in_review" && in.BottleneckStatusKey != "in_progress" {
		t.Errorf("bottleneck = %q", in.BottleneckStatusKey)
	}
	if len(in.People) != 1 || in.People[0].UserID != testUserID || in.People[0].Answers != 2 {
		t.Errorf("people = %+v", in.People)
	}
	if len(in.Agents) != 1 || in.Agents[0].AgentID != agentID || in.Agents[0].Visits != 2 {
		t.Errorf("agents = %+v", in.Agents)
	}

	// The wider window takes the old issue in.
	getIssueWorkflowInsights(t, wf.ID, "&days=90").Want(http.StatusOK).JSON(&in)
	if in.Runs != 3 {
		t.Errorf("90 days: runs = %d, want 3", in.Runs)
	}
}

func TestIssueWorkflowInsightsRejectsBadInput(t *testing.T) {
	wf, _, _ := issueTimingWorkflow(t)
	getIssueWorkflowInsights(t, wf.ID, "&days=5").Want(http.StatusBadRequest)
	getIssueWorkflowInsights(t, "00000000-0000-0000-0000-000000000001", "").Want(http.StatusNotFound)
	getIssueWorkflowInsights(t, "not-a-uuid", "").Want(http.StatusBadRequest)

	var in IssueWorkflowInsightsResponse
	getIssueWorkflowInsights(t, wf.ID, "").Want(http.StatusOK).JSON(&in)
	if in.Days != 30 || in.Runs != 0 || in.Steps == nil || in.Agents == nil || in.People == nil {
		t.Errorf("an empty workflow answers with empty lists, not null: %+v", in)
	}
}
