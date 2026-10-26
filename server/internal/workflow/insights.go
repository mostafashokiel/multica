package workflow

import (
	"math"
	"sort"
)

// StageInsight is how long the issues of a workflow spent in one stage. Medians and the slowest 10% use
// only the visits that are over; a visit still going is counted in Visits and OpenVisits.
type StageInsight struct {
	StageID       string
	Name          string
	Type          string
	Visits        int
	OpenVisits    int
	MedianSeconds int64
	P90Seconds    int64
	TotalSeconds  int64
	Rejected      int // how often a gate here sent the issue back
}

// AgentInsight is how long one agent took per piece of work (a stage it ran alone, or a branch).
type AgentInsight struct {
	Agent         string
	Runs          int
	MedianSeconds int64
	P90Seconds    int64
	TotalSeconds  int64
}

// ApproverInsight is how quickly one person answered at human gates.
type ApproverInsight struct {
	Ref            string // user:<id>
	Decisions      int
	MedianSeconds  int64
	P90Seconds     int64
	SlowestSeconds int64
}

// Insights summarises many runs of one workflow.
type Insights struct {
	Runs                 int
	Finished             int
	Open                 int
	MedianElapsedSeconds int64 // finished runs only
	P90ElapsedSeconds    int64
	MedianAgentSeconds   int64
	MedianPeopleSeconds  int64
	MedianHandoffSeconds int64
	Reworks              int
	// BottleneckStageID is the stage that took the largest share of all the time, "" when nothing was timed.
	BottleneckStageID string
	Stages            []StageInsight
	Agents            []AgentInsight
	Approvers         []ApproverInsight
}

// Median is the middle value, the two middle ones averaged when there is an even number.
func Median(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	v := append([]int64(nil), values...)
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	if n := len(v); n%2 == 1 {
		return v[n/2]
	} else {
		return (v[n/2-1] + v[n/2]) / 2
	}
}

// Percentile90 is the nearest-rank 90th percentile: the smallest value that at least 90% of the values do not exceed.
func Percentile90(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	v := append([]int64(nil), values...)
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	rank := int(math.Ceil(0.9 * float64(len(v))))
	if rank < 1 {
		rank = 1
	}
	return v[rank-1]
}

func sum(values []int64) int64 {
	var t int64
	for _, x := range values {
		t += x
	}
	return t
}

// BuildInsights summarises timelines. order lists the workflow's stage ids in the order they are shown.
func BuildInsights(timelines []Timeline, order []string) Insights {
	var out Insights
	type stageAcc struct {
		name, typ string
		closed    []int64
		visits    int
		open      int
		total     int64
		rejected  int
	}
	stages := map[string]*stageAcc{}
	agents := map[string][]int64{}
	approvers := map[string][]int64{}
	var elapsed, agentSec, peopleSec, handoffSec []int64

	for _, tl := range timelines {
		if len(tl.Visits) == 0 {
			continue
		}
		out.Runs++
		out.Reworks += tl.Reworks
		if tl.Open {
			out.Open++
		} else {
			out.Finished++
			elapsed = append(elapsed, tl.ElapsedSeconds)
			agentSec = append(agentSec, tl.AgentSeconds)
			peopleSec = append(peopleSec, tl.PeopleSeconds)
			handoffSec = append(handoffSec, tl.HandoffSeconds)
		}
		for _, v := range tl.Visits {
			if v.Type == StageEnd {
				continue
			}
			a := stages[v.StageID]
			if a == nil {
				a = &stageAcc{name: v.Name, typ: v.Type}
				stages[v.StageID] = a
			}
			a.visits++
			a.total += v.ElapsedSeconds
			if v.Open {
				a.open++
			} else {
				a.closed = append(a.closed, v.ElapsedSeconds)
			}
			if v.Outcome == OutcomeRejected {
				a.rejected++
			}
			switch v.Type {
			case StageAgent:
				if v.Agent != "" && v.AgentSeconds > 0 {
					agents[v.Agent] = append(agents[v.Agent], v.AgentSeconds)
				}
			case StageParallel:
				for _, b := range v.Branches {
					w := b.WorkSeconds
					if w == 0 {
						w = b.ElapsedSeconds
					}
					if b.Agent != "" && w > 0 {
						agents[b.Agent] = append(agents[b.Agent], w)
					}
				}
			case StageHumanGate:
				if v.DecidedAt != nil && v.DecidedBy != "" {
					approvers[v.DecidedBy] = append(approvers[v.DecidedBy], v.WaitSeconds)
				}
			}
		}
	}

	out.MedianElapsedSeconds, out.P90ElapsedSeconds = Median(elapsed), Percentile90(elapsed)
	out.MedianAgentSeconds, out.MedianPeopleSeconds, out.MedianHandoffSeconds = Median(agentSec), Median(peopleSec), Median(handoffSec)

	seen := map[string]bool{}
	add := func(id string) {
		a := stages[id]
		if a == nil || seen[id] {
			return
		}
		seen[id] = true
		out.Stages = append(out.Stages, StageInsight{
			StageID: id, Name: a.name, Type: a.typ, Visits: a.visits, OpenVisits: a.open,
			MedianSeconds: Median(a.closed), P90Seconds: Percentile90(a.closed), TotalSeconds: a.total, Rejected: a.rejected,
		})
	}
	for _, id := range order {
		add(id)
	}
	var rest []string
	for id := range stages {
		if !seen[id] {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	for _, id := range rest {
		add(id)
	}
	var top int64
	for _, s := range out.Stages {
		if s.TotalSeconds > top {
			top, out.BottleneckStageID = s.TotalSeconds, s.StageID
		}
	}

	for name, v := range agents {
		out.Agents = append(out.Agents, AgentInsight{Agent: name, Runs: len(v), MedianSeconds: Median(v), P90Seconds: Percentile90(v), TotalSeconds: sum(v)})
	}
	sort.Slice(out.Agents, func(i, j int) bool {
		if out.Agents[i].TotalSeconds != out.Agents[j].TotalSeconds {
			return out.Agents[i].TotalSeconds > out.Agents[j].TotalSeconds
		}
		return out.Agents[i].Agent < out.Agents[j].Agent
	})
	for ref, v := range approvers {
		var slowest int64
		for _, x := range v {
			if x > slowest {
				slowest = x
			}
		}
		out.Approvers = append(out.Approvers, ApproverInsight{Ref: ref, Decisions: len(v), MedianSeconds: Median(v), P90Seconds: Percentile90(v), SlowestSeconds: slowest})
	}
	sort.Slice(out.Approvers, func(i, j int) bool {
		if out.Approvers[i].MedianSeconds != out.Approvers[j].MedianSeconds {
			return out.Approvers[i].MedianSeconds > out.Approvers[j].MedianSeconds
		}
		return out.Approvers[i].Ref < out.Approvers[j].Ref
	})
	return out
}
