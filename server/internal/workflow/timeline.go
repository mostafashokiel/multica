package workflow

import (
	"sort"
	"time"
)

// This file measures how long a run of a workflow took, from facts the rest of Multica already records:
// when the issue entered and left each stage (the phase:* label), when each agent run started and ended,
// and when people commented. It is pure: the caller reads the rows, this turns them into a timeline.
//
// What is counted, and why:
//   - A stage's time is from entering it to leaving it (still counting if the issue is there now).
//   - Agent time is the time agents spent working on the critical path: in an agent stage the stage
//     agent's runs, in a parallel stage the slowest branch (the others ran at the same time).
//   - People time is the wait at a human gate: from entering it to the first comment of a listed approver,
//     not to the moment the leader reacted to that comment.
//   - Handoffs are what is left of the total: the leader's own work and the gaps between steps.

// Stage event kinds, as recorded in workflow_stage_event.
const (
	StageEntered = "entered"
	StageLeft    = "left"
)

// StageEvent is the issue entering or leaving a stage.
type StageEvent struct {
	StageID string
	Kind    string
	At      time.Time
}

// AgentRun is one run of an agent on an issue. A run that has not finished has no Completed time and
// counts up to now.
type AgentRun struct {
	IssueID   string
	Agent     string
	Started   time.Time
	Completed *time.Time
}

// BranchIssue is a sub-issue the leader created for one branch of a parallel stage.
type BranchIssue struct {
	ID         string
	Identifier string
	Title      string
	Agent      string // the agent it is assigned to; may be empty
	Status     string
	CreatedAt  time.Time
	ClosedAt   *time.Time
	Closed     bool
	Cancelled  bool
}

// Comment is a comment a person wrote on the issue. AuthorRef is user:<id>.
type Comment struct {
	AuthorRef string
	At        time.Time
}

// RunInput is everything the timeline of one issue is built from.
type RunInput struct {
	Def      *Definition
	Events   []StageEvent
	Runs     []AgentRun // runs on the issue and on its sub-issues, told apart by IssueID
	IssueID  string
	Children []BranchIssue
	Comments []Comment
	Now      time.Time
}

// BranchRun is one branch of a parallel visit, as it ran.
type BranchRun struct {
	ID             string
	Identifier     string
	Title          string
	Agent          string
	Status         string
	StartedAt      time.Time
	EndedAt        *time.Time
	WorkSeconds    int64 // agent runs
	ElapsedSeconds int64 // created to closed (or now)
	Closed         bool
	Cancelled      bool
}

// Visit is one stay of the issue in one stage. An issue sent back for rework visits a stage again.
type Visit struct {
	StageID        string
	Name           string
	Type           string
	Number         int // 1 for the first visit to this stage, 2 after a rework
	EnteredAt      time.Time
	LeftAt         *time.Time
	Open           bool
	ElapsedSeconds int64

	// agent and parallel stages
	Agent        string
	AgentSeconds int64
	Branches     []BranchRun

	// human gates
	WaitSeconds int64
	DecidedAt   *time.Time
	DecidedBy   string // user:<id> of the first approver who commented, when there is one
	Outcome     string // approved, rejected, waiting or ""
}

// Timeline is the whole run of one issue.
type Timeline struct {
	Visits               []Visit
	StartedAt            *time.Time
	EndedAt              *time.Time // set when the run reached its end stage
	Open                 bool       // not finished: totals count up to now
	ElapsedSeconds       int64
	AgentSeconds         int64
	PeopleSeconds        int64
	HandoffSeconds       int64
	Reworks              int
	ParallelSavedSeconds int64 // time the parallel stages saved against running every branch one after another
}

// Outcomes of a human gate.
const (
	OutcomeApproved = "approved"
	OutcomeRejected = "rejected"
	OutcomeWaiting  = "waiting"
)

// slack is how much earlier than its stage's entry a sub-issue may have been created: the leader makes
// them in the same step that moves the issue.
const slack = 30 * time.Second

func seconds(d time.Duration) int64 {
	if d < 0 {
		return 0
	}
	return int64(d / time.Second)
}

// BuildTimeline measures one run. It never fails: facts that are missing show up as zeros, not errors.
func BuildTimeline(in RunInput) Timeline {
	stages := map[string]Stage{}
	if in.Def != nil {
		for _, s := range in.Def.Stages {
			stages[s.ID] = s
		}
	}
	events := append([]StageEvent(nil), in.Events...)
	sort.SliceStable(events, func(i, j int) bool { return events[i].At.Before(events[j].At) })

	// Pair every entry with the next exit of the same stage.
	var visits []Visit
	open := map[string]int{} // stage id -> index of its open visit
	count := map[string]int{}
	for _, e := range events {
		switch e.Kind {
		case StageEntered:
			if _, already := open[e.StageID]; already {
				continue // the label was added twice
			}
			count[e.StageID]++
			s := stages[e.StageID]
			name := s.Name
			if name == "" {
				name = e.StageID
			}
			visits = append(visits, Visit{StageID: e.StageID, Name: name, Type: s.Type, Number: count[e.StageID], EnteredAt: e.At, Open: true})
			open[e.StageID] = len(visits) - 1
		case StageLeft:
			if i, ok := open[e.StageID]; ok {
				left := e.At
				visits[i].LeftAt, visits[i].Open = &left, false
				delete(open, e.StageID)
			}
		}
	}

	var tl Timeline
	if len(visits) == 0 {
		return tl
	}
	first := visits[0].EnteredAt
	tl.StartedAt = &first

	var saved int64
	for i := range visits {
		v := &visits[i]
		s := stages[v.StageID]
		end := in.Now
		if v.LeftAt != nil {
			end = *v.LeftAt
		}
		// The end stage rests nowhere: reaching it finishes the run.
		if v.Type == StageEnd {
			v.Open = false
			v.LeftAt = nil
			end = v.EnteredAt
		}
		v.ElapsedSeconds = seconds(end.Sub(v.EnteredAt))

		switch v.Type {
		case StageAgent:
			v.Agent = s.Agent
			v.AgentSeconds = agentSeconds(in.Runs, in.IssueID, s.Agent, v.EnteredAt, end, in.Now)
		case StageParallel:
			v.Branches = branchesOf(in, v.EnteredAt, end)
			var longest, sum int64
			for _, b := range v.Branches {
				w := b.WorkSeconds
				if w == 0 {
					w = b.ElapsedSeconds
				}
				sum += w
				if w > longest {
					longest = w
				}
			}
			v.AgentSeconds = longest
			saved += sum - longest
		case StageHumanGate:
			decided, by := firstDecision(in, s, v.EnteredAt, end)
			waitEnd := end
			if decided != nil {
				waitEnd = *decided
				v.DecidedAt, v.DecidedBy = decided, by
			}
			v.WaitSeconds = seconds(waitEnd.Sub(v.EnteredAt))
			v.Outcome = outcomeOf(visits, i, s, stages)
		}
	}

	// Rework: a gate that sent the issue back.
	for _, v := range visits {
		if v.Outcome == OutcomeRejected {
			tl.Reworks++
		}
	}

	last := visits[len(visits)-1]
	switch {
	case last.Type == StageEnd:
		ended := last.EnteredAt
		tl.EndedAt = &ended
		tl.ElapsedSeconds = seconds(ended.Sub(first))
	default:
		tl.Open = true
		tl.ElapsedSeconds = seconds(in.Now.Sub(first))
	}
	for _, v := range visits {
		tl.AgentSeconds += v.AgentSeconds
		tl.PeopleSeconds += v.WaitSeconds
	}
	tl.HandoffSeconds = tl.ElapsedSeconds - tl.AgentSeconds - tl.PeopleSeconds
	if tl.HandoffSeconds < 0 {
		tl.HandoffSeconds = 0
	}
	tl.ParallelSavedSeconds = saved
	tl.Visits = visits
	return tl
}

// agentSeconds adds up the runs of one agent on the issue that began inside the visit, each clipped to it.
func agentSeconds(runs []AgentRun, issueID, agent string, from, to, now time.Time) int64 {
	var total int64
	for _, r := range runs {
		if r.IssueID != issueID || r.Agent != agent || r.Started.Before(from) || r.Started.After(to) {
			continue
		}
		total += runSeconds(r, now)
	}
	return total
}

func runSeconds(r AgentRun, now time.Time) int64 {
	end := now
	if r.Completed != nil {
		end = *r.Completed
	}
	return seconds(end.Sub(r.Started))
}

// branchesOf lists the sub-issues the leader made for a parallel visit.
func branchesOf(in RunInput, from, to time.Time) []BranchRun {
	var out []BranchRun
	for _, c := range in.Children {
		if c.CreatedAt.Before(from.Add(-slack)) || c.CreatedAt.After(to.Add(slack)) {
			continue
		}
		b := BranchRun{ID: c.ID, Identifier: c.Identifier, Title: c.Title, Agent: c.Agent, Status: c.Status, StartedAt: c.CreatedAt, Closed: c.Closed, Cancelled: c.Cancelled}
		end := in.Now
		if c.Closed && c.ClosedAt != nil {
			end = *c.ClosedAt
			b.EndedAt = c.ClosedAt
		}
		b.ElapsedSeconds = seconds(end.Sub(c.CreatedAt))
		for _, r := range in.Runs {
			if r.IssueID == c.ID {
				b.WorkSeconds += runSeconds(r, in.Now)
				if b.Agent == "" {
					b.Agent = r.Agent
				}
			}
		}
		out = append(out, b)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// firstDecision is the first comment by someone on the gate's approver list after the gate was entered.
// When the group has no one who can be recognised by id, any person's first comment counts.
func firstDecision(in RunInput, gate Stage, from, to time.Time) (*time.Time, string) {
	var listed map[string]bool
	if in.Def != nil {
		for _, ref := range in.Def.Approvers[gate.Approvers] {
			if listed == nil {
				listed = map[string]bool{}
			}
			listed[ref] = true
		}
	}
	comments := append([]Comment(nil), in.Comments...)
	sort.SliceStable(comments, func(i, j int) bool { return comments[i].At.Before(comments[j].At) })
	for _, c := range comments {
		// Only comments from while the issue was at the gate (a little after it left, for the leader's reaction).
		if !c.At.After(from) || (!to.Equal(in.Now) && c.At.After(to.Add(slack))) {
			continue
		}
		if listed != nil && !listed[c.AuthorRef] {
			continue
		}
		at := c.At
		return &at, c.AuthorRef
	}
	return nil, ""
}

// outcomeOf says how a gate ended, from where the issue went next. A condition rests nowhere (it has no
// label), so a path that runs through one counts as leading to whatever the condition leads to.
func outcomeOf(visits []Visit, i int, gate Stage, stages map[string]Stage) string {
	if visits[i].Open {
		return OutcomeWaiting
	}
	if i+1 >= len(visits) {
		return ""
	}
	next := visits[i+1].StageID
	switch {
	case leadsTo(stages, gate.OnApprove, next):
		return OutcomeApproved
	case leadsTo(stages, gate.OnReject, next):
		return OutcomeRejected
	}
	return ""
}

// leadsTo reports whether stage `from` is `target`, or is a condition (or a chain of them) that can lead to it.
func leadsTo(stages map[string]Stage, from, target string) bool {
	seen := map[string]bool{}
	var walk func(id string) bool
	walk = func(id string) bool {
		if id == target {
			return true
		}
		s, known := stages[id]
		if !known || s.Type != StageCondition || seen[id] {
			return false
		}
		seen[id] = true
		return walk(s.Then) || walk(s.Else)
	}
	return walk(from)
}

// StageStay is one stay in a stage, before anything else is known about it.
type StageStay struct {
	StageID   string
	EnteredAt time.Time
	LeftAt    *time.Time
}

// Stays pairs the entries and exits of one issue into stays, oldest first. It needs only the events, so
// it is cheap enough to run for every issue of a workflow when a page is refreshed.
func Stays(events []StageEvent) []StageStay {
	sorted := append([]StageEvent(nil), events...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At.Before(sorted[j].At) })
	var out []StageStay
	open := map[string]int{}
	for _, e := range sorted {
		switch e.Kind {
		case StageEntered:
			if _, already := open[e.StageID]; already {
				continue
			}
			out = append(out, StageStay{StageID: e.StageID, EnteredAt: e.At})
			open[e.StageID] = len(out) - 1
		case StageLeft:
			if i, ok := open[e.StageID]; ok {
				left := e.At
				out[i].LeftAt = &left
				delete(open, e.StageID)
			}
		}
	}
	return out
}

// CurrentStay is the stay the issue is in now: the newest one that has not ended, if any.
func CurrentStay(stays []StageStay) (StageStay, bool) {
	for i := len(stays) - 1; i >= 0; i-- {
		if stays[i].LeftAt == nil {
			return stays[i], true
		}
	}
	return StageStay{}, false
}

// StageDurations collects, per stage, how long each finished stay lasted, in seconds. stays holds the
// stays of many issues.
func StageDurations(stays []StageStay) map[string][]int64 {
	out := map[string][]int64{}
	for _, s := range stays {
		if s.LeftAt != nil {
			out[s.StageID] = append(out[s.StageID], seconds(s.LeftAt.Sub(s.EnteredAt)))
		}
	}
	return out
}
