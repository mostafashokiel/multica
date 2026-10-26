package workflow

import (
	"reflect"
	"testing"
)

func TestMedianAndPercentile(t *testing.T) {
	if Median(nil) != 0 || Percentile90(nil) != 0 {
		t.Error("no values, no answer")
	}
	if got := Median([]int64{9, 1, 5}); got != 5 {
		t.Errorf("median of three = %d", got)
	}
	if got := Median([]int64{1, 2, 3, 10}); got != 2 { // (2+3)/2 in whole seconds
		t.Errorf("median of four = %d, want the middle pair averaged", got)
	}
	ten := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 100}
	if got := Percentile90(ten); got != 9 { // nearest rank: ceil(0.9*10) = 9th value
		t.Errorf("p90 of ten = %d, want 9", got)
	}
	if got := Percentile90([]int64{7}); got != 7 {
		t.Errorf("p90 of one = %d", got)
	}
}

func TestInsightsSummariseManyRuns(t *testing.T) {
	finished := func(build, wait int64) Timeline {
		return Timeline{
			ElapsedSeconds: build + wait + 10, AgentSeconds: build, PeopleSeconds: wait, HandoffSeconds: 10,
			Visits: []Visit{
				{StageID: "build", Name: "Build", Type: StageAgent, Agent: "dev-agent", AgentSeconds: build, ElapsedSeconds: build},
				{StageID: "code-review", Name: "Code review", Type: StageHumanGate, ElapsedSeconds: wait, WaitSeconds: wait, DecidedAt: ptr(at("10:00:00")), DecidedBy: "user:ann", Outcome: OutcomeApproved},
				{StageID: "done", Type: StageEnd},
			},
		}
	}
	slow := finished(600, 300)
	slow.Reworks = 1
	slow.Visits[1].Outcome = OutcomeRejected
	running := Timeline{
		Open: true, ElapsedSeconds: 1000,
		Visits: []Visit{{StageID: "build", Name: "Build", Type: StageAgent, Agent: "dev-agent", AgentSeconds: 50, ElapsedSeconds: 1000, Open: true}},
	}

	got := BuildInsights([]Timeline{finished(100, 20), finished(200, 40), slow, running, {}}, []string{"build", "code-review", "done"})

	if got.Runs != 4 || got.Finished != 3 || got.Open != 1 || got.Reworks != 1 {
		t.Fatalf("counts = %+v", got)
	}
	if got.MedianElapsedSeconds != 250 || got.P90ElapsedSeconds != 910 {
		t.Errorf("elapsed median %d (want 250), p90 %d (want 910)", got.MedianElapsedSeconds, got.P90ElapsedSeconds)
	}
	var ids []string
	for _, s := range got.Stages {
		ids = append(ids, s.StageID)
	}
	if !reflect.DeepEqual(ids, []string{"build", "code-review"}) {
		t.Errorf("stages follow the workflow's order and leave out the end: %v", ids)
	}
	build := got.Stages[0]
	// The visit still going is counted but does not skew the median.
	if build.Visits != 4 || build.OpenVisits != 1 || build.MedianSeconds != 200 || build.TotalSeconds != 100+200+600+1000 {
		t.Errorf("build = %+v", build)
	}
	if got.BottleneckStageID != "build" {
		t.Errorf("bottleneck = %q, want build (most of the time)", got.BottleneckStageID)
	}
	if got.Stages[1].Rejected != 1 {
		t.Errorf("code-review rejected = %d", got.Stages[1].Rejected)
	}
	if len(got.Agents) != 1 || got.Agents[0].Agent != "dev-agent" || got.Agents[0].Runs != 4 {
		t.Errorf("agents = %+v", got.Agents)
	}
	if len(got.Approvers) != 1 || got.Approvers[0].Ref != "user:ann" || got.Approvers[0].Decisions != 3 || got.Approvers[0].SlowestSeconds != 300 {
		t.Errorf("approvers = %+v", got.Approvers)
	}
}

func TestInsightsForNothingAreEmpty(t *testing.T) {
	got := BuildInsights(nil, nil)
	if got.Runs != 0 || got.BottleneckStageID != "" || len(got.Stages) != 0 {
		t.Errorf("%+v", got)
	}
}
