package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// maxWorkflowFileBytes bounds a definition read from disk or stdin. The server
// enforces its own, smaller limit; this only keeps a wrong file from filling
// memory before the request is sent.
const maxWorkflowFileBytes = 2 << 20

var workflowCmd = &cobra.Command{
	Use:   "workflow",
	Short: "Work with workflows (versioned stage definitions for squads)",
	Long: `Workflows describe the stages work moves through: agent stages, human
approval gates, conditions and an end. A workflow is applied to a squad by
writing its briefing into the squad leader's instructions.

Reading is open to every member. Applying needs a human owner or admin.
The feature is off unless the server enables workflows_v1.`,
}

// ── List ────────────────────────────────────────────────────────────────────

var workflowListCmd = &cobra.Command{
	Use:   "list",
	Short: "List workflows in the workspace",
	Args:  cobra.NoArgs,
	RunE:  runWorkflowList,
}

func runWorkflowList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	path := "/api/workflows"
	if all, _ := cmd.Flags().GetBool("all"); all {
		path += "?include_archived=true"
	}
	var resp struct {
		Workflows []map[string]any `json:"workflows"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list workflows: %w", err)
	}

	out := cmd.OutOrStdout()
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(out, resp.Workflows)
	}
	if len(resp.Workflows) == 0 {
		fmt.Fprintln(cmd.ErrOrStderr(), "No workflows found.")
		return nil
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tKEY\tNAME\tVERSION\tSTATUS")
	for _, wf := range resp.Workflows {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			strVal(wf, "id"), strVal(wf, "key"), strVal(wf, "name"), workflowNum(wf, "latest_version"), strVal(wf, "status"))
	}
	return w.Flush()
}

// workflowNum renders a JSON number as an integer string, or "-" when absent.
func workflowNum(m map[string]any, key string) string {
	n, ok := m[key].(float64)
	if !ok {
		return "-"
	}
	return strconv.Itoa(int(n))
}

// ── Get ─────────────────────────────────────────────────────────────────────

var workflowGetCmd = &cobra.Command{
	Use:   "get <workflow>",
	Short: "Show a workflow and the YAML of a version",
	Long: `Show a workflow and the YAML of its newest version, or of --version.
<workflow> is a workflow ID or its key (the id inside the definition).

Use --output yaml to print only the definition, ready to pipe into
"multica workflow validate --file -".`,
	Args: exactArgs(1),
	RunE: runWorkflowGet,
}

func runWorkflowGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	id, err := resolveWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	version, _ := cmd.Flags().GetInt("version")
	if version < 0 {
		return fmt.Errorf("--version must be positive")
	}

	var workflowRec, versionRec map[string]any
	if version > 0 {
		if err := client.GetJSON(ctx, "/api/workflows/"+id+"/versions/"+strconv.Itoa(version), &versionRec); err != nil {
			return fmt.Errorf("get workflow version: %w", err)
		}
		// The version alone does not carry the workflow's name or key.
		var head struct {
			Workflow map[string]any `json:"workflow"`
		}
		if err := client.GetJSON(ctx, "/api/workflows/"+id, &head); err != nil {
			return fmt.Errorf("get workflow: %w", err)
		}
		workflowRec = head.Workflow
	} else {
		var head struct {
			Workflow map[string]any `json:"workflow"`
			Version  map[string]any `json:"version"`
		}
		if err := client.GetJSON(ctx, "/api/workflows/"+id, &head); err != nil {
			return fmt.Errorf("get workflow: %w", err)
		}
		workflowRec, versionRec = head.Workflow, head.Version
	}

	out := cmd.OutOrStdout()
	switch output, _ := cmd.Flags().GetString("output"); output {
	case "json":
		return cli.PrintJSON(out, map[string]any{"workflow": workflowRec, "version": versionRec})
	case "yaml":
		if versionRec == nil {
			return fmt.Errorf("the workflow has no saved version")
		}
		_, err := io.WriteString(out, strVal(versionRec, "definition"))
		return err
	}

	fmt.Fprintf(out, "ID:        %s\n", strVal(workflowRec, "id"))
	fmt.Fprintf(out, "Key:       %s\n", strVal(workflowRec, "key"))
	fmt.Fprintf(out, "Name:      %s\n", strVal(workflowRec, "name"))
	fmt.Fprintf(out, "Status:    %s\n", strVal(workflowRec, "status"))
	fmt.Fprintf(out, "Versions:  %s\n", workflowNum(workflowRec, "latest_version"))
	if versionRec == nil {
		fmt.Fprintln(out, "\nThis workflow has no saved version yet.")
		return nil
	}
	fmt.Fprintf(out, "Shown:     version %s (%s)\n", workflowNum(versionRec, "version"), strVal(versionRec, "content_hash"))
	if issues, _ := versionRec["issues"].([]any); len(issues) > 0 {
		fmt.Fprintf(out, "\nProblems (%d):\n", len(issues))
		printWorkflowIssues(out, issues)
	}
	fmt.Fprintf(out, "\n%s", strVal(versionRec, "definition"))
	return nil
}

// ── Validate ────────────────────────────────────────────────────────────────

var workflowValidateCmd = &cobra.Command{
	Use:   "validate",
	Short: "Check a workflow definition without saving it",
	Long: `Check a workflow definition (YAML) against the server's rules. Nothing is
saved. Exits non-zero when the definition has problems, so it can gate a script.

  multica workflow validate --file workflow.yaml
  multica workflow get my-flow --output yaml | multica workflow validate --file -`,
	Args: cobra.NoArgs,
	RunE: runWorkflowValidate,
}

func runWorkflowValidate(cmd *cobra.Command, _ []string) error {
	file, _ := cmd.Flags().GetString("file")
	if file == "" {
		return fmt.Errorf("--file is required (use - for stdin)")
	}
	definition, err := readWorkflowFile(cmd, file)
	if err != nil {
		return err
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp struct {
		Parsed bool  `json:"parsed"`
		Valid  bool  `json:"valid"`
		Issues []any `json:"issues"`
	}
	if err := client.PostJSON(ctx, "/api/workflows/validate", map[string]any{"definition": definition}, &resp); err != nil {
		return fmt.Errorf("validate workflow: %w", err)
	}

	out := cmd.OutOrStdout()
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		if err := cli.PrintJSON(out, resp); err != nil {
			return err
		}
	} else if resp.Valid {
		fmt.Fprintln(out, "Valid.")
	} else {
		fmt.Fprintf(out, "Not valid: %d problem(s)\n", len(resp.Issues))
		printWorkflowIssues(out, resp.Issues)
	}
	if !resp.Valid {
		// The verdict is already printed; a bare error keeps the exit code
		// non-zero without repeating it.
		return errSilent
	}
	return nil
}

func readWorkflowFile(cmd *cobra.Command, path string) (string, error) {
	var r io.Reader
	if path == "-" {
		r = cmd.InOrStdin()
	} else {
		f, err := os.Open(path)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", path, err)
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(io.LimitReader(r, maxWorkflowFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) > maxWorkflowFileBytes {
		return "", fmt.Errorf("%s is larger than %d bytes", path, maxWorkflowFileBytes)
	}
	return string(data), nil
}

func printWorkflowIssues(out io.Writer, issues []any) {
	for _, raw := range issues {
		issue, _ := raw.(map[string]any)
		var where []string
		if s := strVal(issue, "stage_id"); s != "" {
			where = append(where, "stage "+s)
		}
		if l, ok := issue["line"].(float64); ok && l > 0 {
			where = append(where, "line "+strconv.Itoa(int(l)))
		}
		code := strVal(issue, "code")
		if code == "" {
			code = "-"
		}
		suffix := ""
		if len(where) > 0 {
			suffix = " (" + strings.Join(where, ", ") + ")"
		}
		fmt.Fprintf(out, "  %s  %s%s\n", code, strVal(issue, "message"), suffix)
	}
}

// ── Render ──────────────────────────────────────────────────────────────────

var workflowRenderCmd = &cobra.Command{
	Use:   "render <workflow>",
	Short: "Preview the briefing a workflow gives a squad leader",
	Long: `Print the briefing "apply" would write into a squad's instructions. Nothing is
changed. Pass --squad to put that squad's name in the text.

Use --labels to print only the labels the workflow implies, one per line:
create them in the workspace before issues enter the workflow.`,
	Args: exactArgs(1),
	RunE: runWorkflowRender,
}

func runWorkflowRender(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	id, err := resolveWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{}
	if v, _ := cmd.Flags().GetInt("version"); v < 0 {
		return fmt.Errorf("--version must be positive")
	} else if v > 0 {
		body["version"] = v
	}
	if squad, _ := cmd.Flags().GetString("squad"); squad != "" {
		squadID, err := resolveSquadRef(ctx, client, squad)
		if err != nil {
			return err
		}
		body["squad_id"] = squadID
	}

	var resp map[string]any
	if err := client.PostJSON(ctx, "/api/workflows/"+id+"/render", body, &resp); err != nil {
		return fmt.Errorf("render workflow: %w", err)
	}

	out := cmd.OutOrStdout()
	if labels, _ := cmd.Flags().GetBool("labels"); labels {
		for _, l := range stringList(resp["labels"]) {
			fmt.Fprintln(out, l)
		}
		return nil
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(out, resp)
	}
	_, err = fmt.Fprintln(out, strVal(resp, "instructions"))
	return err
}

func stringList(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ── Apply ───────────────────────────────────────────────────────────────────

var workflowApplyCmd = &cobra.Command{
	Use:   "apply <workflow>",
	Short: "Write a workflow's briefing into a squad's instructions",
	Long: `Apply a workflow version to a squad: its briefing is written into the squad's
instructions between marker lines. Text the squad already has outside those
lines is left alone, and applying the same version again changes nothing.

A squad that already follows a different workflow is refused unless you pass
--replace. Needs a human workspace owner or admin; agents cannot apply.`,
	Args: exactArgs(1),
	RunE: runWorkflowApply,
}

func runWorkflowApply(cmd *cobra.Command, args []string) error {
	squad, _ := cmd.Flags().GetString("squad")
	if squad == "" {
		return fmt.Errorf("--squad is required (squad name or ID)")
	}
	version, _ := cmd.Flags().GetInt("version")
	if version < 0 {
		return fmt.Errorf("--version must be positive")
	}
	replace, _ := cmd.Flags().GetBool("replace")

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	id, err := resolveWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	squadID, err := resolveSquadRef(ctx, client, squad)
	if err != nil {
		return err
	}
	body := map[string]any{"squad_id": squadID, "replace": replace}
	if version > 0 {
		body["version"] = version
	}

	var resp map[string]any
	if err := client.PostJSON(ctx, "/api/workflows/"+id+"/apply", body, &resp); err != nil {
		return fmt.Errorf("apply workflow: %w", err)
	}

	out := cmd.OutOrStdout()
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(out, resp)
	}
	key, ver := strVal(resp, "workflow_key"), workflowNum(resp, "version")
	if applied, _ := resp["applied"].(bool); applied {
		fmt.Fprintf(out, "Applied workflow %s version %s to squad %s.\n", key, ver, squadID)
		if replaced := strVal(resp, "replaced_workflow"); replaced != "" {
			fmt.Fprintf(out, "It replaced workflow %s.\n", replaced)
		}
	} else if !workflowMembersAdded(resp) {
		fmt.Fprintf(out, "Squad %s already has workflow %s version %s; nothing changed.\n", squadID, key, ver)
	} else {
		fmt.Fprintf(out, "Squad %s already has workflow %s version %s; its briefing is unchanged.\n", squadID, key, ver)
	}
	printWorkflowMembers(out, resp)
	if labels := stringList(resp["labels"]); len(labels) > 0 {
		fmt.Fprintf(out, "\nLabels the workflow uses (create any that are missing):\n")
		for _, l := range labels {
			fmt.Fprintf(out, "  %s\n", l)
		}
	}
	return nil
}

// workflowMembers reads the "members" list of a render or apply answer.
func workflowMembers(resp map[string]any) []map[string]any {
	items, _ := resp["members"].([]any)
	var out []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func workflowMembersAdded(resp map[string]any) bool {
	for _, m := range workflowMembers(resp) {
		if strVal(m, "status") == "added" {
			return true
		}
	}
	return false
}

// printWorkflowMembers says which agents and people were added to the squad and
// which the workflow names but the workspace does not have.
func printWorkflowMembers(out io.Writer, resp map[string]any) {
	var added, unresolved []string
	for _, m := range workflowMembers(resp) {
		switch strVal(m, "status") {
		case "added":
			name := strVal(m, "name")
			if name == "" {
				name = strVal(m, "ref")
			}
			added = append(added, fmt.Sprintf("%s (%s)", name, strVal(m, "kind")))
		case "unresolved":
			unresolved = append(unresolved, strVal(m, "ref"))
		}
	}
	if len(added) > 0 {
		fmt.Fprintf(out, "Added to the squad: %s.\n", strings.Join(added, ", "))
	}
	if len(unresolved) > 0 {
		fmt.Fprintf(out, "Not found in this workspace, so not added: %s.\n", strings.Join(unresolved, ", "))
	}
}

// ── Reference resolution ────────────────────────────────────────────────────

// resolveWorkflowID accepts a workflow UUID, its key (the id inside the
// definition) or a UUID prefix.
func resolveWorkflowID(ctx context.Context, client *cli.APIClient, input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return "", fmt.Errorf("workflow is required")
	}
	if uuidRegexp.MatchString(trimmed) {
		return trimmed, nil
	}
	var resp struct {
		Workflows []map[string]any `json:"workflows"`
	}
	if err := client.GetJSON(ctx, "/api/workflows?include_archived=true", &resp); err != nil {
		return "", fmt.Errorf("resolve workflow: %w", err)
	}
	for _, wf := range resp.Workflows {
		if strVal(wf, "key") == trimmed {
			return strVal(wf, "id"), nil
		}
	}
	if _, err := normalizeUUIDPrefix(trimmed); err != nil {
		return "", fmt.Errorf("no workflow with key %q; run `multica workflow list`", trimmed)
	}
	candidates := make([]idCandidate, 0, len(resp.Workflows))
	for _, wf := range resp.Workflows {
		candidates = append(candidates, idCandidate{ID: strVal(wf, "id"), Display: strVal(wf, "key"), Detail: strVal(wf, "status")})
	}
	resolved, err := resolveIDByPrefix(ctx, client, "workflow", trimmed, func(context.Context, *cli.APIClient) ([]idCandidate, error) {
		return candidates, nil
	})
	if err != nil {
		return "", err
	}
	return resolved.ID, nil
}

// resolveSquadRef accepts a squad UUID or its exact name (case-insensitive).
func resolveSquadRef(ctx context.Context, client *cli.APIClient, input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if uuidRegexp.MatchString(trimmed) {
		return trimmed, nil
	}
	var squads []map[string]any
	if err := client.GetJSON(ctx, "/api/squads", &squads); err != nil {
		return "", fmt.Errorf("resolve squad: %w", err)
	}
	var matches []string
	for _, s := range squads {
		if strings.EqualFold(strVal(s, "name"), trimmed) {
			matches = append(matches, strVal(s, "id"))
		}
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no squad named %q; run `multica squad list` or pass the squad ID", trimmed)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("%d squads are named %q; pass the squad ID: %s", len(matches), trimmed, strings.Join(matches, ", "))
	}
}

func init() {
	workflowListCmd.Flags().String("output", "table", "Output format: table or json")
	workflowListCmd.Flags().Bool("all", false, "Include archived workflows")

	workflowGetCmd.Flags().String("output", "table", "Output format: table, json or yaml (the definition only)")
	workflowGetCmd.Flags().Int("version", 0, "Show this version instead of the newest")

	workflowValidateCmd.Flags().String("file", "", "Definition file to check, or - for stdin (required)")
	workflowValidateCmd.Flags().String("output", "table", "Output format: table or json")

	workflowRenderCmd.Flags().String("squad", "", "Squad (name or ID) to address the briefing to")
	workflowRenderCmd.Flags().Int("version", 0, "Render this version instead of the newest")
	workflowRenderCmd.Flags().Bool("labels", false, "Print only the labels the workflow implies, one per line")
	workflowRenderCmd.Flags().String("output", "table", "Output format: table (the text) or json")

	workflowApplyCmd.Flags().String("squad", "", "Squad (name or ID) to apply to (required)")
	workflowApplyCmd.Flags().Int("version", 0, "Apply this version instead of the newest")
	workflowApplyCmd.Flags().Bool("replace", false, "Replace a different workflow the squad already follows")
	workflowApplyCmd.Flags().String("output", "table", "Output format: table or json")

	workflowCmd.AddCommand(workflowListCmd)
	workflowCmd.AddCommand(workflowGetCmd)
	workflowCmd.AddCommand(workflowValidateCmd)
	workflowCmd.AddCommand(workflowRenderCmd)
	workflowCmd.AddCommand(workflowApplyCmd)
}
