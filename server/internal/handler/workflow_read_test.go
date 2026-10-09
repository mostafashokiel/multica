package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/workflow"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The read endpoints are tested against rows seeded straight through the
// queries, so they stand on their own: nothing here depends on a write
// endpoint existing.

func enableWorkflowReads(t *testing.T) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	withFeatureFlag(t, testHandler, featureflags.WorkflowsV1, true)
	t.Cleanup(func() {
		for _, table := range []string{"workflow_audit", "workflow_version", "workflow"} {
			testPool.Exec(context.Background(), `DELETE FROM `+table+` WHERE workspace_id = $1`, testWorkspaceID)
		}
	})
}

var readKeyCounter atomic.Int64

func readKey() string { return fmt.Sprintf("wf-read-%d", readKeyCounter.Add(1)) }

const readTestDefinition = `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: KEY
  version: 1
approvers:
  qa: [user:u1]
start: build
stages:
  - id: build
    type: agent
    agent: builder
    next: review
  - id: review
    type: human_gate
    approvers: qa
    on_approve: done
    on_reject: build
    max_rework: 2
  - id: done
    type: end
`

// seedWorkflow stores a workflow in the default workspace with one version per
// definition, each written the way the write path will: canonical text, its
// hash, the version number stamped in.
func seedWorkflow(t *testing.T, key string, definitions ...string) db.Workflow {
	t.Helper()
	ctx := context.Background()
	user := parseUUID(testUserID)
	ws := parseUUID(testWorkspaceID)
	wf, err := testHandler.Queries.CreateWorkflow(ctx, db.CreateWorkflowParams{
		WorkspaceID: ws, Key: key, Name: key, Description: "seeded", CreatedByType: "member", CreatedByID: user,
	})
	if err != nil {
		t.Fatalf("CreateWorkflow: %v", err)
	}
	for i, source := range definitions {
		def, issues := workflow.Parse([]byte(source))
		if len(issues) > 0 {
			t.Fatalf("seed definition %d: %+v", i, issues)
		}
		def.Metadata.Version = i + 1
		canonical, err := workflow.Marshal(def)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := testHandler.Queries.InsertWorkflowVersion(ctx, db.InsertWorkflowVersionParams{
			WorkspaceID: ws, WorkflowID: wf.ID, Version: int32(i + 1), Definition: string(canonical),
			ContentHash: workflow.ContentHash(canonical), Layout: []byte(`{"build":{"x":10,"y":20}}`),
			Note: fmt.Sprintf("note %d", i+1), CreatedByType: "member", CreatedByID: user,
		}); err != nil {
			t.Fatalf("InsertWorkflowVersion: %v", err)
		}
		if wf, err = testHandler.Queries.SetWorkflowLatestVersion(ctx, db.SetWorkflowLatestVersionParams{
			ID: wf.ID, WorkspaceID: ws, LatestVersion: int32(i + 1),
		}); err != nil {
			t.Fatal(err)
		}
		action := "create"
		if i > 0 {
			action = "save"
		}
		if err := testHandler.Queries.InsertWorkflowAudit(ctx, db.InsertWorkflowAuditParams{
			WorkspaceID: ws, WorkflowID: wf.ID, Version: pgtype.Int4{Int32: int32(i + 1), Valid: true},
			Action: action, ActorType: "member", ActorID: user, Detail: []byte(`{}`),
		}); err != nil {
			t.Fatal(err)
		}
	}
	return wf
}

func readDefinition(key string) string { return strings.ReplaceAll(readTestDefinition, "KEY", key) }

func TestWorkflowReadsAreOffByDefault(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	id := "00000000-0000-0000-0000-000000000000"
	cases := map[string]http.HandlerFunc{
		"list":     testHandler.ListWorkflows,
		"validate": testHandler.ValidateWorkflowDefinition,
		"get":      testHandler.GetWorkflow,
		"versions": testHandler.ListWorkflowVersions,
		"version":  testHandler.GetWorkflowVersion,
		"audit":    testHandler.ListWorkflowAudit,
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			w := testutil.Call(t, h, withURLParams(newRequest("GET", "/x", nil), "id", id, "version", "1")).Want(http.StatusForbidden)
			if !strings.Contains(w.Body.String(), "workflows_disabled") {
				t.Errorf("want the workflows_disabled code, got %s", w.Body.String())
			}
		})
	}
}

func TestListWorkflowsHidesArchivedUnlessAsked(t *testing.T) {
	enableWorkflowReads(t)
	live := seedWorkflow(t, readKey(), readDefinition("a"))
	gone := seedWorkflow(t, readKey(), readDefinition("b"))
	if _, err := testPool.Exec(context.Background(), `UPDATE workflow SET status = 'archived' WHERE id = $1`, gone.ID); err != nil {
		t.Fatal(err)
	}

	var out struct {
		Workflows []WorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListWorkflows, newRequest("GET", "/api/workflows", nil)).Want(http.StatusOK).JSON(&out)
	if len(out.Workflows) != 1 || out.Workflows[0].ID != uuidToString(live.ID) || out.Workflows[0].Status != "active" {
		t.Fatalf("default list = %+v", out.Workflows)
	}
	testutil.Call(t, testHandler.ListWorkflows, newRequest("GET", "/api/workflows?include_archived=true", nil)).Want(http.StatusOK).JSON(&out)
	if len(out.Workflows) != 2 {
		t.Fatalf("include_archived list has %d entries, want 2", len(out.Workflows))
	}
}

func TestGetWorkflowReturnsTheHeadWithItsNewestVersion(t *testing.T) {
	enableWorkflowReads(t)
	key := readKey()
	wf := seedWorkflow(t, key, readDefinition(key), readDefinition(key))
	id := uuidToString(wf.ID)

	var out workflowWithVersionResponse
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusOK).JSON(&out)

	if out.Workflow.Key != key || out.Workflow.LatestVersion != 2 {
		t.Fatalf("head = %+v", out.Workflow)
	}
	v := out.Version
	if v == nil || v.Version != 2 || v.Definition == nil || !strings.Contains(*v.Definition, "version: 2") {
		t.Fatalf("newest version = %+v", v)
	}
	if string(v.Layout) != `{"build":{"x":10,"y":20}}` {
		t.Errorf("layout = %s", v.Layout)
	}
	if len(v.Issues) != 0 {
		t.Errorf("a valid definition reported issues: %+v", v.Issues)
	}
}

func TestGetWorkflowReportsTheProblemsOfAVersionWithProblems(t *testing.T) {
	enableWorkflowReads(t)
	key := readKey()
	broken := strings.Replace(readDefinition(key), "on_approve: done", "on_approve: nowhere", 1)
	wf := seedWorkflow(t, key, broken)

	var out workflowWithVersionResponse
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", uuidToString(wf.ID))).
		Want(http.StatusOK).JSON(&out)
	if out.Version == nil || len(out.Version.Issues) == 0 || out.Version.Issues[0].Code != "V002" {
		t.Fatalf("want the V002 problem, got %+v", out.Version)
	}
}

func TestGetWorkflowWithNoVersionHasNoVersion(t *testing.T) {
	enableWorkflowReads(t)
	wf := seedWorkflow(t, readKey())
	var out workflowWithVersionResponse
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", uuidToString(wf.ID))).
		Want(http.StatusOK).JSON(&out)
	if out.Version != nil || out.Workflow.LatestVersion != 0 {
		t.Errorf("got %+v", out)
	}
}

func TestVersionHistoryIsNewestFirstAndLeavesOutTheBodies(t *testing.T) {
	enableWorkflowReads(t)
	key := readKey()
	wf := seedWorkflow(t, key, readDefinition(key), readDefinition(key), readDefinition(key))
	id := uuidToString(wf.ID)

	var list struct {
		Versions []WorkflowVersionResponse `json:"versions"`
	}
	testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusOK).JSON(&list)
	if len(list.Versions) != 3 || list.Versions[0].Version != 3 || list.Versions[2].Version != 1 {
		t.Fatalf("versions = %+v", list.Versions)
	}
	for _, v := range list.Versions {
		if v.Definition != nil || len(v.Layout) != 0 || len(v.Issues) != 0 {
			t.Errorf("the history list must leave out the bodies: %+v", v)
		}
		if v.Note == "" || v.ContentHash == "" {
			t.Errorf("summary lost its note or hash: %+v", v)
		}
	}

	var one WorkflowVersionResponse
	testutil.Call(t, testHandler.GetWorkflowVersion, withURLParams(newRequest("GET", "/x", nil), "id", id, "version", "2")).Want(http.StatusOK).JSON(&one)
	if one.Version != 2 || one.Definition == nil || !strings.Contains(*one.Definition, "version: 2") {
		t.Errorf("version 2 = %+v", one)
	}
	for _, bad := range []string{"0", "-1", "abc", "9", "99999999999"} {
		testutil.Call(t, testHandler.GetWorkflowVersion, withURLParams(newRequest("GET", "/x", nil), "id", id, "version", bad)).
			Want(http.StatusNotFound)
	}
}

func TestAuditTrailIsNewestFirst(t *testing.T) {
	enableWorkflowReads(t)
	key := readKey()
	wf := seedWorkflow(t, key, readDefinition(key), readDefinition(key))

	var out struct {
		Audit []struct {
			Action  string `json:"action"`
			Version *int32 `json:"version"`
		} `json:"audit"`
	}
	testutil.Call(t, testHandler.ListWorkflowAudit, withURLParam(newRequest("GET", "/x", nil), "id", uuidToString(wf.ID))).
		Want(http.StatusOK).JSON(&out)
	if len(out.Audit) != 2 || out.Audit[0].Action != "save" || *out.Audit[0].Version != 2 || out.Audit[1].Action != "create" {
		t.Fatalf("audit = %+v", out.Audit)
	}
}

func TestAnyMemberMayReadButOnlyInTheirOwnWorkspace(t *testing.T) {
	enableWorkflowReads(t)
	key := readKey()
	wf := seedWorkflow(t, key, readDefinition(key))
	id := uuidToString(wf.ID)

	member := dbfx.User(t, "WF Read Member", "wf-read-member@example.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	testutil.Call(t, testHandler.ListWorkflows, newRequestAs(member, "GET", "/api/workflows", nil)).Want(http.StatusOK)
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequestAs(member, "GET", "/x", nil), "id", id)).Want(http.StatusOK)

	// A user who is not in the workspace gets nothing from it.
	outsider := dbfx.User(t, "WF Read Outsider", "wf-read-outsider@example.test")
	testutil.Call(t, testHandler.ListWorkflows, newRequestAs(outsider, "GET", "/api/workflows", nil)).Want(http.StatusNotFound)

	// An owner of another workspace cannot reach this workspace's rows by id.
	otherWorkspace := dbfx.Workspace(t, "WF Read Other", "wf-read-other-workspace")
	dbfx.Member(t, otherWorkspace, outsider, "owner")
	asOther := func(path string) *http.Request {
		req := newRequestAs(outsider, "GET", path, nil)
		req.Header.Set("X-Workspace-ID", otherWorkspace)
		return req
	}
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(asOther("/x"), "id", id)).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(asOther("/x"), "id", id)).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.GetWorkflowVersion, withURLParams(asOther("/x"), "id", id, "version", "1")).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.ListWorkflowAudit, withURLParam(asOther("/x"), "id", id)).Want(http.StatusNotFound)
	var list struct {
		Workflows []WorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListWorkflows, asOther("/api/workflows")).Want(http.StatusOK).JSON(&list)
	if len(list.Workflows) != 0 {
		t.Errorf("another workspace sees %d workflows", len(list.Workflows))
	}
}

func TestWorkflowIdsMustBeUUIDs(t *testing.T) {
	enableWorkflowReads(t)
	for _, bad := range []string{"not-a-uuid", "' OR 1=1 --", ""} {
		testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", bad)).Want(http.StatusBadRequest)
		testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(newRequest("GET", "/x", nil), "id", bad)).Want(http.StatusBadRequest)
	}
	// A well-formed id that belongs to nothing is a plain 404.
	testutil.Call(t, testHandler.GetWorkflow,
		withURLParam(newRequest("GET", "/x", nil), "id", "00000000-0000-0000-0000-000000000000")).Want(http.StatusNotFound)
}

func TestValidateEndpointJudgesWithoutSaving(t *testing.T) {
	enableWorkflowReads(t)
	call := func(def string) map[string]any {
		var out map[string]any
		testutil.Call(t, testHandler.ValidateWorkflowDefinition, newRequest("POST", "/api/workflows/validate", map[string]any{"definition": def})).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	if r := call(readDefinition("ok")); r["parsed"] != true || r["valid"] != true {
		t.Errorf("valid: %v", r)
	} else if issues, ok := r["issues"].([]any); !ok || len(issues) != 0 {
		// An array, not null: the client reads it as one.
		t.Errorf("a valid definition has an empty issues list, got %#v", r["issues"])
	}
	r := call(strings.Replace(readDefinition("ok"), "on_approve: done", "on_approve: nowhere", 1))
	if r["parsed"] != true || r["valid"] != false || !strings.Contains(fmt.Sprint(r["issues"]), "V002") {
		t.Errorf("problems: %v", r)
	}
	if r := call("kind: ["); r["parsed"] != false || r["valid"] != false {
		t.Errorf("unreadable: %v", r)
	} else if _, has := r["canonical"]; has {
		t.Errorf("unreadable text has no canonical form: %v", r)
	}

	// A parseable definition comes back in the canonical form a save would store,
	// problems or not.
	ok := call(readDefinition("ok"))
	def, issues := workflow.Parse([]byte(readDefinition("ok")))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	want, _ := workflow.Marshal(def)
	if ok["canonical"] != string(want) {
		t.Errorf("canonical = %q, want %q", ok["canonical"], want)
	}
	if broken := call(strings.Replace(readDefinition("ok"), "on_approve: done", "on_approve: nowhere", 1)); broken["canonical"] == nil || broken["canonical"] == "" {
		t.Errorf("a definition with problems still has a canonical form: %v", broken)
	}

	// A body that is not JSON, and one over the size limit, are refused.
	testutil.Call(t, testHandler.ValidateWorkflowDefinition, newRequest("POST", "/x", "not an object")).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.ValidateWorkflowDefinition,
		newRequest("POST", "/x", map[string]any{"definition": strings.Repeat("x", maxWorkflowRequestBytes)})).Want(http.StatusBadRequest)

	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM workflow WHERE workspace_id = $1`, testWorkspaceID).Scan(&n)
	if n != 0 {
		t.Error("validate created a workflow")
	}
}
