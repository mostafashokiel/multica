package workflow

import (
	"math/rand"
	"strings"
	"testing"
)

func TestPilotCanonicalGolden(t *testing.T) {
	def := mustParse(t, readFile(t, "pilot.yaml"))
	got, err := Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	if want := readFile(t, "pilot.canonical.yaml"); string(got) != string(want) {
		t.Errorf("canonical form changed.\n--- got\n%s\n--- want\n%s", got, want)
	}
}

func TestCanonicalIsStableThroughParse(t *testing.T) {
	for _, name := range []string{"valid", "V001.pass", "V005.pass", "V008.pass", "V002.fail", "V003.fail"} {
		first, err := Marshal(fixture(t, name))
		if err != nil {
			t.Fatal(err)
		}
		again, err := Marshal(mustParse(t, first))
		if err != nil {
			t.Fatal(err)
		}
		if string(first) != string(again) {
			t.Errorf("%s: not stable.\n%s\nvs\n%s", name, first, again)
		}
		if !strings.HasSuffix(string(first), "\n") || strings.HasSuffix(string(first), "\n\n") {
			t.Errorf("%s: must end with exactly one newline", name)
		}
	}
}

func TestCanonicalIgnoresInputOrder(t *testing.T) {
	def := mustParse(t, readFile(t, "pilot.yaml"))
	want, _ := Marshal(def)
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 50; i++ {
		shuffled := *def
		shuffled.Stages = append([]Stage(nil), def.Stages...)
		rng.Shuffle(len(shuffled.Stages), func(a, b int) { shuffled.Stages[a], shuffled.Stages[b] = shuffled.Stages[b], shuffled.Stages[a] })
		got, _ := Marshal(&shuffled)
		if string(got) != string(want) {
			t.Fatalf("shuffle %d changed the output", i)
		}
	}
}

func TestStageOrderFollowsTheMainPathThenReworkThenOrphans(t *testing.T) {
	def := &Definition{Start: "c", Approvers: map[string][]string{"g": {"u"}}, Stages: []Stage{
		{ID: "z-end", Type: StageEnd},
		{ID: "b", Type: StageAgent, Agent: "a", Next: "z-end"},
		{ID: "c", Type: StageCondition, When: "x", Then: "b", Else: "a"},
		{ID: "a", Type: StageAgent, Agent: "a", Next: "gate"},
		{ID: "gate", Type: StageHumanGate, Approvers: "g", OnApprove: "z-end", OnReject: "c"},
		{ID: "orphan-2", Type: StageEnd},
		{ID: "orphan-1", Type: StageEnd},
	}}
	var ids []string
	for _, s := range def.OrderedStages() {
		ids = append(ids, s.ID)
	}
	if got, want := strings.Join(ids, " "), "c a gate z-end b orphan-1 orphan-2"; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestDuplicateIdsAreKeptNotDropped(t *testing.T) {
	def := fixture(t, "valid")
	def.Stages = append(def.Stages, Stage{ID: "build", Type: StageEnd})
	if n := len(def.OrderedStages()); n != 4 {
		t.Errorf("%d stages, want 4", n)
	}
}

func TestApproverGroupsOrderedByFirstUse(t *testing.T) {
	def := fixture(t, "valid")
	def.Approvers = map[string][]string{"zeta": {"z"}, "unused": {}, "qa": {"r"}, "10": {"x"}, "2": {"y"}}
	out, err := Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	last := -1
	for _, key := range []string{"\n  qa:", "\n  \"10\":", "\n  \"2\":", "\n  unused:", "\n  zeta:"} {
		at := strings.Index(text, key)
		if at < 0 || at < last {
			t.Fatalf("group %q out of order or missing in:\n%s", key, text)
		}
		last = at
	}
}

// Text a person might type into a name or description must survive a round trip.
func TestHostileStringsRoundTrip(t *testing.T) {
	nasty := []string{
		"", " lead", "trail ", "yes", "no", "null", "~", "true", "123", "1e3", "0x1F", ".5", "2026-10-07",
		"#x", "a #b", "- a", "a: b", "a:b", ":", "?", "-", "|", ">", "{x}", "[x]", "'q'", `"q"`, "&a", "*a", "!t",
		"@x", "%x", "a\nb", "a\n", "\na", "tab\there", "é", "日本", `has_label("x") and not has_label("y")`,
		"user:<id>", "<<", "---", "...", "line1\nline2: still text\n  indented",
	}
	for _, s := range nasty {
		def := fixture(t, "valid")
		def.Metadata.Description = s
		def.Stages[0].Name = s
		def.Stages[0].ExpectedOutput = s
		def.Stages[0].Skills = []string{"skill-" + s}
		def.Approvers = map[string][]string{"qa": {s + "x", "user:1"}}
		out, err := Marshal(def)
		if err != nil {
			t.Fatalf("%q: %v", s, err)
		}
		back, issues := Parse(out)
		if len(issues) > 0 {
			t.Fatalf("%q: output does not parse: %+v\n%s", s, issues, out)
		}
		if back.Metadata.Description != s || back.Stages[0].Name != s || back.Stages[0].ExpectedOutput != s ||
			back.Stages[0].Skills[0] != "skill-"+s || back.Approvers["qa"][0] != s+"x" {
			t.Errorf("%q changed in a round trip.\n%s", s, out)
		}
		if again, _ := Marshal(back); string(again) != string(out) {
			t.Errorf("%q: not stable", s)
		}
	}
}

func TestContentHashFollowsTheCanonicalText(t *testing.T) {
	def := mustParse(t, readFile(t, "pilot.yaml"))
	a, _ := Marshal(def)
	def.Metadata.Version = 2
	b, _ := Marshal(def)
	if h := ContentHash(a); len(h) != 64 || h == ContentHash(b) {
		t.Errorf("hash of %d chars, equal to the changed one: %v", len(h), h == ContentHash(b))
	}
	if ContentHash(a) != ContentHash(append([]byte(nil), a...)) {
		t.Error("hash is not deterministic")
	}
}
