package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/workflow"
)

func enableWorkflows(t *testing.T) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	withFeatureFlag(t, testHandler, featureflags.WorkflowsV1, true)
	t.Cleanup(func() {
		ctx := context.Background()
		for _, table := range []string{"workflow_audit", "workflow_version", "workflow"} {
			testPool.Exec(ctx, `DELETE FROM `+table+` WHERE workspace_id = $1`, testWorkspaceID)
		}
	})
}

var workflowKeyCounter atomic.Int64

func freshWorkflowKey() string { return fmt.Sprintf("wf-test-%d", workflowKeyCounter.Add(1)) }

// workflowYAML is a small valid definition: build -> review gate -> done.
func workflowYAML(key, description string) string {
	desc := ""
	if description != "" {
		desc = "\n  description: " + description
	}
	return `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: ` + key + `
  version: 1` + desc + `
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
}

type workflowCreated struct {
	Workflow WorkflowResponse         `json:"workflow"`
	Version  *WorkflowVersionResponse `json:"version"`
}

func createWorkflowFor(t *testing.T, key string) workflowCreated {
	t.Helper()
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": workflowYAML(key, ""),
	})).Want(http.StatusCreated).JSON(&out)
	return out
}

func saveWorkflowVersion(t *testing.T, id string, body map[string]any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, testHandler.SaveWorkflowVersion,
		withURLParam(newRequest("POST", "/api/workflows/"+id+"/versions", body), "id", id))
}

func TestWorkflowsAreOffByDefault(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cases := map[string]http.HandlerFunc{
		"list":     testHandler.ListWorkflows,
		"create":   testHandler.CreateWorkflow,
		"validate": testHandler.ValidateWorkflowDefinition,
		"get":      testHandler.GetWorkflow,
		"save":     testHandler.SaveWorkflowVersion,
		"update":   testHandler.UpdateWorkflow,
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			w := testutil.Call(t, h, withURLParam(newRequest("POST", "/api/workflows", map[string]any{}), "id", "00000000-0000-0000-0000-000000000000"))
			w.Want(http.StatusForbidden)
			if !strings.Contains(w.Body.String(), "workflows_disabled") {
				t.Errorf("want the workflows_disabled code, got %s", w.Body.String())
			}
		})
	}
}

func TestCreateWorkflowStoresTheCanonicalDefinitionAsVersionOne(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	created := createWorkflowFor(t, key)

	if created.Workflow.Key != key || created.Workflow.LatestVersion != 1 || created.Workflow.Status != "active" {
		t.Fatalf("unexpected workflow: %+v", created.Workflow)
	}
	v := created.Version
	if v == nil || v.Version != 1 || v.Definition == nil {
		t.Fatalf("unexpected version: %+v", v)
	}
	def, issues := workflow.Parse([]byte(*v.Definition))
	if len(issues) > 0 || def.Metadata.Version != 1 {
		t.Fatalf("stored definition does not name version 1: %v %+v", issues, def)
	}
	canonical, _ := workflow.Marshal(def)
	if string(canonical) != *v.Definition || v.ContentHash != workflow.ContentHash(canonical) {
		t.Error("the stored text is not the canonical form, or the hash does not match it")
	}
	if len(v.Issues) != 0 {
		t.Errorf("a valid definition reported issues: %+v", v.Issues)
	}

	var audit struct {
		Audit []struct {
			Action  string `json:"action"`
			Version *int32 `json:"version"`
		} `json:"audit"`
	}
	testutil.Call(t, testHandler.ListWorkflowAudit, withURLParam(newRequest("GET", "/x", nil), "id", created.Workflow.ID)).
		Want(http.StatusOK).JSON(&audit)
	if len(audit.Audit) != 1 || audit.Audit[0].Action != "create" || audit.Audit[0].Version == nil || *audit.Audit[0].Version != 1 {
		t.Errorf("audit: %+v", audit.Audit)
	}
}

// The designer sends no name, so the name comes from the description. A description longer than a
// name may be must shorten it, not make the save fail.
func TestCreateWorkflowNamesItselfFromALongDescription(t *testing.T) {
	enableWorkflows(t)
	long := strings.Repeat("An agent does the work and a person decides. ", 6)
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": workflowYAML(freshWorkflowKey(), long),
	})).Want(http.StatusCreated).JSON(&out)

	if n := len([]rune(out.Workflow.Name)); n > maxWorkflowNameLen || n < maxWorkflowNameLen-10 || !strings.HasSuffix(out.Workflow.Name, "…") {
		t.Fatalf("name = %q (%d characters), want it shortened to about %d ending in an ellipsis", out.Workflow.Name, n, maxWorkflowNameLen)
	}
	if !strings.HasPrefix(out.Workflow.Name, "An agent does the work") {
		t.Errorf("name = %q", out.Workflow.Name)
	}
	if out.Workflow.Description != strings.TrimSpace(long) {
		t.Errorf("the description must stay whole, got %d characters", len(out.Workflow.Description))
	}

	// A short description is the name as it is; none at all gives the key.
	short := freshWorkflowKey()
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": workflowYAML(short, "Short and clear"),
	})).Want(http.StatusCreated).JSON(&out)
	if out.Workflow.Name != "Short and clear" {
		t.Errorf("name = %q", out.Workflow.Name)
	}
	bare := freshWorkflowKey()
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": workflowYAML(bare, ""),
	})).Want(http.StatusCreated).JSON(&out)
	if out.Workflow.Name != bare {
		t.Errorf("name = %q, want the key %q", out.Workflow.Name, bare)
	}
}

func TestCreateWorkflowRejectsBadInput(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	createWorkflowFor(t, key)

	cases := map[string]struct {
		body map[string]any
		want int
		part string
	}{
		"duplicate key":     {map[string]any{"definition": workflowYAML(key, "")}, http.StatusConflict, "already exists"},
		"unreadable YAML":   {map[string]any{"definition": "kind: [unclosed"}, http.StatusBadRequest, "invalid_definition"},
		"unknown field":     {map[string]any{"definition": strings.Replace(workflowYAML(freshWorkflowKey(), ""), "kind: Workflow", "kind: Workflow\nbogus: 1", 1)}, http.StatusBadRequest, "bogus"},
		"key not kebab":     {map[string]any{"definition": workflowYAML("Not_Kebab", "")}, http.StatusBadRequest, "kebab-case"},
		"key too long":      {map[string]any{"definition": workflowYAML(strings.Repeat("a", 41), "")}, http.StatusBadRequest, "kebab-case"},
		"note too long":     {map[string]any{"definition": workflowYAML(freshWorkflowKey(), ""), "note": strings.Repeat("n", 501)}, http.StatusBadRequest, "note"},
		"name too long":     {map[string]any{"definition": workflowYAML(freshWorkflowKey(), ""), "name": strings.Repeat("n", 121)}, http.StatusBadRequest, "name"},
		"layout wrong type": {map[string]any{"definition": workflowYAML(freshWorkflowKey(), ""), "layout": []int{1}}, http.StatusBadRequest, "layout"},
		"layout bad number": {map[string]any{"definition": workflowYAML(freshWorkflowKey(), ""), "layout": map[string]any{"a": map[string]any{"x": 1e9, "y": 0}}}, http.StatusBadRequest, "layout"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			w := testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", c.body)).Want(c.want)
			if !strings.Contains(w.Body.String(), c.part) {
				t.Errorf("response does not mention %q: %s", c.part, w.Body.String())
			}
		})
	}
	// Garbage that is not JSON at all.
	req := httptest.NewRequest("POST", "/api/workflows", strings.NewReader("{nope"))
	req.Header.Set("X-User-ID", testUserID)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	testutil.Call(t, testHandler.CreateWorkflow, req).Want(http.StatusBadRequest)
}

func TestSavingWithProblemsIsAllowedAndReportsThem(t *testing.T) {
	enableWorkflows(t)
	key := freshWorkflowKey()
	broken := strings.Replace(workflowYAML(key, ""), "on_approve: done", "on_approve: nowhere", 1)
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{"definition": broken})).
		Want(http.StatusCreated).JSON(&out)
	codes := map[string]bool{}
	for _, i := range out.Version.Issues {
		codes[i.Code] = true
	}
	if !codes["V002"] {
		t.Errorf("the dangling reference was not reported: %+v", out.Version.Issues)
	}
}

func TestOnlyHumanOwnersAndAdminsMayWrite(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())

	member := dbfx.User(t, "WF Plain Member", "wf-plain-member@example.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	admin := dbfx.User(t, "WF Admin", "wf-admin@example.test")
	dbfx.Member(t, testWorkspaceID, admin, "admin")

	body := map[string]any{"definition": workflowYAML(freshWorkflowKey(), "")}

	// A plain member can read but not write.
	testutil.Call(t, testHandler.ListWorkflows, newRequestAs(member, "GET", "/api/workflows", nil)).Want(http.StatusOK)
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequestAs(member, "GET", "/x", nil), "id", created.Workflow.ID)).Want(http.StatusOK)
	testutil.Call(t, testHandler.CreateWorkflow, newRequestAs(member, "POST", "/api/workflows", body)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.SaveWorkflowVersion,
		withURLParam(newRequestAs(member, "POST", "/x", map[string]any{"definition": workflowYAML(created.Workflow.Key, ""), "base_version": 1}), "id", created.Workflow.ID)).
		Want(http.StatusForbidden)
	testutil.Call(t, testHandler.UpdateWorkflow,
		withURLParam(newRequestAs(member, "PATCH", "/x", map[string]any{"name": "x", "revision": 1}), "id", created.Workflow.ID)).
		Want(http.StatusForbidden)

	// An admin can write.
	testutil.Call(t, testHandler.CreateWorkflow, newRequestAs(admin, "POST", "/api/workflows", body)).Want(http.StatusCreated)

	// An agent acting for the owner cannot: a workflow decides who approves what.
	req := newRequest("POST", "/api/workflows", map[string]any{"definition": workflowYAML(freshWorkflowKey(), "")})
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-0000000000aa")
	w := testutil.Call(t, testHandler.CreateWorkflow, req).Want(http.StatusForbidden)
	if !strings.Contains(w.Body.String(), "agents cannot manage workflows") {
		t.Errorf("unexpected message: %s", w.Body.String())
	}
}

func TestSaveVersionNumbersAndStamps(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id, key := created.Workflow.ID, created.Workflow.Key

	var saved workflowCreated
	saveWorkflowVersion(t, id, map[string]any{
		"definition": workflowYAML(key, "second text"), "base_version": 1, "note": "second",
	}).Want(http.StatusCreated).JSON(&saved)
	if saved.Version.Version != 2 || saved.Workflow.LatestVersion != 2 || saved.Version.Note != "second" {
		t.Fatalf("unexpected result: %+v %+v", saved.Workflow, saved.Version)
	}
	def, _ := workflow.Parse([]byte(*saved.Version.Definition))
	if def.Metadata.Version != 2 || def.Metadata.Description != "second text" {
		t.Errorf("the stored definition must name version 2: %+v", def.Metadata)
	}

	// Version 1 is exactly what it was.
	var v1 WorkflowVersionResponse
	testutil.Call(t, testHandler.GetWorkflowVersion, withURLParams(newRequest("GET", "/x", nil), "id", id, "version", "1")).
		Want(http.StatusOK).JSON(&v1)
	if v1.ContentHash != created.Version.ContentHash || *v1.Definition != *created.Version.Definition {
		t.Error("version 1 changed after version 2 was saved")
	}

	var list struct {
		Versions []WorkflowVersionResponse `json:"versions"`
	}
	testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(newRequest("GET", "/x", nil), "id", id)).
		Want(http.StatusOK).JSON(&list)
	if len(list.Versions) != 2 || list.Versions[0].Version != 2 || list.Versions[0].Definition != nil {
		t.Errorf("history should list newest first without bodies: %+v", list.Versions)
	}
}

func TestSaveVersionRejections(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id, key := created.Workflow.ID, created.Workflow.Key
	good := workflowYAML(key, "x")

	t.Run("stale base", func(t *testing.T) {
		saveWorkflowVersion(t, id, map[string]any{"definition": good, "base_version": 1}).Want(http.StatusCreated)
		w := saveWorkflowVersion(t, id, map[string]any{"definition": good, "base_version": 1}).Want(http.StatusConflict)
		if !strings.Contains(w.Body.String(), "version_conflict") || !strings.Contains(w.Body.String(), `"latest_version":2`) {
			t.Errorf("conflict must carry the latest version: %s", w.Body.String())
		}
	})
	t.Run("base missing", func(t *testing.T) {
		saveWorkflowVersion(t, id, map[string]any{"definition": good}).Want(http.StatusBadRequest)
	})
	t.Run("key cannot change", func(t *testing.T) {
		w := saveWorkflowVersion(t, id, map[string]any{"definition": workflowYAML("another-key", ""), "base_version": 2}).Want(http.StatusBadRequest)
		if !strings.Contains(w.Body.String(), "cannot be changed") {
			t.Errorf("unexpected: %s", w.Body.String())
		}
	})
	t.Run("unreadable definition", func(t *testing.T) {
		saveWorkflowVersion(t, id, map[string]any{"definition": "nope: [", "base_version": 2}).Want(http.StatusBadRequest)
	})
	t.Run("unknown workflow", func(t *testing.T) {
		saveWorkflowVersion(t, "11111111-1111-1111-1111-111111111111", map[string]any{"definition": good, "base_version": 0}).Want(http.StatusNotFound)
	})
	t.Run("nothing was written by the failures", func(t *testing.T) {
		var n int
		dbfx.QueryRow(t, `SELECT count(*) FROM workflow_version WHERE workflow_id = $1`, id).Scan(&n)
		if n != 2 {
			t.Errorf("%d versions, want 2", n)
		}
	})
}

// Several saves racing on the same base: exactly one wins, and the version
// numbers stay one-per-save with no gaps or duplicates.
func TestConcurrentSavesProduceOneWinner(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id, key := created.Workflow.ID, created.Workflow.Key

	const racers = 8
	statuses := make([]int, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			testHandler.SaveWorkflowVersion(rec, withURLParam(newRequest("POST", "/x", map[string]any{
				"definition": workflowYAML(key, fmt.Sprintf("racer %d", i)), "base_version": 1,
			}), "id", id))
			statuses[i] = rec.Code
		}()
	}
	wg.Wait()

	created201, conflicts := 0, 0
	for _, s := range statuses {
		switch s {
		case http.StatusCreated:
			created201++
		case http.StatusConflict:
			conflicts++
		default:
			t.Errorf("unexpected status %d in %v", s, statuses)
		}
	}
	if created201 != 1 || conflicts != racers-1 {
		t.Errorf("statuses %v: want exactly one 201", statuses)
	}
	var versions, distinct int
	dbfx.QueryRow(t, `SELECT count(*), count(DISTINCT version) FROM workflow_version WHERE workflow_id = $1`, id).Scan(&versions, &distinct)
	if versions != 2 || distinct != 2 {
		t.Errorf("%d rows, %d distinct versions; want 2 and 2", versions, distinct)
	}
}

func TestRestoreSavesTheOldContentAsANewVersion(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id, key := created.Workflow.ID, created.Workflow.Key
	saveWorkflowVersion(t, id, map[string]any{
		"definition": workflowYAML(key, "changed"), "base_version": 1,
		"layout": map[string]any{"build": map[string]any{"x": 5, "y": 6}},
	}).Want(http.StatusCreated)

	var restored workflowCreated
	testutil.Call(t, testHandler.RestoreWorkflowVersion, withURLParams(newRequest("POST", "/x", nil), "id", id, "version", "1")).
		Want(http.StatusCreated).JSON(&restored)
	if restored.Version.Version != 3 || restored.Version.Note != "Restored from version 1" {
		t.Fatalf("unexpected: %+v", restored.Version)
	}
	old, _ := workflow.Parse([]byte(*created.Version.Definition))
	now, _ := workflow.Parse([]byte(*restored.Version.Definition))
	if now.Metadata.Description != old.Metadata.Description || now.Metadata.Version != 3 {
		t.Errorf("restored content: %+v", now.Metadata)
	}

	var list struct {
		Versions []WorkflowVersionResponse `json:"versions"`
	}
	testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusOK).JSON(&list)
	if len(list.Versions) != 3 {
		t.Errorf("history must keep every version: %d", len(list.Versions))
	}

	var audit struct {
		Audit []struct {
			Action string `json:"action"`
		} `json:"audit"`
	}
	testutil.Call(t, testHandler.ListWorkflowAudit, withURLParam(newRequest("GET", "/x", nil), "id", id)).Want(http.StatusOK).JSON(&audit)
	var actions []string
	for _, a := range audit.Audit {
		actions = append(actions, a.Action)
	}
	if got := strings.Join(actions, ","); got != "restore,save,create" {
		t.Errorf("audit newest first: %s", got)
	}

	testutil.Call(t, testHandler.RestoreWorkflowVersion, withURLParams(newRequest("POST", "/x", nil), "id", id, "version", "99")).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.RestoreWorkflowVersion, withURLParams(newRequest("POST", "/x", nil), "id", id, "version", "abc")).Want(http.StatusNotFound)
}

func TestLayoutIsStoredAndReturned(t *testing.T) {
	enableWorkflows(t)
	var out workflowCreated
	testutil.Call(t, testHandler.CreateWorkflow, newRequest("POST", "/api/workflows", map[string]any{
		"definition": workflowYAML(freshWorkflowKey(), ""),
		"layout":     map[string]any{"build": map[string]any{"x": 10, "y": 20.5}},
	})).Want(http.StatusCreated).JSON(&out)
	if !strings.Contains(string(out.Version.Layout), `"build"`) || !strings.Contains(string(out.Version.Layout), "20.5") {
		t.Errorf("layout not returned: %s", out.Version.Layout)
	}
}

func TestArchiveAndRevisionGuard(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())
	id := created.Workflow.ID
	patch := func(body map[string]any) *testutil.Response {
		return testutil.Call(t, testHandler.UpdateWorkflow, withURLParam(newRequest("PATCH", "/x", body), "id", id))
	}

	var archived WorkflowResponse
	patch(map[string]any{"status": "archived", "revision": created.Workflow.Revision}).Want(http.StatusOK).JSON(&archived)
	if archived.Status != "archived" || archived.Revision <= created.Workflow.Revision {
		t.Fatalf("unexpected: %+v", archived)
	}

	// A stale revision is refused, and says what the revision is now.
	w := patch(map[string]any{"name": "late", "revision": created.Workflow.Revision}).Want(http.StatusConflict)
	if !strings.Contains(w.Body.String(), "revision_conflict") {
		t.Errorf("unexpected: %s", w.Body.String())
	}
	patch(map[string]any{"name": "x"}).Want(http.StatusBadRequest)                   // revision required
	patch(map[string]any{"revision": archived.Revision}).Want(http.StatusBadRequest) // nothing to update
	patch(map[string]any{"status": "gone", "revision": archived.Revision}).Want(http.StatusBadRequest)
	patch(map[string]any{"name": "   ", "revision": archived.Revision}).Want(http.StatusBadRequest)

	// An archived workflow cannot get new versions, and is hidden from the default list.
	saveWorkflowVersion(t, id, map[string]any{"definition": workflowYAML(created.Workflow.Key, "x"), "base_version": 1}).Want(http.StatusConflict)
	var list struct {
		Workflows []WorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListWorkflows, newRequest("GET", "/api/workflows", nil)).Want(http.StatusOK).JSON(&list)
	for _, wf := range list.Workflows {
		if wf.ID == id {
			t.Error("an archived workflow is in the default list")
		}
	}
	testutil.Call(t, testHandler.ListWorkflows, newRequest("GET", "/api/workflows?include_archived=true", nil)).Want(http.StatusOK).JSON(&list)
	found := false
	for _, wf := range list.Workflows {
		found = found || wf.ID == id
	}
	if !found {
		t.Error("include_archived did not list it")
	}

	var back WorkflowResponse
	patch(map[string]any{"status": "active", "revision": archived.Revision}).Want(http.StatusOK).JSON(&back)
	if back.Status != "active" {
		t.Errorf("unarchive: %+v", back)
	}
	saveWorkflowVersion(t, id, map[string]any{"definition": workflowYAML(created.Workflow.Key, "x"), "base_version": 1}).Want(http.StatusCreated)
}

func TestWorkflowsAreScopedToTheirWorkspace(t *testing.T) {
	enableWorkflows(t)
	created := createWorkflowFor(t, freshWorkflowKey())

	otherUser := dbfx.User(t, "WF Other Owner", "wf-other-owner@example.test")
	otherWorkspace := dbfx.Workspace(t, "WF Other", "wf-other-workspace")
	dbfx.Member(t, otherWorkspace, otherUser, "owner")

	asOther := func(method, path string, body any) *http.Request {
		req := newRequestAs(otherUser, method, path, body)
		req.Header.Set("X-Workspace-ID", otherWorkspace)
		return req
	}
	id := created.Workflow.ID
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(asOther("GET", "/x", nil), "id", id)).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.ListWorkflowVersions, withURLParam(asOther("GET", "/x", nil), "id", id)).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.GetWorkflowVersion, withURLParams(asOther("GET", "/x", nil), "id", id, "version", "1")).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.SaveWorkflowVersion,
		withURLParam(asOther("POST", "/x", map[string]any{"definition": workflowYAML(created.Workflow.Key, ""), "base_version": 1}), "id", id)).
		Want(http.StatusNotFound)
	testutil.Call(t, testHandler.RestoreWorkflowVersion, withURLParams(asOther("POST", "/x", nil), "id", id, "version", "1")).Want(http.StatusNotFound)
	testutil.Call(t, testHandler.UpdateWorkflow,
		withURLParam(asOther("PATCH", "/x", map[string]any{"name": "stolen", "revision": 1}), "id", id)).Want(http.StatusNotFound)

	var list struct {
		Workflows []WorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListWorkflows, asOther("GET", "/api/workflows", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Workflows) != 0 {
		t.Errorf("another workspace sees %d workflows", len(list.Workflows))
	}

	// The same key is free to use in another workspace.
	testutil.Call(t, testHandler.CreateWorkflow, asOther("POST", "/api/workflows", map[string]any{"definition": workflowYAML(created.Workflow.Key, "")})).
		Want(http.StatusCreated)
	t.Cleanup(func() {
		for _, table := range []string{"workflow_audit", "workflow_version", "workflow"} {
			testPool.Exec(context.Background(), `DELETE FROM `+table+` WHERE workspace_id = $1`, otherWorkspace)
		}
	})
}

func TestValidateEndpoint(t *testing.T) {
	enableWorkflows(t)
	call := func(def string) map[string]any {
		var out map[string]any
		testutil.Call(t, testHandler.ValidateWorkflowDefinition, newRequest("POST", "/api/workflows/validate", map[string]any{"definition": def})).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	if r := call(workflowYAML("ok", "")); r["parsed"] != true || r["valid"] != true {
		t.Errorf("valid: %v", r)
	}
	r := call(strings.Replace(workflowYAML("ok", ""), "on_approve: done", "on_approve: nowhere", 1))
	if r["parsed"] != true || r["valid"] != false || !strings.Contains(fmt.Sprint(r["issues"]), "V002") {
		t.Errorf("problems: %v", r)
	}
	if r := call("kind: ["); r["parsed"] != false || r["valid"] != false {
		t.Errorf("unreadable: %v", r)
	}

	// It saves nothing.
	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM workflow WHERE workspace_id = $1 AND key = 'ok'`, testWorkspaceID).Scan(&n)
	if n != 0 {
		t.Error("validate created a workflow")
	}
}

func TestWorkflowIDsMustBeUUIDs(t *testing.T) {
	enableWorkflows(t)
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", "not-a-uuid")).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.GetWorkflow, withURLParam(newRequest("GET", "/x", nil), "id", "' OR 1=1 --")).Want(http.StatusBadRequest)
}
