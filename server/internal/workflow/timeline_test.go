package workflow

import (
	"testing"
	"time"
)

const owner = "user:owner-1"

// A trimmed copy of the SDLC workflow with the stage ids a real run used.
const timingYAML = `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: timing
  version: 1
approvers:
  product: ['user:owner-1']
start: requirements
stages:
  - id: requirements
    type: agent
    agent: PO_Agent
    next: requirements-review
  - id: requirements-review
    type: human_gate
    approvers: product
    on_approve: design
    on_reject: requirements
    max_rework: 3
  - id: design
    type: parallel
    branches:
      - agent: Architect_Agent
      - agent: security-agent
      - agent: qa-agent
    next: design-review
  - id: design-review
    type: human_gate
    approvers: product
    on_approve: build
    on_reject: design
    max_rework: 3
  - id: build
    type: agent
    agent: dev-agent
    next: code-review
  - id: code-review
    type: human_gate
    approvers: product
    on_approve: verify
    on_reject: build
    max_rework: 3
  - id: verify
    type: parallel
    branches:
      - agent: qa-agent
      - agent: security-agent
      - agent: docs-agent
    next: qa-signoff
  - id: qa-signoff
    type: human_gate
    approvers: product
    on_approve: release-prep
    on_reject: build
    max_rework: 3
  - id: release-prep
    type: agent
    agent: release-agent
    next: go-live
  - id: go-live
    type: human_gate
    approvers: product
    on_approve: done
    on_reject: release-prep
    max_rework: 3
  - id: done
    type: end
`

var day = time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)

// at reads "20:55:01" as a time on the day of the run.
func at(hms string) time.Time {
	t, err := time.Parse("15:04:05", hms)
	if err != nil {
		panic(err)
	}
	return day.Add(time.Duration(t.Hour())*time.Hour + time.Duration(t.Minute())*time.Minute + time.Duration(t.Second())*time.Second)
}

func ptr(t time.Time) *time.Time { return &t }

func run(issue, agent, from, to string) AgentRun {
	r := AgentRun{IssueID: issue, Agent: agent, Started: at(from)}
	if to != "" {
		r.Completed = ptr(at(to))
	}
	return r
}

func move(from, to, when string) []StageEvent {
	var out []StageEvent
	if from != "" {
		out = append(out, StageEvent{StageID: from, Kind: StageLeft, At: at(when)})
	}
	return append(out, StageEvent{StageID: to, Kind: StageEntered, At: at(when)})
}

func cat(parts ...[]StageEvent) []StageEvent {
	var out []StageEvent
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// acme21 is the run that was measured by hand: the moves, runs and comments of a real SDLC test.
func acme21(t *testing.T, now string) RunInput {
	t.Helper()
	def := mustParse(t, []byte(timingYAML))
	child := func(id, title, agent, created, closed string) BranchIssue {
		return BranchIssue{ID: id, Identifier: "ACME-" + id, Title: title, Agent: agent, Status: "done", CreatedAt: at(created), ClosedAt: ptr(at(closed)), Closed: true}
	}
	return RunInput{
		Def:     def,
		IssueID: "21",
		Now:     at(now),
		Events: cat(
			move("", "requirements", "20:55:01"),
			move("requirements", "requirements-review", "20:55:40"),
			move("requirements-review", "design", "20:56:14"),
			move("design", "design-review", "20:57:04"),
			move("design-review", "build", "20:58:29"),
			move("build", "code-review", "21:11:58"),
			move("code-review", "verify", "21:15:55"),
			move("verify", "qa-signoff", "21:25:34"),
			move("qa-signoff", "release-prep", "21:27:53"),
			move("release-prep", "go-live", "21:28:46"),
		),
		Runs: []AgentRun{
			// the leader's own runs are on the issue too, and must not count as the stage agents' work
			run("21", "Squad_Orchestrator", "20:54:54", "20:55:04"),
			run("21", "PO_Agent", "20:55:01", "20:55:37"),
			run("22", "Architect_Agent", "20:56:14", "20:57:01"),
			run("23", "security-agent", "20:56:14", "20:56:57"),
			run("24", "qa-agent", "20:56:14", "20:56:50"),
			run("21", "dev-agent", "20:58:29", "21:11:56"),
			run("25", "qa-agent", "21:15:55", "21:25:30"),
			run("26", "security-agent", "21:15:55", "21:18:07"),
			run("27", "docs-agent", "21:15:55", "21:16:43"),
			run("21", "release-agent", "21:27:53", "21:28:43"),
		},
		Children: []BranchIssue{
			child("22", "Design: Solution architecture", "Architect_Agent", "20:56:14", "20:57:01"),
			child("23", "Design: Threat model", "security-agent", "20:56:14", "20:56:57"),
			child("24", "Design: Test strategy", "qa-agent", "20:56:14", "20:56:50"),
			child("25", "Verification: Functional and regression tests", "qa-agent", "21:15:55", "21:25:30"),
			child("26", "Verification: Security scan", "security-agent", "21:15:55", "21:18:07"),
			child("27", "Verification: Documentation", "docs-agent", "21:15:55", "21:16:43"),
		},
		Comments: []Comment{
			{AuthorRef: owner, At: at("20:56:08")},
			{AuthorRef: owner, At: at("20:58:24")},
			{AuthorRef: owner, At: at("21:15:48")},
			{AuthorRef: owner, At: at("21:27:46")},
		},
	}
}

func visitOf(t *testing.T, tl Timeline, stage string) Visit {
	t.Helper()
	for _, v := range tl.Visits {
		if v.StageID == stage {
			return v
		}
	}
	t.Fatalf("no visit to %q in %+v", stage, tl.Visits)
	return Visit{}
}

func TestTimelineOfARealRun(t *testing.T) {
	tl := BuildTimeline(acme21(t, "21:30:46"))

	if len(tl.Visits) != 10 || !tl.Open || tl.EndedAt != nil {
		t.Fatalf("a run waiting at go-live is open with ten visits, got %d open=%v", len(tl.Visits), tl.Open)
	}
	// Stage time is entry to exit, and the open stage counts up to now.
	for stage, want := range map[string]int64{"requirements": 39, "design": 50, "build": 809, "verify": 579, "go-live": 120} {
		if got := visitOf(t, tl, stage).ElapsedSeconds; got != want {
			t.Errorf("%s elapsed = %ds, want %ds", stage, got, want)
		}
	}
	// An agent stage counts its own agent's runs, never the leader's.
	for stage, want := range map[string]int64{"requirements": 36, "build": 807, "release-prep": 50} {
		if got := visitOf(t, tl, stage).AgentSeconds; got != want {
			t.Errorf("%s agent time = %ds, want %ds", stage, got, want)
		}
	}
	// A parallel stage is as long as its slowest branch; the others ran at the same time.
	design, verify := visitOf(t, tl, "design"), visitOf(t, tl, "verify")
	if design.AgentSeconds != 47 || verify.AgentSeconds != 575 {
		t.Errorf("slowest branches: design %d (want 47), verify %d (want 575)", design.AgentSeconds, verify.AgentSeconds)
	}
	if len(design.Branches) != 3 || len(verify.Branches) != 3 {
		t.Fatalf("branches: %d and %d", len(design.Branches), len(verify.Branches))
	}
	if b := verify.Branches[0]; b.Title != "Verification: Functional and regression tests" || b.WorkSeconds != 575 || !b.Closed || b.ElapsedSeconds != 575 {
		t.Errorf("first verify branch = %+v", b)
	}
	// A person's wait ends at their first comment, not when the leader reacted to it.
	for stage, want := range map[string]int64{"requirements-review": 28, "design-review": 80, "code-review": 230, "qa-signoff": 132, "go-live": 120} {
		if got := visitOf(t, tl, stage).WaitSeconds; got != want {
			t.Errorf("%s wait = %ds, want %ds", stage, got, want)
		}
	}
	if g := visitOf(t, tl, "design-review"); g.Outcome != OutcomeApproved || g.DecidedBy != owner {
		t.Errorf("design-review = %+v", g)
	}
	if g := visitOf(t, tl, "go-live"); g.Outcome != OutcomeWaiting || g.DecidedAt != nil {
		t.Errorf("go-live = %+v", g)
	}

	// Totals: 36+47+807+575+50 of agent time, 28+80+230+132+120 of waiting, the rest is handoffs.
	if tl.AgentSeconds != 1515 || tl.PeopleSeconds != 590 {
		t.Errorf("agent %d (want 1515), people %d (want 590)", tl.AgentSeconds, tl.PeopleSeconds)
	}
	if tl.ElapsedSeconds != 2145 || tl.HandoffSeconds != 2145-1515-590 {
		t.Errorf("elapsed %d (want 2145), handoffs %d (want %d)", tl.ElapsedSeconds, tl.HandoffSeconds, 2145-1515-590)
	}
	if tl.AgentSeconds+tl.PeopleSeconds+tl.HandoffSeconds != tl.ElapsedSeconds {
		t.Error("the three parts must add up to the total")
	}
	// Run one after another the six branches would have taken 126s + 755s; in parallel 47s + 575s.
	if want := int64(126-47) + int64(755-575); tl.ParallelSavedSeconds != want {
		t.Errorf("parallel saved %d, want %d", tl.ParallelSavedSeconds, want)
	}
}

func TestTimelineEndsAtTheEndStage(t *testing.T) {
	in := acme21(t, "22:00:00")
	in.Events = append(in.Events, move("go-live", "done", "21:45:00")...)
	in.Comments = append(in.Comments, Comment{AuthorRef: owner, At: at("21:44:30")})

	tl := BuildTimeline(in)

	if tl.Open || tl.EndedAt == nil || !tl.EndedAt.Equal(at("21:45:00")) {
		t.Fatalf("a run that reached the end stage is finished at that moment: %+v", tl.EndedAt)
	}
	if want := int64(seconds(at("21:45:00").Sub(at("20:55:01")))); tl.ElapsedSeconds != want {
		t.Errorf("elapsed = %d, want %d", tl.ElapsedSeconds, want)
	}
	if g := visitOf(t, tl, "go-live"); g.Outcome != OutcomeApproved || g.WaitSeconds != seconds(at("21:44:30").Sub(at("21:28:46"))) {
		t.Errorf("go-live = %+v", g)
	}
	if end := visitOf(t, tl, "done"); end.ElapsedSeconds != 0 || end.Open {
		t.Errorf("the end stage takes no time: %+v", end)
	}
}

func TestTimelineCountsReworkAndNumbersTheVisits(t *testing.T) {
	in := RunInput{
		Def:     mustParse(t, []byte(timingYAML)),
		IssueID: "1",
		Now:     at("10:30:00"),
		Events: cat(
			move("", "build", "10:00:00"),
			move("build", "code-review", "10:05:00"),
			move("code-review", "build", "10:08:00"), // rejected: back to build
			move("build", "code-review", "10:15:00"),
			move("code-review", "verify", "10:16:00"), // approved the second time
		),
		Runs: []AgentRun{run("1", "dev-agent", "10:00:00", "10:04:30"), run("1", "dev-agent", "10:08:00", "10:14:00")},
		Comments: []Comment{
			{AuthorRef: owner, At: at("10:07:00")},
			{AuthorRef: owner, At: at("10:15:30")},
		},
	}

	tl := BuildTimeline(in)

	if tl.Reworks != 1 {
		t.Errorf("reworks = %d, want 1", tl.Reworks)
	}
	var builds, reviews []Visit
	for _, v := range tl.Visits {
		switch v.StageID {
		case "build":
			builds = append(builds, v)
		case "code-review":
			reviews = append(reviews, v)
		}
	}
	if len(builds) != 2 || builds[0].Number != 1 || builds[1].Number != 2 {
		t.Fatalf("builds = %+v", builds)
	}
	if reviews[0].Outcome != OutcomeRejected || reviews[1].Outcome != OutcomeApproved {
		t.Errorf("outcomes = %q then %q", reviews[0].Outcome, reviews[1].Outcome)
	}
	// The second build counts only its own run, the first only its own.
	if builds[0].AgentSeconds != 270 || builds[1].AgentSeconds != 360 {
		t.Errorf("agent time per build = %d and %d", builds[0].AgentSeconds, builds[1].AgentSeconds)
	}
}

func TestTimelineIgnoresWhatDoesNotBelongToAVisit(t *testing.T) {
	in := acme21(t, "21:30:46")
	// a sub-issue from some other time, a run before the stage began, a duplicate entry and a comment by a stranger
	in.Children = append(in.Children, BranchIssue{ID: "99", Title: "Design: late", CreatedAt: at("23:00:00"), Status: "todo"})
	in.Runs = append(in.Runs, run("21", "dev-agent", "20:10:00", "20:20:00"))
	in.Events = append(in.Events, StageEvent{StageID: "build", Kind: StageEntered, At: at("21:00:00")})
	in.Comments = append(in.Comments, Comment{AuthorRef: "user:stranger", At: at("21:12:00")})

	tl := BuildTimeline(in)

	if got := len(visitOf(t, tl, "design").Branches); got != 3 {
		t.Errorf("design has %d branches, want 3", got)
	}
	if got := visitOf(t, tl, "build").AgentSeconds; got != 807 {
		t.Errorf("build agent time = %d, want 807", got)
	}
	if got := visitOf(t, tl, "build").Number; got != 1 {
		t.Errorf("a second entry without leaving is not a new visit, got number %d", got)
	}
	// Someone not on the approver list does not end a gate's wait.
	if got := visitOf(t, tl, "code-review").WaitSeconds; got != 230 {
		t.Errorf("code-review wait = %d, want 230", got)
	}
}

func TestTimelineWithoutEventsIsEmpty(t *testing.T) {
	tl := BuildTimeline(RunInput{Def: mustParse(t, []byte(timingYAML)), Now: at("10:00:00")})
	if len(tl.Visits) != 0 || tl.StartedAt != nil || tl.ElapsedSeconds != 0 {
		t.Errorf("nothing happened: %+v", tl)
	}
}

func TestTimelineKeepsWorkingWithoutADefinition(t *testing.T) {
	in := RunInput{Now: at("10:10:00"), Events: cat(move("", "mystery", "10:00:00"))}
	tl := BuildTimeline(in)
	if len(tl.Visits) != 1 || tl.Visits[0].Name != "mystery" || tl.Visits[0].ElapsedSeconds != 600 || !tl.Open {
		t.Errorf("an unknown stage is still timed: %+v", tl.Visits)
	}
}

func TestAGateWithNoRecognisedApproverEndsWhenTheIssueLeavesIt(t *testing.T) {
	in := acme21(t, "21:30:46")
	in.Comments = nil // nobody on the list wrote anything

	tl := BuildTimeline(in)

	g := visitOf(t, tl, "design-review")
	if g.DecidedAt != nil || g.WaitSeconds != g.ElapsedSeconds {
		t.Errorf("with no decision found the wait is the whole stay: %+v", g)
	}
}

func TestStaysPairEntriesWithExitsAndFindTheCurrentOne(t *testing.T) {
	events := cat(
		move("", "build", "10:00:00"),
		move("build", "review", "10:05:00"),
		move("review", "build", "10:08:00"),
		move("build", "review", "10:15:00"),
	)
	stays := Stays(events)

	if len(stays) != 4 {
		t.Fatalf("stays = %+v", stays)
	}
	cur, ok := CurrentStay(stays)
	if !ok || cur.StageID != "review" || !cur.EnteredAt.Equal(at("10:15:00")) {
		t.Errorf("the current stay is the second visit to review: %+v", cur)
	}
	d := StageDurations(stays)
	if !equalInts(d["build"], []int64{300, 420}) || !equalInts(d["review"], []int64{180}) {
		t.Errorf("finished stays only (the open one is left out): %v", d)
	}
	if _, ok := CurrentStay(Stays(nil)); ok {
		t.Error("no events, no current stay")
	}
}

func equalInts(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

const conditionYAML = `apiVersion: composer.noqodi/v1
kind: Workflow
metadata:
  id: cond
  version: 1
approvers:
  qa: ['user:owner-1']
start: signoff
stages:
  - id: signoff
    type: human_gate
    approvers: qa
    on_approve: risk
    on_reject: build
    max_rework: 2
  - id: risk
    type: condition
    when: has_label("high-risk")
    then: extra
    else: release
  - id: extra
    type: agent
    agent: a
    next: release
  - id: release
    type: agent
    agent: b
    next: done
  - id: build
    type: agent
    agent: c
    next: signoff
  - id: done
    type: end
`

func TestAGateWhoseApprovePathRunsThroughAConditionIsStillApproved(t *testing.T) {
	def := mustParse(t, []byte(conditionYAML))
	for _, c := range []struct{ next, want string }{{"release", OutcomeApproved}, {"extra", OutcomeApproved}, {"build", OutcomeRejected}, {"done", ""}} {
		in := RunInput{Def: def, IssueID: "1", Now: at("12:00:00"), Events: cat(move("", "signoff", "10:00:00"), move("signoff", c.next, "10:05:00"))}
		tl := BuildTimeline(in)
		if got := visitOf(t, tl, "signoff").Outcome; got != c.want {
			t.Errorf("gate followed by %q: outcome %q, want %q", c.next, got, c.want)
		}
	}
}
