package workflow

import (
	"strings"
	"testing"
)

func parseIssues(t *testing.T, src string) []Issue {
	t.Helper()
	def, issues := Parse([]byte(src))
	if len(issues) == 0 {
		t.Fatalf("expected parse issues, got a definition: %+v", def)
	}
	if def != nil {
		t.Error("a failed parse must not return a definition")
	}
	return issues
}

var valid = string(readFileNoT("testdata/fixtures/valid.yaml"))

func TestParseAcceptsValid(t *testing.T) {
	def := mustParse(t, []byte(valid))
	if def.Metadata.ID != "fixture" || len(def.Stages) != 3 || def.Start != "build" {
		t.Errorf("unexpected definition: %+v", def)
	}
}

func TestParseRejections(t *testing.T) {
	cases := map[string]struct{ src, part string }{
		"syntax":              {"apiVersion: [unclosed\nkind: Workflow\n", "yaml:"},
		"empty":               {"", "empty"},
		"not a mapping":       {"- a\n- b\n", "mapping"},
		"plain text":          {"just text\n", "mapping"},
		"unknown key":         {strings.Replace(valid, "kind: Workflow", "kind: Workflow\nkinds: x", 1), "kinds"},
		"wrong version":       {strings.Replace(valid, "composer.noqodi/v1", "composer.noqodi/v2", 1), "apiVersion"},
		"number as text":      {strings.Replace(valid, "next: review", "next: 42", 1), "stages[0].next"},
		"unknown type":        {strings.Replace(valid, "type: end", "type: fan_out", 1), "unknown stage type"},
		"duplicate key":       {strings.Replace(valid, "kind: Workflow", "kind: Workflow\nkind: Workflow", 1), "more than once"},
		"two documents":       {valid + "---\n" + valid, "one YAML document"},
		"anchor":              {strings.Replace(valid, "owner: tester", "owner: &o me", 1), "anchors"},
		"alias":               {strings.Replace(strings.Replace(valid, "owner: tester", "owner: &o me", 1), "leader: lead", "leader: *o", 1), "alias"},
		"merge key":           {strings.Replace(valid, "metadata:", "metadata:\n  <<: {id: x}", 1), "merge"},
		"custom tag":          {strings.Replace(valid, "owner: tester", "owner: !custom me", 1), "tag"},
		"js tag":              {strings.Replace(valid, "owner: tester", "owner: !!js/function 'x'", 1), "tag"},
		"zero version":        {strings.Replace(valid, "version: 1", "version: 0", 1), "greater than zero"},
		"fractional":          {strings.Replace(valid, "version: 1", "version: 1.5", 1), "whole number"},
		"missing field":       {strings.Replace(valid, "    on_reject: build\n", "", 1), "on_reject"},
		"field of other type": {strings.Replace(valid, "    next: review\n", "    next: review\n    on_approve: done\n", 1), "on_approve"},
		"empty skill":         {strings.Replace(valid, "    agent: builder\n", "    agent: builder\n    skills: [\"\"]\n", 1), "must not be empty"},
		"empty stage id":      {strings.Replace(valid, "id: done", "id: \"\"", 1), "must not be empty"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			issues := parseIssues(t, c.src)
			if !hasMessage(issues, c.part) {
				t.Errorf("no issue mentions %q: %+v", c.part, issues)
			}
		})
	}
}

func TestParseReportsPathAndLine(t *testing.T) {
	src := strings.Replace(valid, "next: review", "next: 42", 1)
	issues := parseIssues(t, src)
	if len(issues) != 1 || issues[0].Path != "stages[0].next" {
		t.Fatalf("want one issue at stages[0].next, got %+v", issues)
	}
	want := 0
	for i, line := range strings.Split(src, "\n") {
		if strings.Contains(line, "next: 42") {
			want = i + 1
		}
	}
	if issues[0].Line != want {
		t.Errorf("line %d, want %d", issues[0].Line, want)
	}
}

func TestParseReportsSeveralProblemsAtOnce(t *testing.T) {
	src := strings.Replace(strings.Replace(valid, "next: review", "next: 42", 1), "version: 1", "version: 0", 1)
	if n := len(parseIssues(t, src)); n < 2 {
		t.Errorf("want at least 2 issues, got %d", n)
	}
}

func TestParseSizeLimitIsInBytes(t *testing.T) {
	if _, issues := Parse([]byte("#" + strings.Repeat("x", MaxSourceBytes))); len(issues) == 0 || !strings.Contains(issues[0].Message, "larger than") {
		t.Errorf("oversized input accepted: %+v", issues)
	}
}

func TestParseNeverPanics(t *testing.T) {
	for _, junk := range []string{"\x00", "{{{{", "&", "*", "!", "%YAML 9.9\n---\n", "a: b: c", "\t- x", "? [a]\n: b\n", "a: |\n  x\n b"} {
		Parse([]byte(junk))
	}
}

func TestParseAllowsHalfDrawnDefinitions(t *testing.T) {
	// References may be empty while a workflow is being drawn; Validate reports them.
	src := strings.Replace(strings.Replace(valid, "next: review", `next: ""`, 1), "leader: lead", `leader: ""`, 1)
	def := mustParse(t, []byte(src))
	if def.Stages[0].Next != "" {
		t.Error("empty reference lost")
	}
	if !hasMessage(Validate(def), `unknown stage ""`) {
		t.Error("the empty reference is not reported by Validate")
	}
}
