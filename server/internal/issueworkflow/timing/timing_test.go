package timing

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }
func ptr(sec int) *time.Time {
	v := at(sec)
	return &v
}

// A delivery workflow: an agent builds, an agent reviews (and can send back), a person signs off.
var steps = []Step{
	{Key: "backlog"},
	{Key: "todo"},
	{Key: "in_progress", Handler: HandlerAgent},
	{Key: "in_review", Handler: HandlerAgent, Back: "in_progress"},
	{Key: "qa", Handler: HandlerMember, Back: "in_progress"},
	{Key: "blocked"},
	{Key: "done"},
}

var names = map[string]string{"in_progress": "In Progress", "in_review": "In Review", "qa": "QA"}

// visit returns the nth visit (1-based) to a status.
func visit(t *testing.T, tl Timeline, key string, n int) Visit {
	t.Helper()
	for _, v := range tl.Visits {
		if v.Key == key && v.Number == n {
			return v
		}
	}
	t.Fatalf("no visit %d to %q in %v", n, key, visitKeys(tl))
	return Visit{}
}

func visitKeys(tl Timeline) []string {
	var out []string
	for _, v := range tl.Visits {
		out = append(out, v.Key)
	}
	return out
}

func TestBuildFinishedRun(t *testing.T) {
	tl := Build(Input{
		Steps: steps, Names: names, Created: at(0), CurrentStatus: "done", Now: at(10000),
		Changes: []StatusChange{
			{From: "todo", To: "in_progress", At: at(10)},
			{From: "in_progress", To: "in_review", At: at(610)},
			{From: "in_review", To: "qa", At: at(700)},
			{From: "qa", To: "done", At: at(1500)},
		},
		Runs: []Run{
			{Agent: "dev", Started: at(20), Completed: ptr(600)},
			{Agent: "reviewer", Started: at(615), Completed: ptr(690)},
		},
		Comments: []Comment{{Author: "alice", At: at(1400)}},
	})
	if tl.Open || tl.EndedAt == nil {
		t.Fatalf("a run that reached done must be finished: %+v", tl)
	}
	if tl.ElapsedSeconds != 1500 {
		t.Errorf("elapsed = %d, want 1500", tl.ElapsedSeconds)
	}
	if tl.AgentSeconds != 580+75 {
		t.Errorf("agent = %d, want 655", tl.AgentSeconds)
	}
	// QA was entered at 700 and answered at 1400.
	if tl.PeopleSeconds != 700 {
		t.Errorf("people = %d, want 700", tl.PeopleSeconds)
	}
	if got := tl.AgentSeconds + tl.PeopleSeconds + tl.OtherSeconds; got != tl.ElapsedSeconds {
		t.Errorf("the three parts add up to %d, want %d", got, tl.ElapsedSeconds)
	}
	qa := visit(t, tl, "qa", 1)
	if qa.AnsweredBy != "alice" || qa.WaitSeconds != 700 || qa.ElapsedSeconds != 800 {
		t.Errorf("qa visit = %+v", qa)
	}
	if qa.Outcome != OutcomePassed {
		t.Errorf("qa outcome = %q", qa.Outcome)
	}
}

func TestBuildRunInProgressCountsUpToNow(t *testing.T) {
	tl := Build(Input{
		Steps: steps, Created: at(0), CurrentStatus: "qa", Now: at(5000),
		Changes: []StatusChange{
			{From: "todo", To: "in_progress", At: at(0)},
			{From: "in_progress", To: "qa", At: at(100)},
		},
	})
	if !tl.Open || tl.EndedAt != nil {
		t.Fatalf("an issue waiting at qa is still open: %+v", tl)
	}
	last := tl.Visits[len(tl.Visits)-1]
	if !last.Open || last.Outcome != OutcomeWaiting || last.WaitSeconds != 4900 {
		t.Errorf("open visit = %+v", last)
	}
	if tl.ElapsedSeconds != 5000 {
		t.Errorf("elapsed = %d, want 5000", tl.ElapsedSeconds)
	}
}

func TestBuildSendBackCountsAsRework(t *testing.T) {
	tl := Build(Input{
		Steps: steps, Created: at(0), CurrentStatus: "done", Now: at(9000),
		Changes: []StatusChange{
			{From: "todo", To: "in_progress", At: at(0)},
			{From: "in_progress", To: "in_review", At: at(100)},
			{From: "in_review", To: "in_progress", At: at(200)}, // the reviewer sends it back
			{From: "in_progress", To: "in_review", At: at(300)},
			{From: "in_review", To: "done", At: at(400)},
		},
	})
	if tl.Reworks != 1 {
		t.Fatalf("reworks = %d, want 1", tl.Reworks)
	}
	if v := visit(t, tl, "in_review", 1); v.Outcome != OutcomeSentBack {
		t.Errorf("first review = %+v", v)
	}
	if v := visit(t, tl, "in_review", 2); v.Outcome != OutcomePassed {
		t.Errorf("second review = %+v", v)
	}
	if v := visit(t, tl, "in_progress", 2); v.ElapsedSeconds != 100 {
		t.Errorf("rework visit = %+v", v)
	}
}

func TestBuildBacklogBeforeWorkIsNotPartOfTheRun(t *testing.T) {
	tl := Build(Input{
		Steps: steps, Created: at(0), CurrentStatus: "in_progress", Now: at(2000),
		Changes: []StatusChange{
			{From: "backlog", To: "todo", At: at(1000)},
			{From: "todo", To: "in_progress", At: at(1100)},
		},
	})
	if tl.StartedAt == nil || !tl.StartedAt.Equal(at(1000)) {
		t.Fatalf("started = %v, want the moment it left the backlog", tl.StartedAt)
	}
	if tl.ElapsedSeconds != 1000 {
		t.Errorf("elapsed = %d, want 1000", tl.ElapsedSeconds)
	}
}

func TestBuildAnIssueNeverMovedIsOneVisit(t *testing.T) {
	tl := Build(Input{Steps: steps, Created: at(0), CurrentStatus: "in_progress", Now: at(60)})
	if len(tl.Visits) != 1 || !tl.Open || tl.ElapsedSeconds != 60 {
		t.Fatalf("timeline = %+v", tl)
	}
	if empty := Build(Input{Steps: steps, Created: at(0), CurrentStatus: "backlog", Now: at(60)}); len(empty.Visits) != 0 {
		t.Errorf("an issue that never left the backlog has no run: %+v", empty)
	}
}

func TestBuildBlockedAndUnknownStatusesAreOtherTime(t *testing.T) {
	tl := Build(Input{
		Steps: steps, Created: at(0), CurrentStatus: "done", Now: at(9000),
		Changes: []StatusChange{
			{From: "todo", To: "in_progress", At: at(0)},
			{From: "in_progress", To: "blocked", At: at(100)},
			{From: "blocked", To: "custom", At: at(500)}, // a status the workflow does not list
			{From: "custom", To: "done", At: at(600)},
		},
		Runs: []Run{{Agent: "dev", Started: at(0), Completed: ptr(100)}},
	})
	if tl.AgentSeconds != 100 || tl.PeopleSeconds != 0 || tl.OtherSeconds != 500 {
		t.Errorf("agent %d people %d other %d", tl.AgentSeconds, tl.PeopleSeconds, tl.OtherSeconds)
	}
	if v := visit(t, tl, "blocked", 1); v.Outcome != OutcomePassed || v.Kind != KindOther {
		t.Errorf("blocked visit = %+v", v)
	}
	if v := visit(t, tl, "in_progress", 1); v.Outcome != OutcomeBlocked {
		t.Errorf("a move into blocked is reported as blocked, got %q", v.Outcome)
	}
}

func TestBuildRunsAreClippedToTheVisit(t *testing.T) {
	// A run that started before the visit began and is still going counts only inside it.
	tl := Build(Input{
		Steps: steps, Created: at(0), CurrentStatus: "in_review", Now: at(1000),
		Changes: []StatusChange{
			{From: "todo", To: "in_progress", At: at(0)},
			{From: "in_progress", To: "in_review", At: at(400)},
		},
		Runs: []Run{{Agent: "dev", Started: at(100)}}, // never finished
	})
	if got := visit(t, tl, "in_progress", 1).AgentSeconds; got != 300 {
		t.Errorf("first visit agent = %d, want 300", got)
	}
	if got := visit(t, tl, "in_review", 1).AgentSeconds; got != 600 {
		t.Errorf("second visit agent = %d, want 600", got)
	}
}

func TestSummarise(t *testing.T) {
	run := func(buildEnd, qaAnswer int, author string) Timeline {
		return Build(Input{
			Steps: steps, Names: names, Created: at(0), CurrentStatus: "done", Now: at(99999),
			Changes: []StatusChange{
				{From: "todo", To: "in_progress", At: at(0)},
				{From: "in_progress", To: "qa", At: at(buildEnd)},
				{From: "qa", To: "done", At: at(buildEnd + qaAnswer + 10)},
			},
			Runs:     []Run{{Agent: "dev", Started: at(0), Completed: ptr(buildEnd)}},
			Comments: []Comment{{Author: author, At: at(buildEnd + qaAnswer)}},
		})
	}
	open := Build(Input{Steps: steps, Created: at(0), CurrentStatus: "qa", Now: at(1000),
		Changes: []StatusChange{{From: "todo", To: "in_progress", At: at(0)}, {From: "in_progress", To: "qa", At: at(100)}}})
	in := Summarise([]Timeline{run(100, 50, "alice"), run(300, 100, "alice"), run(200, 400, "bob"), open, {}}, []string{"todo", "in_progress", "in_review", "qa"})

	if in.Runs != 4 || in.Finished != 3 || in.Open != 1 {
		t.Fatalf("runs %d finished %d open %d", in.Runs, in.Finished, in.Open)
	}
	// In Progress was left after 100, 300, 200 and (the open run) 100 seconds.
	if got := in.Steps[1]; got.Key != "in_progress" || got.Visits != 4 || got.MedianSeconds != 150 || got.P90Seconds != 300 {
		t.Fatalf("first step = %+v", got)
	}
	if in.BottleneckKey != "qa" {
		t.Errorf("bottleneck = %q, want qa (it holds the open run's 900s)", in.BottleneckKey)
	}
	if len(in.Steps) != 3 {
		t.Errorf("a step nobody visited is left out: %+v", in.Steps)
	}
	if len(in.People) != 2 || in.People[0].Ref != "bob" || in.People[0].Answers != 1 || in.People[1].Answers != 2 {
		t.Errorf("people = %+v", in.People)
	}
	if len(in.Agents) != 1 || in.Agents[0].Agent != "dev" {
		t.Errorf("agents = %+v", in.Agents)
	}
	if in.MedianElapsedSeconds != Median([]int64{160, 410, 610}) {
		t.Errorf("median elapsed = %d", in.MedianElapsedSeconds)
	}
}

func TestMedianAndPercentile(t *testing.T) {
	if Median(nil) != 0 || Percentile90(nil) != 0 {
		t.Error("empty input gives 0")
	}
	if got := Median([]int64{1, 2, 3, 4}); got != 2 {
		t.Errorf("median of an even count averages the middle pair, got %d", got)
	}
	if got := Median([]int64{9, 1, 5}); got != 5 {
		t.Errorf("median = %d", got)
	}
	ten := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	if got := Percentile90(ten); got != 9 {
		t.Errorf("p90 of 1..10 = %d, want 9 (nearest rank)", got)
	}
}
