package workflow

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The leader briefing is plain text that ends up in a squad's instructions. It
// is built only from a validated definition, and every free-text field is
// neutralised on the way in (see inline and quote), so a definition cannot
// smuggle in a heading, a block marker or an HTML comment.

// RenderLeaderInstructions writes the briefing the squad leader follows to move
// an issue through the workflow. squadName is the squad it is applied to. The
// output depends only on its inputs: same workflow, same text.
func RenderLeaderInstructions(def *Definition, squadName string) string {
	return RenderLeaderInstructionsFor(def, squadName, nil)
}

// RenderLeaderInstructionsFor is RenderLeaderInstructions with the names of the
// people the approver groups list, keyed by the entry as written (user:<id>), so
// the briefing can say who they are. An entry with no name is shown as written.
func RenderLeaderInstructionsFor(def *Definition, squadName string, people map[string]string) string {
	stages := def.OrderedStages()
	id := def.Metadata.ID

	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }

	line("# Workflow leader: %s (version %d)", code(id), def.Metadata.Version)
	line("")
	if d := inline(def.Metadata.Description); d != "" {
		line("%s", d)
		line("")
	}
	line("You lead squad %s. You move issues through the workflow %s one stage at a time. "+
		"You orchestrate: you assign, wait, label and comment. You never do the stage work yourself "+
		"and you never approve for a human.", code(inline(squadName)), code(id))
	line("")
	line("## Rules")
	line("")
	line("1. An issue is in this workflow if it has the label %s. Ignore every other issue.", code(WorkflowLabel(def)))
	line("2. The current stage is the issue's one `phase:` label. If it has none, start it at %s. "+
		"If it has more than one, change nothing and ask a human in a comment to fix the labels.", code(phaseLabel(def.Start)))
	line("3. To move an issue, add the new `phase:` label, then remove the old one, then post ONE comment that records the move, " +
		"such as `Moved from <old> to <new>`. The same comment does what the new stage asks of you, below.")
	line("4. Never skip a stage and never move an issue to a stage that is not listed below.")
	line("5. Keep the issue assigned to this squad and never reassign it. Every new comment on it wakes you while the squad owns it, " +
		"so a person's plain reply reaches you by itself: nobody needs to add a label or mention the squad.")
	line("6. If anything is unclear or a stage is not listed, stop and ask in a comment.")
	line("")
	line("The workflow starts at %s.", code(def.Start))
	line("")
	line("## Stages")
	line("")
	for i, s := range stages {
		for _, l := range stageSection(def, s, i+1, people) {
			line("%s", l)
		}
		line("")
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func stageSection(def *Definition, s Stage, position int, people map[string]string) []string {
	heading := fmt.Sprintf("### %d. %s: %s", position, code(s.ID), inline(stageTitle(s)))
	switch s.Type {
	case StageAgent:
		out := []string{
			heading + " (agent)",
			"",
			"- Label: " + code(phaseLabel(s.ID)),
		}
		assign := fmt.Sprintf("- Delegate to agent %s by @mentioning it in the comment that records the move. "+
			"Use the exact mention markdown for it from the Squad Roster; a plain @name triggers nothing. "+
			"Do not reassign the issue.", code(s.Agent))
		if len(s.Skills) > 0 {
			noun := "skill"
			if len(s.Skills) > 1 {
				noun = "skills"
			}
			names := make([]string, len(s.Skills))
			for i, sk := range s.Skills {
				names[i] = code(inline(sk))
			}
			assign += fmt.Sprintf(" Tell the agent to use the %s %s.", noun, strings.Join(names, ", "))
		}
		out = append(out, assign)
		if strings.TrimSpace(s.ExpectedOutput) != "" {
			out = append(out, "- Tell the agent the expected output is:")
			out = append(out, quote(s.ExpectedOutput)...)
		}
		out = append(out, fmt.Sprintf("- When the agent reports it is done (its reply wakes you), move the issue to %s.", code(s.Next)))
		return out
	case StageHumanGate:
		limit := "There is no rework limit on this gate."
		if s.MaxRework > 0 {
			limit = fmt.Sprintf("Count your earlier comments that start with %s. If there are already %d, "+
				"do not send the issue back again: stop and ask the approvers for a decision in a comment.",
				code("Rework "+s.ID+":"), s.MaxRework)
		}
		out := []string{
			heading + " (human gate)",
			"",
			"- Label: " + code(phaseLabel(s.ID)),
			fmt.Sprintf("- Approvers (group %s): %s.", code(s.Approvers), approverList(def, s.Approvers, people)),
			"- Do not decide anything yourself. Wait for a human.",
			"- In the comment that records the move, mention the approvers (use the Roster's mention markdown) and ask them to reply on " +
				"the issue with their decision in their own words. Nothing else is needed from them.",
			"- You are woken by each comment. Act only on a comment written by a listed approver; a comment from anyone else changes nothing " +
				"(record no_action). Read it and decide:",
			fmt.Sprintf("  - Approved: they clearly approve, with or without remarks. Move to %s.", code(s.OnApprove)),
			fmt.Sprintf("  - Rejected: they clearly refuse or ask for changes. Post a comment starting with %s and their reason, then move to %s. %s",
				code("Rework "+s.ID+":"), code(s.OnReject), limit),
			"  - Anything else (a question, a partial answer, \"maybe\"): do not move the issue; reply once asking what you need to know.",
		}
		if s.EscalateAfterHours > 0 {
			out = append(out, fmt.Sprintf("- If nothing happens within %d hours of entering this stage, "+
				"comment once, mentioning the approvers, asking for a decision.", s.EscalateAfterHours))
		}
		return out
	case StageCondition:
		return []string{
			heading + " (condition)",
			"",
			"- Decide at once; the issue does not wait here and gets no phase label.",
			fmt.Sprintf("- Check the issue's labels against %s.", code(inline(s.When))),
			fmt.Sprintf("- True: move to %s. False: move to %s.", code(s.Then), code(s.Else)),
		}
	default: // StageEnd
		return []string{
			heading + " (end)",
			"",
			"- Label: " + code(phaseLabel(s.ID)),
			"- The workflow is finished. Set the issue status to done and post a closing comment. Do nothing further.",
		}
	}
}

// Labels lists the labels a workflow implies, in a stable order, so a person
// can create them in the workspace. Condition stages are decided in one step
// and never rest on an issue, so they get no phase label.
func Labels(def *Definition) []string {
	labels := []string{WorkflowLabel(def)}
	for _, s := range def.OrderedStages() {
		if s.Type != StageCondition {
			labels = append(labels, phaseLabel(s.ID))
		}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(labels))
	for _, l := range labels {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

// WorkflowLabel is the label that marks an issue as part of the workflow.
func WorkflowLabel(def *Definition) string { return "wf:" + def.Metadata.ID }

func phaseLabel(stageID string) string { return "phase:" + stageID }

func stageTitle(s Stage) string {
	if s.Name != "" {
		return s.Name
	}
	return s.ID
}

func approverList(def *Definition, group string, people map[string]string) string {
	members := def.Approvers[group]
	if len(members) == 0 {
		return "(nobody yet)"
	}
	out := make([]string, len(members))
	for i, m := range members {
		out[i] = code(inline(m))
		if name := inline(people[m]); name != "" {
			out[i] = name + " (" + out[i] + ")"
		}
	}
	return strings.Join(out, ", ")
}

// code writes s as inline code that survives backticks in the value.
func code(s string) string {
	longest, run := 0, 0
	for _, r := range s {
		if r == '`' {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	fence := strings.Repeat("`", longest+1)
	pad := ""
	if strings.HasPrefix(s, "`") || strings.HasSuffix(s, "`") {
		pad = " "
	}
	return fence + pad + s + pad + fence
}

// inline makes free text safe for one line of the briefing: whitespace
// (including newlines) collapses to single spaces, and an HTML comment opener
// is defused so the text can never open or close a marker.
func inline(s string) string {
	return strings.ReplaceAll(strings.Join(strings.Fields(s), " "), "<!--", "&lt;!--")
}

// quote writes multi-line free text as an indented block quote, one "> " line
// per line of text, so it cannot start a heading or a marker line of its own.
func quote(s string) []string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		l = strings.ReplaceAll(strings.TrimRight(l, " \t"), "<!--", "&lt;!--")
		out = append(out, "  > "+l)
	}
	return out
}

// ---- managed block ----------------------------------------------------------

// A squad's instructions may hold text written by people. The briefing lives
// between two marker lines, so applying a workflow replaces only its own part.
const blockEndPrefix = "<!-- workflow-managed:end workflow="

var beginRE = regexp.MustCompile(
	`(?m)^<!-- workflow-managed:begin workflow=([a-z0-9-]+) version=([0-9]+) sha256=([0-9a-f]{64}) -->$`)

// Block describes a managed section found in a squad's instructions.
type Block struct {
	Workflow string
	Version  int
	SHA256   string
}

// WrapBlock puts a briefing between the marker lines. hash is the content hash
// of the workflow version it was rendered from.
func WrapBlock(def *Definition, hash, body string) string {
	return fmt.Sprintf("<!-- workflow-managed:begin workflow=%s version=%d sha256=%s -->\n%s%s%s -->",
		def.Metadata.ID, def.Metadata.Version, hash, body, blockEndPrefix, def.Metadata.ID)
}

// FindBlock locates the managed block in instructions: its description and the
// byte range [start, end) it occupies, markers included. found is false when
// there is none. An opening marker without its closing marker is an error: the
// text was edited by hand, and guessing where the block ends could delete
// someone's writing.
func FindBlock(instructions string) (b Block, start, end int, found bool, err error) {
	loc := beginRE.FindStringSubmatchIndex(instructions)
	if loc == nil {
		if strings.Contains(instructions, "<!-- workflow-managed:begin") {
			return Block{}, 0, 0, false, fmt.Errorf("a workflow marker in the instructions is malformed")
		}
		return Block{}, 0, 0, false, nil
	}
	b.Workflow = instructions[loc[2]:loc[3]]
	b.Version, _ = strconv.Atoi(instructions[loc[4]:loc[5]])
	b.SHA256 = instructions[loc[6]:loc[7]]
	closing := "\n" + blockEndPrefix + b.Workflow + " -->"
	rel := strings.Index(instructions[loc[1]:], closing)
	if rel < 0 {
		return Block{}, 0, 0, false, fmt.Errorf("the workflow block for %q has no closing marker", b.Workflow)
	}
	return b, loc[0], loc[1] + rel + len(closing), true, nil
}

// ApplyBlock returns instructions with block in place of the existing managed
// block, or after the existing text when there is none. Text outside the block
// is untouched.
func ApplyBlock(instructions, block string) (string, error) {
	_, start, end, found, err := FindBlock(instructions)
	if err != nil {
		return "", err
	}
	if found {
		return instructions[:start] + block + instructions[end:], nil
	}
	if strings.TrimSpace(instructions) == "" {
		return block + "\n", nil
	}
	return strings.TrimRight(instructions, "\n") + "\n\n" + block + "\n", nil
}
