package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/spf13/cobra"
)

const (
	testWorkflowID = "11111111-1111-4111-8111-111111111111"
	testSquadID    = "22222222-2222-4222-8222-222222222222"
)

type workflowTestServer struct {
	mu       sync.Mutex
	requests []string
	bodies   map[string]map[string]any
	handler  func(w http.ResponseWriter, r *http.Request)
}

func (s *workflowTestServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.requests {
		if r == method+" "+path {
			return true
		}
	}
	return false
}

func startWorkflowServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *workflowTestServer {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("MULTICA_TOKEN", "test-token")
	t.Setenv("MULTICA_WORKSPACE_ID", "workspace-123")
	s := &workflowTestServer{bodies: map[string]map[string]any{}, handler: handler}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path
		s.mu.Lock()
		s.requests = append(s.requests, key)
		if r.Body != nil && r.Method != http.MethodGet {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
				s.bodies[key] = body
			}
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		s.handler(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	return s
}

func writeTestJSON(w http.ResponseWriter, status int, v any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// workflowTestCmd builds a command with the persistent flags newAPIClient reads
// plus the given command-specific flags, capturing stdout and stderr.
func workflowTestCmd(stdin string, flags map[string]string) (*cobra.Command, *bytes.Buffer, *bytes.Buffer) {
	cmd := &cobra.Command{Use: "test"}
	for _, name := range []string{"server-url", "workspace-id", "profile", "file", "squad", "output"} {
		cmd.Flags().String(name, "", "")
	}
	cmd.Flags().Int("version", 0, "")
	cmd.Flags().Bool("all", false, "")
	cmd.Flags().Bool("labels", false, "")
	cmd.Flags().Bool("replace", false, "")
	for k, v := range flags {
		if err := cmd.Flags().Set(k, v); err != nil {
			panic(err)
		}
	}
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetIn(strings.NewReader(stdin))
	return cmd, &out, &errOut
}

var sampleWorkflow = map[string]any{
	"id": testWorkflowID, "key": "sdlc-pilot", "name": "SDLC pilot", "status": "active",
	"latest_version": float64(3),
}

func TestWorkflowListPrintsATable(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, 200, map[string]any{"workflows": []any{sampleWorkflow}})
	})
	cmd, out, _ := workflowTestCmd("", nil)
	if err := runWorkflowList(cmd, nil); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ID", "KEY", "sdlc-pilot", "SDLC pilot", "3", "active"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("table lacks %q:\n%s", want, out.String())
		}
	}
}

func TestWorkflowListAllAndEmpty(t *testing.T) {
	var query string
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		writeTestJSON(w, 200, map[string]any{"workflows": []any{}})
	})
	cmd, out, errOut := workflowTestCmd("", nil)
	_ = cmd.Flags().Set("all", "true")
	if err := runWorkflowList(cmd, nil); err != nil {
		t.Fatal(err)
	}
	if query != "include_archived=true" {
		t.Errorf("query = %q", query)
	}
	if out.Len() != 0 || !strings.Contains(errOut.String(), "No workflows found") {
		t.Errorf("stdout=%q stderr=%q", out.String(), errOut.String())
	}
}

func TestWorkflowGetResolvesAKeyAndCanPrintOnlyTheYAML(t *testing.T) {
	const yaml = "apiVersion: composer.noqodi/v1\nkind: Workflow\n"
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workflows":
			writeTestJSON(w, 200, map[string]any{"workflows": []any{sampleWorkflow}})
		case "/api/workflows/" + testWorkflowID:
			writeTestJSON(w, 200, map[string]any{"workflow": sampleWorkflow, "version": map[string]any{
				"version": float64(3), "content_hash": "abc", "definition": yaml,
				"issues": []any{map[string]any{"code": "V003", "message": "unreachable", "stage_id": "x"}},
			}})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})

	cmd, out, _ := workflowTestCmd("", map[string]string{"output": "yaml"})
	if err := runWorkflowGet(cmd, []string{"sdlc-pilot"}); err != nil {
		t.Fatal(err)
	}
	if out.String() != yaml {
		t.Errorf("--output yaml should print only the definition, got %q", out.String())
	}
	if !srv.saw("GET", "/api/workflows") || !srv.saw("GET", "/api/workflows/"+testWorkflowID) {
		t.Errorf("requests: %v", srv.requests)
	}

	cmd, out, _ = workflowTestCmd("", nil)
	if err := runWorkflowGet(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Key:       sdlc-pilot", "version 3", "Problems (1)", "V003", "stage x", yaml} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
}

func TestWorkflowGetAVersionReadsThatVersion(t *testing.T) {
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workflows/" + testWorkflowID + "/versions/2":
			writeTestJSON(w, 200, map[string]any{"version": float64(2), "definition": "v: two\n"})
		case "/api/workflows/" + testWorkflowID:
			writeTestJSON(w, 200, map[string]any{"workflow": sampleWorkflow})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})
	cmd, out, _ := workflowTestCmd("", map[string]string{"output": "yaml", "version": "2"})
	if err := runWorkflowGet(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "v: two\n" || !srv.saw("GET", "/api/workflows/"+testWorkflowID+"/versions/2") {
		t.Errorf("out=%q requests=%v", out.String(), srv.requests)
	}
}

func TestWorkflowValidateFailsTheCommandWhenThereAreProblems(t *testing.T) {
	valid := true
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		if valid {
			writeTestJSON(w, 200, map[string]any{"parsed": true, "valid": true, "issues": []any{}})
			return
		}
		writeTestJSON(w, 200, map[string]any{"parsed": true, "valid": false, "issues": []any{
			map[string]any{"code": "V003", "message": "stage orphan cannot be reached", "stage_id": "orphan"},
			map[string]any{"message": "unknown field", "line": float64(7)},
		}})
	})

	// Valid, from stdin.
	cmd, out, _ := workflowTestCmd("good: yes\n", map[string]string{"file": "-"})
	if err := runWorkflowValidate(cmd, nil); err != nil {
		t.Fatal(err)
	}
	if sent := srv.bodies["POST /api/workflows/validate"]["definition"]; strings.TrimSpace(out.String()) != "Valid." || sent != "good: yes\n" {
		t.Errorf("out=%q sent=%q", out.String(), sent)
	}
	valid = false

	// Invalid, from a file: problems printed, command fails without a second message.
	path := filepath.Join(t.TempDir(), "w.yaml")
	if err := os.WriteFile(path, []byte("bad: yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd, out, _ = workflowTestCmd("", map[string]string{"file": path})
	err := runWorkflowValidate(cmd, nil)
	if !errors.Is(err, errSilent) {
		t.Fatalf("an invalid definition must fail the command silently, got %v", err)
	}
	for _, want := range []string{"2 problem(s)", "V003  stage orphan cannot be reached (stage orphan)", "-  unknown field (line 7)"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
}

func TestWorkflowValidateInputErrors(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("no request expected") })

	cmd, _, _ := workflowTestCmd("", nil)
	if err := runWorkflowValidate(cmd, nil); err == nil || !strings.Contains(err.Error(), "--file is required") {
		t.Errorf("missing --file: %v", err)
	}
	cmd, _, _ = workflowTestCmd("", map[string]string{"file": filepath.Join(t.TempDir(), "nope.yaml")})
	if err := runWorkflowValidate(cmd, nil); err == nil {
		t.Error("a missing file must be an error")
	}
	cmd, _, _ = workflowTestCmd(strings.Repeat("x", maxWorkflowFileBytes+1), map[string]string{"file": "-"})
	if err := runWorkflowValidate(cmd, nil); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Errorf("an oversized file must be refused locally: %v", err)
	}
}

func TestWorkflowRenderSendsTheResolvedSquadAndPrintsTheText(t *testing.T) {
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/squads":
			writeTestJSON(w, 200, []any{map[string]any{"id": testSquadID, "name": "Delivery - Pilot"}})
		case "/api/workflows/" + testWorkflowID + "/render":
			writeTestJSON(w, 200, map[string]any{
				"instructions": "BRIEFING", "labels": []any{"wf:sdlc-pilot", "phase:a"},
			})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})

	cmd, out, _ := workflowTestCmd("", map[string]string{"squad": "delivery - pilot", "version": "2"})
	if err := runWorkflowRender(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "BRIEFING" {
		t.Errorf("out = %q", out.String())
	}
	body := srv.bodies["POST /api/workflows/"+testWorkflowID+"/render"]
	if body["squad_id"] != testSquadID || body["version"] != float64(2) {
		t.Errorf("body = %v", body)
	}

	cmd, out, _ = workflowTestCmd("", map[string]string{"labels": "true"})
	if err := runWorkflowRender(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "wf:sdlc-pilot\nphase:a\n" {
		t.Errorf("--labels = %q", out.String())
	}
}

func TestWorkflowApplyReportsWhatHappened(t *testing.T) {
	respond := map[string]any{"applied": true, "workflow_key": "sdlc-pilot", "version": float64(3), "labels": []any{"wf:sdlc-pilot"}}
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workflows/"+testWorkflowID+"/apply" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		writeTestJSON(w, 200, respond)
	})

	cmd, out, _ := workflowTestCmd("", map[string]string{"squad": testSquadID, "replace": "true", "version": "3"})
	if err := runWorkflowApply(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	body := srv.bodies["POST /api/workflows/"+testWorkflowID+"/apply"]
	if body["squad_id"] != testSquadID || body["replace"] != true || body["version"] != float64(3) {
		t.Errorf("body = %v", body)
	}
	for _, want := range []string{"Applied workflow sdlc-pilot version 3 to squad " + testSquadID, "wf:sdlc-pilot"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}

	respond["applied"] = false
	cmd, out, _ = workflowTestCmd("", map[string]string{"squad": testSquadID})
	if err := runWorkflowApply(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "nothing changed") {
		t.Errorf("a repeat apply should say nothing changed:\n%s", out.String())
	}
	if body := srv.bodies["POST /api/workflows/"+testWorkflowID+"/apply"]; body["replace"] != false {
		if _, hasVersion := body["version"]; hasVersion {
			t.Errorf("no --version must mean the newest: %v", body)
		}
	}
}

func TestWorkflowApplyListsTheMembersItAddedAndTheOnesItCouldNotFind(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, 200, map[string]any{
			"applied": false, "workflow_key": "sdlc-pilot", "version": float64(3),
			"members": []any{
				map[string]any{"kind": "agent", "ref": "builder", "name": "builder", "status": "added"},
				map[string]any{"kind": "person", "ref": "user:1", "name": "Ada", "status": "present"},
				map[string]any{"kind": "person", "ref": "user:<multica-user-id>", "status": "unresolved"},
			},
		})
	})
	cmd, out, _ := workflowTestCmd("", map[string]string{"squad": testSquadID})
	if err := runWorkflowApply(cmd, []string{testWorkflowID}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"briefing is unchanged", "Added to the squad: builder (agent).", "Not found in this workspace, so not added: user:<multica-user-id>."} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "nothing changed") {
		t.Errorf("members were added, so something changed:\n%s", out.String())
	}
}

func TestWorkflowApplySurfacesTheServersRefusal(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, 409, map[string]any{
			"error": `this squad already follows workflow "other"; pass replace to switch it`,
			"code":  "squad_has_workflow",
		})
	})
	cmd, _, _ := workflowTestCmd("", map[string]string{"squad": testSquadID})
	err := runWorkflowApply(cmd, []string{testWorkflowID})
	if err == nil || !strings.Contains(err.Error(), "already follows workflow") {
		t.Fatalf("the server's reason must reach the user, got %v", err)
	}
}

func TestWorkflowApplyNeedsASquadAndAValidVersion(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("no request expected") })
	cmd, _, _ := workflowTestCmd("", nil)
	if err := runWorkflowApply(cmd, []string{testWorkflowID}); err == nil || !strings.Contains(err.Error(), "--squad is required") {
		t.Errorf("missing squad: %v", err)
	}
	cmd, _, _ = workflowTestCmd("", map[string]string{"squad": testSquadID})
	_ = cmd.Flags().Set("version", "-1")
	if err := runWorkflowApply(cmd, []string{testWorkflowID}); err == nil || !strings.Contains(err.Error(), "--version") {
		t.Errorf("negative version: %v", err)
	}
}

func TestResolveWorkflowIDKeyPrefixAndUnknown(t *testing.T) {
	srv := startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, 200, map[string]any{"workflows": []any{
			sampleWorkflow,
			map[string]any{"id": "33333333-3333-4333-8333-333333333333", "key": "other", "status": "archived"},
		}})
	})
	cmd, _, _ := workflowTestCmd("", nil)
	client, err := newAPIClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	ctx := cmd.Context()
	if ctx == nil {
		ctx = t.Context()
	}

	// A full UUID needs no lookup.
	if got, err := resolveWorkflowID(ctx, client, testWorkflowID); err != nil || got != testWorkflowID {
		t.Fatalf("uuid: %q %v", got, err)
	}
	if len(srv.requests) != 0 {
		t.Errorf("a UUID must not trigger a lookup: %v", srv.requests)
	}
	if got, err := resolveWorkflowID(ctx, client, "other"); err != nil || got != "33333333-3333-4333-8333-333333333333" {
		t.Errorf("key (archived ones too): %q %v", got, err)
	}
	if got, err := resolveWorkflowID(ctx, client, "1111"); err != nil || got != testWorkflowID {
		t.Errorf("prefix: %q %v", got, err)
	}
	if _, err := resolveWorkflowID(ctx, client, "nope-flow"); err == nil || !strings.Contains(err.Error(), `no workflow with key "nope-flow"`) {
		t.Errorf("unknown key: %v", err)
	}
	if _, err := resolveWorkflowID(ctx, client, " "); err == nil {
		t.Error("blank input must be refused")
	}
}

func TestResolveSquadRefByNameIsExactAndUnambiguous(t *testing.T) {
	startWorkflowServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, 200, []any{
			map[string]any{"id": testSquadID, "name": "Delivery"},
			map[string]any{"id": "44444444-4444-4444-8444-444444444444", "name": "Delivery Two"},
			map[string]any{"id": "55555555-5555-4555-8555-555555555555", "name": "Twin"},
			map[string]any{"id": "66666666-6666-4666-8666-666666666666", "name": "twin"},
		})
	})
	cmd, _, _ := workflowTestCmd("", nil)
	client, err := newAPIClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	if got, err := resolveSquadRef(ctx, client, "delivery"); err != nil || got != testSquadID {
		t.Errorf("exact, case-insensitive: %q %v", got, err)
	}
	if _, err := resolveSquadRef(ctx, client, "Deliv"); err == nil {
		t.Error("a partial name must not match")
	}
	if _, err := resolveSquadRef(ctx, client, "TWIN"); err == nil || !strings.Contains(err.Error(), "2 squads are named") {
		t.Errorf("ambiguous: %v", err)
	}
}
