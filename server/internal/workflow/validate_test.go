package workflow

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

var rules = []string{"V001", "V002", "V003", "V004", "V005", "V006", "V008"}

func TestValidAndPilot(t *testing.T) {
	if issues := Validate(fixture(t, "valid")); len(issues) != 0 {
		t.Fatalf("valid fixture has issues: %+v", issues)
	}
	pilot := mustParse(t, readFile(t, "pilot.yaml"))
	if issues := Validate(pilot); len(issues) != 0 {
		t.Fatalf("pilot has issues: %+v", issues)
	}
}

// Each rule has a passing and a failing fixture, shared with the TypeScript
// prototype so both implementations are held to the same expectations.
func TestRuleFixtures(t *testing.T) {
	// A failing fixture breaks its own rule plus the knock-ons listed here
	// (a dangling reference also leaves a stage unreachable, and so on).
	expected := map[string][]string{
		"V001": {"V001", "V003"},
		"V002": {"V002", "V003", "V004"},
		"V003": {"V003"},
		"V004": {"V003", "V004"},
		"V005": {"V005"},
		"V006": {"V006"},
		"V008": {"V008"},
	}
	for _, rule := range rules {
		t.Run(rule, func(t *testing.T) {
			pass := codes(Validate(fixture(t, rule+".pass")))
			for _, c := range pass {
				if c == rule {
					t.Errorf("%s.pass reports %s", rule, rule)
				}
			}
			fail := codes(Validate(fixture(t, rule+".fail")))
			if !reflect.DeepEqual(fail, expected[rule]) {
				t.Errorf("%s.fail reports %v, want %v", rule, fail, expected[rule])
			}
		})
	}
}

func TestReturnsEveryProblemNotJustTheFirst(t *testing.T) {
	def := fixture(t, "valid")
	def.Stages = append(def.Stages, Stage{ID: "Bad_Id", Type: StageAgent, Agent: "a", Next: "nowhere"})
	got := codes(Validate(def))
	for _, want := range []string{"V001", "V002", "V003", "V004"} {
		found := false
		for _, c := range got {
			found = found || c == want
		}
		if !found {
			t.Errorf("missing %s in %v", want, got)
		}
	}
}

func TestValidateDoesNotMutateAndIsDeterministic(t *testing.T) {
	def := fixture(t, "V002.fail")
	before := fmt.Sprintf("%+v", *def)
	first, second := Validate(def), Validate(def)
	if !reflect.DeepEqual(first, second) {
		t.Error("two runs differ")
	}
	if fmt.Sprintf("%+v", *def) != before {
		t.Error("Validate changed its input")
	}
}

func TestV001(t *testing.T) {
	def := fixture(t, "valid")
	def.Stages = append(def.Stages,
		Stage{ID: "done", Type: StageEnd}, Stage{ID: "done", Type: StageEnd}, // twice more: reported once
		Stage{ID: strings.Repeat("x", 41), Type: StageEnd}, Stage{ID: "a--b", Type: StageEnd},
		Stage{ID: "-a", Type: StageEnd}, Stage{ID: "a b", Type: StageEnd}, Stage{ID: "", Type: StageEnd})
	var dup, long, kebab int
	for _, i := range Validate(def) {
		if i.Code != "V001" {
			continue
		}
		switch {
		case strings.Contains(i.Message, "more than once"):
			dup++
		case strings.Contains(i.Message, "longer than 40"):
			long++
		case strings.Contains(i.Message, "kebab-case"):
			kebab++
		}
	}
	if dup != 1 || long != 1 || kebab != 4 {
		t.Errorf("duplicates=%d long=%d kebab=%d, want 1, 1, 4", dup, long, kebab)
	}
	if !ValidID(strings.Repeat("a", 40)) || ValidID(strings.Repeat("a", 41)) || ValidID("A") || ValidID("") {
		t.Error("ValidID disagrees with the rule")
	}
}

func TestV002NamesTheFieldOfEachBadReference(t *testing.T) {
	def := &Definition{Start: "nope", Approvers: map[string][]string{"qa": {"u"}}, Stages: []Stage{
		{ID: "a", Type: StageAgent, Agent: "x", Next: "b"},
		{ID: "g", Type: StageHumanGate, Approvers: "qa", OnApprove: "zz", OnReject: "d"},
		{ID: "c", Type: StageCondition, When: `has_label("x")`, Then: "e", Else: "f"},
	}}
	var got []string
	for _, i := range Validate(def) {
		if i.Code == "V002" {
			got = append(got, i.StageID+"."+i.Field)
		}
	}
	want := []string{".start", "a.next", "g.on_approve", "g.on_reject", "c.then", "c.else"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestV003SkippedWithoutAStart(t *testing.T) {
	def := fixture(t, "valid")
	def.Start = "nope"
	for _, c := range codes(Validate(def)) {
		if c == "V003" {
			t.Error("V003 should not pile on when start is unknown")
		}
	}
}

func TestV004(t *testing.T) {
	noEnd := fixture(t, "valid")
	noEnd.Stages = noEnd.Stages[:2] // build, review
	noEnd.Stages[1].OnApprove = "build"
	var v4 []Issue
	for _, i := range Validate(noEnd) {
		if i.Code == "V004" {
			v4 = append(v4, i)
		}
	}
	if len(v4) != 1 || v4[0].Message != "The workflow has no end stage" {
		t.Errorf("want a single no-end issue, got %+v", v4)
	}

	stuck := fixture(t, "valid")
	stuck.Stages = append(stuck.Stages,
		Stage{ID: "loop-a", Type: StageAgent, Agent: "x", Next: "loop-b"},
		Stage{ID: "loop-b", Type: StageAgent, Agent: "x", Next: "loop-a"})
	var ids []string
	for _, i := range Validate(stuck) {
		if i.Code == "V004" {
			ids = append(ids, i.StageID)
		}
	}
	if !reflect.DeepEqual(ids, []string{"loop-a", "loop-b"}) {
		t.Errorf("stuck stages: %v", ids)
	}
}

func TestV005(t *testing.T) {
	self := fixture(t, "valid")
	self.Stages = append(self.Stages, Stage{ID: "spin", Type: StageAgent, Agent: "x", Next: "spin"})
	count := 0
	for _, i := range Validate(self) {
		if i.Code == "V005" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("self loop: %d V005 issues, want 1", count)
	}

	agentLoop := fixture(t, "valid")
	agentLoop.Stages[0].Next = "build" // build -> build, next to a bounded gate
	var ids []string
	for _, i := range Validate(agentLoop) {
		if i.Code == "V005" {
			ids = append(ids, i.StageID)
		}
	}
	if !reflect.DeepEqual(ids, []string{"build"}) {
		t.Errorf("agent-only loop: %v", ids)
	}
}

func TestV005LongChainDoesNotOverflow(t *testing.T) {
	const n = 20000
	def := &Definition{Start: "s0", Approvers: map[string][]string{}}
	for i := 0; i < n; i++ {
		def.Stages = append(def.Stages, Stage{
			ID: fmt.Sprintf("s%d", i), Type: StageAgent, Agent: "a", Next: fmt.Sprintf("s%d", (i+1)%n),
		})
	}
	count := 0
	for _, i := range Validate(def) {
		if i.Code == "V005" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("one ring, got %d V005 issues", count)
	}
}

func TestV006(t *testing.T) {
	def := fixture(t, "valid")
	def.Approvers = map[string][]string{"qa": {}}
	if !hasMessage(Validate(def), "no members") {
		t.Error("empty group not reported")
	}
	def.Approvers = map[string][]string{}
	if !hasMessage(Validate(def), "is not defined") {
		t.Error("missing group not reported")
	}
}
