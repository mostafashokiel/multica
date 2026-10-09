package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/workflow"
)

func applyReq(t *testing.T, id string, body map[string]any) *http.Request {
	t.Helper()
	return withURLParam(newRequest("POST", "/api/workflows/"+id+"/apply", body), "id", id)
}

func apply(t *testing.T, id string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, testHandler.ApplyWorkflow, applyReq(t, id, body))
}

func newTestSquad(t *testing.T, name string) SquadResponse {
	t.Helper()
	leader := createHandlerTestAgent(t, name+"-leader", nil)
	return createSquadAs(t, testUserID, name, leader)
}

func squadInstructions(t *testing.T, squadID string) string {
	t.Helper()
	var s string
	if err := testPool.QueryRow(context.Background(), `SELECT instructions FROM squad WHERE id = $1`, squadID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func setSquadInstructions(t *testing.T, squadID, text string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `UPDATE squad SET instructions = $2 WHERE id = $1`, squadID, text); err != nil {
		t.Fatal(err)
	}
}

func countBlocks(s string) int { return strings.Count(s, "<!-- workflow-managed:begin ") }

func TestApplyAndRenderAreOffByDefault(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	id := "00000000-0000-0000-0000-000000000000"
	w := testutil.Call(t, testHandler.ApplyWorkflow, applyReq(t, id, map[string]any{})).Want(http.StatusForbidden)
	if !strings.Contains(w.Body.String(), "workflows_disabled") {
		t.Errorf("apply: want workflows_disabled, got %s", w.Body.String())
	}
	w = testutil.Call(t, testHandler.RenderWorkflow, withURLParam(newRequest("POST", "/x", nil), "id", id)).Want(http.StatusForbidden)
	if !strings.Contains(w.Body.String(), "workflows_disabled") {
		t.Errorf("render: want workflows_disabled, got %s", w.Body.String())
	}
}

func TestRenderPreviewsTheBlockWithoutChangingAnything(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Render Squad")

	var out WorkflowRenderResponse
	testutil.Call(t, testHandler.RenderWorkflow,
		withURLParam(newRequest("POST", "/x", map[string]any{"squad_id": squad.ID}), "id", created.Workflow.ID)).
		Want(http.StatusOK).JSON(&out)

	if out.WorkflowKey != created.Workflow.Key || out.Version != 1 || out.ContentHash != created.Version.ContentHash {
		t.Fatalf("unexpected render: %+v", out)
	}
	if out.SquadName != "Render Squad" || !strings.Contains(out.Instructions, "You lead squad `Render Squad`") {
		t.Errorf("the briefing should name the chosen squad: %s", out.Instructions)
	}
	if b, _, _, found, err := workflow.FindBlock(out.Instructions); err != nil || !found || b.Workflow != created.Workflow.Key {
		t.Errorf("render output is not a managed block: %+v found=%v err=%v", b, found, err)
	}
	if want := "wf:" + created.Workflow.Key; len(out.Labels) == 0 || out.Labels[0] != want {
		t.Errorf("labels should start with %q: %v", want, out.Labels)
	}
	if got := squadInstructions(t, squad.ID); got != "" {
		t.Errorf("render must not write to the squad, got %q", got)
	}

	// Without a squad it falls back to a neutral name.
	testutil.Call(t, testHandler.RenderWorkflow, withURLParam(newRequest("POST", "/x", nil), "id", created.Workflow.ID)).
		Want(http.StatusOK).JSON(&out)
	if out.SquadName != workflowSquadFallbackName {
		t.Errorf("squad name = %q", out.SquadName)
	}

	// Any member can preview.
	member := dbfx.User(t, "WF Render Member", "wf-render-member@example.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	testutil.Call(t, testHandler.RenderWorkflow,
		withURLParam(newRequestAs(member, "POST", "/x", map[string]any{}), "id", created.Workflow.ID)).Want(http.StatusOK)
}

func TestApplyWritesTheBlockKeepsHumanTextAndIsIdempotent(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Apply Squad")
	setSquadInstructions(t, squad.ID, "Always be polite.\n")

	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if !resp.Applied || resp.Version != 1 || resp.SquadID != squad.ID || resp.WorkflowKey != created.Workflow.Key {
		t.Fatalf("unexpected apply response: %+v", resp)
	}
	first := squadInstructions(t, squad.ID)
	if !strings.HasPrefix(first, "Always be polite.\n\n<!-- workflow-managed:begin ") {
		t.Fatalf("human text should come first, then the block:\n%s", first)
	}
	if !strings.Contains(first, "You lead squad `Apply Squad`") {
		t.Errorf("the briefing should name the real squad:\n%s", first)
	}
	block, _, _, found, err := workflow.FindBlock(first)
	if err != nil || !found || block.Version != 1 || block.SHA256 != created.Version.ContentHash {
		t.Fatalf("block = %+v found=%v err=%v", block, found, err)
	}

	// Applying the same version again changes nothing and says so.
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if resp.Applied {
		t.Error("a repeat apply should report applied=false")
	}
	if again := squadInstructions(t, squad.ID); again != first {
		t.Errorf("a repeat apply changed the instructions:\n%s", again)
	}

	// A new version replaces the block in place; text around it survives.
	setSquadInstructions(t, squad.ID, "Intro.\n\n"+strings.TrimPrefix(first, "Always be polite.\n\n")+"\n\nOutro.\n")
	saveWorkflowVersion(t, created.Workflow.ID, map[string]any{
		"definition": workflowYAML(created.Workflow.Key, "now with a description"), "base_version": 1,
	}).Want(http.StatusCreated)
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if !resp.Applied || resp.Version != 2 {
		t.Fatalf("expected version 2 applied: %+v", resp)
	}
	second := squadInstructions(t, squad.ID)
	if !strings.HasPrefix(second, "Intro.\n\n<!-- workflow-managed:begin ") || !strings.HasSuffix(second, "\n\nOutro.\n") {
		t.Errorf("text around the block was not preserved:\n%s", second)
	}
	if countBlocks(second) != 1 || !strings.Contains(second, "version=2") || !strings.Contains(second, "now with a description") {
		t.Errorf("expected exactly one block, at version 2:\n%s", second)
	}

	// An older version can be applied explicitly.
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID, "version": 1}).Want(http.StatusOK).JSON(&resp)
	if !resp.Applied || resp.Version != 1 || !strings.Contains(squadInstructions(t, squad.ID), "version=1") {
		t.Errorf("applying version 1 explicitly failed: %+v", resp)
	}

	var applies int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM workflow_audit WHERE workflow_id = $1 AND action = 'apply'`, created.Workflow.ID).Scan(&applies); err != nil {
		t.Fatal(err)
	}
	if applies != 3 {
		t.Errorf("want 3 apply audit rows (the repeat wrote nothing), got %d", applies)
	}
}

func TestApplyRefusesToSwitchWorkflowsWithoutReplace(t *testing.T) {
	enableWorkflows(t)
	first := createWorkflowFor(t, freshWorkflowKey())
	second := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Switch Squad")

	apply(t, first.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK)
	before := squadInstructions(t, squad.ID)

	w := apply(t, second.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusConflict)
	if !strings.Contains(w.Body.String(), workflowErrSquadHasWorkflow) || !strings.Contains(w.Body.String(), first.Workflow.Key) {
		t.Errorf("want squad_has_workflow naming %q, got %s", first.Workflow.Key, w.Body.String())
	}
	if squadInstructions(t, squad.ID) != before {
		t.Error("a refused apply must not touch the squad")
	}

	var resp WorkflowApplyResponse
	apply(t, second.Workflow.ID, map[string]any{"squad_id": squad.ID, "replace": true}).Want(http.StatusOK).JSON(&resp)
	if resp.Replaced != first.Workflow.Key {
		t.Errorf("replaced = %q", resp.Replaced)
	}
	after := squadInstructions(t, squad.ID)
	if countBlocks(after) != 1 || !strings.Contains(after, "workflow="+second.Workflow.Key) || strings.Contains(after, "workflow="+first.Workflow.Key+" ") {
		t.Errorf("the second workflow should have replaced the first:\n%s", after)
	}
}

func TestApplyNeverGuessesAroundAHalfEditedBlock(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Broken Block Squad")
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK)

	broken := strings.Replace(squadInstructions(t, squad.ID), "<!-- workflow-managed:end", "<!-- somebody removed this", 1)
	broken = "Notes I wrote.\n" + broken
	setSquadInstructions(t, squad.ID, broken)

	w := apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID, "replace": true}).Want(http.StatusConflict)
	if !strings.Contains(w.Body.String(), workflowErrBlockInvalid) {
		t.Errorf("want managed_block_invalid, got %s", w.Body.String())
	}
	if squadInstructions(t, squad.ID) != broken {
		t.Error("the squad's text must be left exactly as it was")
	}
}

func TestApplyRejections(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Reject Squad")
	id := created.Workflow.ID

	// Bad input.
	apply(t, id, map[string]any{}).Want(http.StatusBadRequest)
	apply(t, id, map[string]any{"squad_id": "not-a-uuid"}).Want(http.StatusBadRequest)
	apply(t, id, map[string]any{"squad_id": squad.ID, "version": -1}).Want(http.StatusBadRequest)
	apply(t, id, map[string]any{"squad_id": "00000000-0000-0000-0000-000000000000"}).Want(http.StatusNotFound)
	apply(t, id, map[string]any{"squad_id": squad.ID, "version": 99}).Want(http.StatusNotFound)
	apply(t, "00000000-0000-0000-0000-000000000000", map[string]any{"squad_id": squad.ID}).Want(http.StatusNotFound)

	// A version with problems is saved, but cannot be applied.
	bad := strings.Replace(workflowYAML(created.Workflow.Key, ""), "stages:\n", "stages:\n  - id: orphan\n    type: end\n", 1)
	saveWorkflowVersion(t, id, map[string]any{"definition": bad, "base_version": 1}).Want(http.StatusCreated)
	w := apply(t, id, map[string]any{"squad_id": squad.ID}).Want(http.StatusBadRequest)
	if !strings.Contains(w.Body.String(), "invalid_definition") || !strings.Contains(w.Body.String(), "V003") {
		t.Errorf("want the validation problems, got %s", w.Body.String())
	}
	if got := squadInstructions(t, squad.ID); got != "" {
		t.Errorf("nothing may be written for an invalid version, got %q", got)
	}
	// Version 1 is still fine.
	apply(t, id, map[string]any{"squad_id": squad.ID, "version": 1}).Want(http.StatusOK)

	// Archived squad.
	archived := newTestSquad(t, "Archived Squad")
	if _, err := testPool.Exec(context.Background(), `UPDATE squad SET archived_at = now() WHERE id = $1`, archived.ID); err != nil {
		t.Fatal(err)
	}
	apply(t, id, map[string]any{"squad_id": archived.ID, "version": 1}).Want(http.StatusConflict)

	// Archived workflow.
	other := createWorkflowFor(t, freshWorkflowKey())
	testutil.Call(t, testHandler.UpdateWorkflow, withURLParam(newRequest("PATCH", "/x",
		map[string]any{"status": "archived", "revision": other.Workflow.Revision}), "id", other.Workflow.ID)).Want(http.StatusOK)
	apply(t, other.Workflow.ID, map[string]any{"squad_id": squad.ID, "replace": true}).Want(http.StatusConflict)
}

func TestOnlyHumanOwnersAndAdminsMayApply(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Guarded Squad")
	body := map[string]any{"squad_id": squad.ID}

	member := dbfx.User(t, "WF Apply Member", "wf-apply-member@example.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	testutil.Call(t, testHandler.ApplyWorkflow,
		withURLParam(newRequestAs(member, "POST", "/x", body), "id", created.Workflow.ID)).Want(http.StatusForbidden)

	// The creator of a squad may manage it, but applying a workflow is a
	// workflow-management act: a plain member who owns the squad still cannot.
	owned := createSquadAs(t, member, "Member Owned Workflow Squad", createHandlerTestAgent(t, "wf-member-leader", nil))
	testutil.Call(t, testHandler.ApplyWorkflow,
		withURLParam(newRequestAs(member, "POST", "/x", map[string]any{"squad_id": owned.ID}), "id", created.Workflow.ID)).
		Want(http.StatusForbidden)

	req := applyReq(t, created.Workflow.ID, body)
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-0000000000aa")
	testutil.Call(t, testHandler.ApplyWorkflow, req).Want(http.StatusForbidden)

	admin := dbfx.User(t, "WF Apply Admin", "wf-apply-admin@example.test")
	dbfx.Member(t, testWorkspaceID, admin, "admin")
	testutil.Call(t, testHandler.ApplyWorkflow,
		withURLParam(newRequestAs(admin, "POST", "/x", body), "id", created.Workflow.ID)).Want(http.StatusOK)

	if got := squadInstructions(t, owned.ID); got != "" {
		t.Errorf("a refused apply wrote %q", got)
	}
}

func TestApplyCannotReachAnotherWorkspacesSquadOrWorkflow(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Local Squad")

	otherUser := dbfx.User(t, "WF Apply Other", "wf-apply-other@example.test")
	otherWorkspace := dbfx.Workspace(t, "WF Apply Other WS", "wf-apply-other-ws")
	dbfx.Member(t, otherWorkspace, otherUser, "owner")
	t.Cleanup(func() {
		for _, table := range []string{"workflow_audit", "workflow_version", "workflow"} {
			testPool.Exec(context.Background(), `DELETE FROM `+table+` WHERE workspace_id = $1`, otherWorkspace)
		}
	})
	asOther := func(body map[string]any, id string) *http.Request {
		req := newRequestAs(otherUser, "POST", "/x", body)
		req.Header.Set("X-Workspace-ID", otherWorkspace)
		return withURLParam(req, "id", id)
	}

	// Our workflow, their workspace: the workflow does not exist for them.
	testutil.Call(t, testHandler.ApplyWorkflow, asOther(map[string]any{"squad_id": squad.ID}, created.Workflow.ID)).Want(http.StatusNotFound)

	// Their workflow, our squad: the squad does not exist for them.
	var theirs workflowCreated
	req := newRequestAs(otherUser, "POST", "/api/workflows", map[string]any{"definition": workflowYAML(freshWorkflowKey(), "")})
	req.Header.Set("X-Workspace-ID", otherWorkspace)
	testutil.Call(t, testHandler.CreateWorkflow, req).Want(http.StatusCreated).JSON(&theirs)
	testutil.Call(t, testHandler.ApplyWorkflow, asOther(map[string]any{"squad_id": squad.ID}, theirs.Workflow.ID)).Want(http.StatusNotFound)

	if got := squadInstructions(t, squad.ID); got != "" {
		t.Errorf("a cross-workspace apply wrote %q", got)
	}
}

// Applying is a read-modify-write of the squad's text. Parallel applies of
// different versions must leave exactly one well-formed block, never two or a
// torn one.
func TestConcurrentAppliesLeaveOneWellFormedBlock(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	saveWorkflowVersion(t, created.Workflow.ID, map[string]any{
		"definition": workflowYAML(created.Workflow.Key, "second"), "base_version": 1,
	}).Want(http.StatusCreated)
	squad := newTestSquad(t, "Racing Squad")
	setSquadInstructions(t, squad.ID, "Keep me.\n")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			testHandler.ApplyWorkflow(rec, applyReq(t, created.Workflow.ID,
				map[string]any{"squad_id": squad.ID, "version": 1 + i%2}))
			if rec.Code != http.StatusOK {
				t.Errorf("apply %d: %d %s", i, rec.Code, rec.Body.String())
			}
		}(i)
	}
	wg.Wait()

	final := squadInstructions(t, squad.ID)
	if countBlocks(final) != 1 || strings.Count(final, "<!-- workflow-managed:end ") != 1 || !strings.HasPrefix(final, "Keep me.\n\n") {
		t.Fatalf("expected one block after the human text, got:\n%s", final)
	}
	if _, _, _, found, err := workflow.FindBlock(final); !found || err != nil {
		t.Fatalf("the final block does not parse: found=%v err=%v", found, err)
	}
}

func TestApplyResponseCarriesTheLabelsToCreate(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	squad := newTestSquad(t, "Labels Squad")

	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	want := []string{
		"wf:" + created.Workflow.Key, "phase:build", "phase:review", "phase:done",
	}
	if fmt.Sprint(resp.Labels) != fmt.Sprint(want) {
		t.Errorf("labels = %v\nwant     %v", resp.Labels, want)
	}
	raw, _ := json.Marshal(resp)
	if !strings.Contains(string(raw), `"applied":true`) {
		t.Errorf("unexpected JSON: %s", raw)
	}
}

// membersYAML is build (agent) -> review (gate) -> done, with the named agent and approvers.
func membersYAML(key, agent string, approvers ...string) string {
	return strings.NewReplacer("builder", agent, "[user:u1]", "["+strings.Join(approvers, ", ")+"]").
		Replace(workflowYAML(key, ""))
}

func createWorkflowWith(t *testing.T, definition string) workflowCreated {
	t.Helper()
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": definition,
	})).Want(http.StatusCreated).JSON(&out)
	return out
}

func squadHas(t *testing.T, squadID, memberType, memberID string) (role string, found bool) {
	t.Helper()
	err := testPool.QueryRow(context.Background(),
		`SELECT role FROM squad_member WHERE squad_id = $1 AND member_type = $2 AND member_id = $3`,
		squadID, memberType, memberID).Scan(&role)
	return role, err == nil
}

func membersByRef(ms []WorkflowMemberResponse) map[string]WorkflowMemberResponse {
	out := map[string]WorkflowMemberResponse{}
	for _, m := range ms {
		out[m.Ref] = m
	}
	return out
}

func TestApplyAddsTheNamedAgentsAndApproversToTheSquad(t *testing.T) {
	enableWorkflows(t)
	agentName := fmt.Sprintf("wf-members-agent-%d", workflowKeyCounter.Add(1))
	agentID := createHandlerTestAgent(t, agentName, nil)
	person := dbfx.User(t, "WF Approver", fmt.Sprintf("wf-approver-%d@example.test", workflowKeyCounter.Add(1)))
	dbfx.Member(t, testWorkspaceID, person, "member")
	stranger := dbfx.User(t, "WF Stranger", fmt.Sprintf("wf-stranger-%d@example.test", workflowKeyCounter.Add(1)))

	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), agentName,
		"user:"+person, "user:"+stranger, "user:<multica-user-id>"))
	squad := newTestSquad(t, "Members Squad")

	// The preview says what apply will do and writes nothing.
	var preview WorkflowRenderResponse
	testutil.Call(t, testHandler.RenderWorkflow,
		withURLParam(newRequest("POST", "/x", map[string]any{"squad_id": squad.ID}), "id", created.Workflow.ID)).
		Want(http.StatusOK).JSON(&preview)
	got := membersByRef(preview.Members)
	if len(preview.Members) != 4 || got[agentName].Status != "add" || got["user:"+person].Status != "add" ||
		got["user:"+stranger].Status != "unresolved" || got["user:<multica-user-id>"].Status != "unresolved" {
		t.Fatalf("unexpected preview: %+v", preview.Members)
	}
	if got[agentName].Kind != "agent" || got["user:"+person].Kind != "person" || got["user:"+person].Name != "WF Approver" {
		t.Errorf("kind and name should be filled in: %+v", got)
	}
	if _, found := squadHas(t, squad.ID, "agent", agentID); found {
		t.Fatal("render must not add anyone")
	}

	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	got = membersByRef(resp.Members)
	if got[agentName].Status != "added" || got["user:"+person].Status != "added" ||
		got["user:"+stranger].Status != "unresolved" || got["user:<multica-user-id>"].Status != "unresolved" {
		t.Fatalf("unexpected apply result: %+v", resp.Members)
	}
	if role, found := squadHas(t, squad.ID, "agent", agentID); !found || role != "" {
		t.Errorf("the agent should be a roleless member: found=%v role=%q", found, role)
	}
	if role, found := squadHas(t, squad.ID, "member", person); !found || role != "approver" {
		t.Errorf("the approver should be a member with role approver: found=%v role=%q", found, role)
	}
	if _, found := squadHas(t, squad.ID, "member", stranger); found {
		t.Error("someone who is not in the workspace must not be added")
	}

	// Again: nothing to add and the briefing is the same, so nothing changes.
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if resp.Applied || membersByRef(resp.Members)[agentName].Status != "present" {
		t.Fatalf("second apply should change nothing: %+v", resp)
	}
	var audits int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM workflow_audit WHERE workflow_id = $1 AND action = 'apply'`, created.Workflow.ID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Errorf("an apply that changes nothing writes no audit row, got %d", audits)
	}
}

func TestApplyAgainAddsMembersRegisteredLater(t *testing.T) {
	enableWorkflows(t)
	agentName := fmt.Sprintf("wf-late-agent-%d", workflowKeyCounter.Add(1))
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), agentName, "user:u1"))
	squad := newTestSquad(t, "Late Squad")

	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if !resp.Applied || membersByRef(resp.Members)[agentName].Status != "unresolved" {
		t.Fatalf("the agent does not exist yet: %+v", resp)
	}
	briefing := squadInstructions(t, squad.ID)

	agentID := createHandlerTestAgent(t, agentName, nil)
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if resp.Applied {
		t.Error("the briefing did not change")
	}
	if membersByRef(resp.Members)[agentName].Status != "added" {
		t.Fatalf("the agent registered since should be added: %+v", resp.Members)
	}
	if _, found := squadHas(t, squad.ID, "agent", agentID); !found {
		t.Error("the agent is not a squad member")
	}
	if squadInstructions(t, squad.ID) != briefing {
		t.Error("adding members must not touch the instructions")
	}
}

func TestApplyDoesNotAddAnArchivedAgent(t *testing.T) {
	enableWorkflows(t)
	agentName := fmt.Sprintf("wf-archived-agent-%d", workflowKeyCounter.Add(1))
	agentID := createHandlerTestAgent(t, agentName, nil)
	if _, err := testPool.Exec(context.Background(), `UPDATE agent SET archived_at = now() WHERE id = $1`, agentID); err != nil {
		t.Fatal(err)
	}
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), agentName, "user:u1"))
	squad := newTestSquad(t, "Archived Agent Squad")

	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if membersByRef(resp.Members)[agentName].Status != "unresolved" {
		t.Fatalf("an archived agent is not added: %+v", resp.Members)
	}
	if _, found := squadHas(t, squad.ID, "agent", agentID); found {
		t.Error("an archived agent must not become a squad member")
	}
}

func TestApplyNamesTheApproversInTheBriefing(t *testing.T) {
	enableWorkflows(t)
	first := dbfx.User(t, "WF First Approver", fmt.Sprintf("wf-first-%d@example.test", workflowKeyCounter.Add(1)))
	dbfx.Member(t, testWorkspaceID, first, "member")
	second := dbfx.User(t, "WF Second Approver", fmt.Sprintf("wf-second-%d@example.test", workflowKeyCounter.Add(1)))
	dbfx.Member(t, testWorkspaceID, second, "member")
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), "builder", "user:"+first, "user:"+second))
	squad := newTestSquad(t, "Named Approvers Squad")

	var preview WorkflowRenderResponse
	testutil.Call(t, testHandler.RenderWorkflow,
		withURLParam(newRequest("POST", "/x", map[string]any{"squad_id": squad.ID}), "id", created.Workflow.ID)).
		Want(http.StatusOK).JSON(&preview)
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK)

	for _, text := range []string{preview.Instructions, squadInstructions(t, squad.ID)} {
		for _, want := range []string{
			"WF First Approver (`user:" + first + "`)",
			"WF Second Approver (`user:" + second + "`)",
		} {
			if !strings.Contains(text, want) {
				t.Errorf("briefing lacks %q:\n%s", want, text)
			}
		}
		if strings.Contains(text, "--to-id") || strings.Contains(text, "gate:") {
			t.Error("the briefing neither reassigns the issue nor asks for labels")
		}
	}
}

func TestPreviewSaysWhichApproversCanWakeAPrivateLeader(t *testing.T) {
	enableWorkflows(t)
	approver := dbfx.User(t, "WF Wake Approver", fmt.Sprintf("wf-wake-%d@example.test", workflowKeyCounter.Add(1)))
	dbfx.Member(t, testWorkspaceID, approver, "member")
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), "builder", "user:"+approver, "user:"+testUserID))
	squad := newTestSquad(t, "Wake Squad")

	preview := func() map[string]WorkflowMemberResponse {
		var out WorkflowRenderResponse
		testutil.Call(t, testHandler.RenderWorkflow,
			withURLParam(newRequest("POST", "/x", map[string]any{"squad_id": squad.ID}), "id", created.Workflow.ID)).
			Want(http.StatusOK).JSON(&out)
		return membersByRef(out.Members)
	}
	can := func(m WorkflowMemberResponse) string {
		if m.CanWakeLeader == nil {
			return "unset"
		}
		return fmt.Sprint(*m.CanWakeLeader)
	}

	// A leader the workspace may run is woken by anyone.
	got := preview()
	if can(got["user:"+approver]) != "true" || can(got["user:"+testUserID]) != "true" {
		t.Fatalf("a workspace-wide leader is woken by every approver: %+v", got)
	}

	// Make the leader private to its owner (the test user): only the owner can wake it.
	dbfx.Exec(t, `UPDATE agent SET permission_mode = 'private', visibility = 'private' WHERE id = $1`, squad.LeaderID)
	got = preview()
	if can(got["user:"+approver]) != "false" {
		t.Errorf("another approver cannot wake a private leader: %+v", got["user:"+approver])
	}
	if can(got["user:"+testUserID]) != "true" {
		t.Errorf("the leader's owner always can: %+v", got["user:"+testUserID])
	}
	// Agents carry no such flag.
	if got["builder"].CanWakeLeader != nil {
		t.Errorf("only people have the flag: %+v", got["builder"])
	}

	// Apply reports the same.
	var resp WorkflowApplyResponse
	apply(t, created.Workflow.ID, map[string]any{"squad_id": squad.ID}).Want(http.StatusOK).JSON(&resp)
	if m := membersByRef(resp.Members)["user:"+approver]; can(m) != "false" {
		t.Errorf("apply should say it too: %+v", m)
	}
}

func TestPreviewNamesTheAgentsAnApproverCannotRun(t *testing.T) {
	enableWorkflows(t)
	agentName := fmt.Sprintf("wf-private-agent-%d", workflowKeyCounter.Add(1))
	agentID := createHandlerTestAgent(t, agentName, nil)
	approver := dbfx.User(t, "WF Run Approver", fmt.Sprintf("wf-run-%d@example.test", workflowKeyCounter.Add(1)))
	dbfx.Member(t, testWorkspaceID, approver, "member")
	created := createWorkflowWith(t, membersYAML(freshWorkflowKey(), agentName, "user:"+approver, "user:"+testUserID))
	squad := newTestSquad(t, "Run Squad")

	preview := func() map[string]WorkflowMemberResponse {
		var out WorkflowRenderResponse
		testutil.Call(t, testHandler.RenderWorkflow,
			withURLParam(newRequest("POST", "/x", map[string]any{"squad_id": squad.ID}), "id", created.Workflow.ID)).
			Want(http.StatusOK).JSON(&out)
		return membersByRef(out.Members)
	}

	got := preview()
	if len(got["user:"+approver].CannotRunAgents) != 0 {
		t.Fatalf("a workspace-wide agent can be run by every approver: %+v", got["user:"+approver])
	}

	dbfx.Exec(t, `UPDATE agent SET permission_mode = 'private', visibility = 'private' WHERE id = $1`, agentID)
	got = preview()
	if g := got["user:"+approver].CannotRunAgents; len(g) != 1 || g[0] != agentName {
		t.Errorf("another approver cannot run a private agent: %+v", got["user:"+approver])
	}
	if g := got["user:"+testUserID].CannotRunAgents; len(g) != 0 {
		t.Errorf("the agent's owner can run it: %+v", got["user:"+testUserID])
	}
	if got[agentName].CannotRunAgents != nil {
		t.Errorf("only people carry the list: %+v", got[agentName])
	}
}
