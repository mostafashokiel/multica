// Package timing measures how long issues spend in the steps of a project workflow (MUL-7420).
//
// It is pure: the caller reads the rows Multica already records (the issue's status changes from
// activity_log, its agent runs, the comments people wrote) and this turns them into a timeline of one
// issue and a summary of many. Nothing is stored, so nothing here can drift from the issue itself.
//
// What is counted, and why:
//   - A visit is one stay in one status, from entering it to leaving it (still counting if the issue is there now).
//   - Agent time is what agents spent running on the issue during a visit.
//   - People time is the wait at a step a person handles: from entering it to that person's first comment,
//     or to leaving it when nobody commented.
//   - Everything else (queueing, handoffs, blocked, parked and unassigned steps) is "other".
package timing

import (
	"math"
	"sort"
	"time"
)

// Handler types, as the workflow stores them.
const (
	HandlerNone        = "none"
	HandlerAgent       = "agent"
	HandlerSquad       = "squad"
	HandlerMember      = "member"
	HandlerProjectLead = "project_lead"
	HandlerCreator     = "creator"
)

// Kinds of visit, by who is expected to move the issue on.
const (
	KindAgent  = "agent"  // handed to an agent or a squad
	KindPerson = "person" // handed to a member, the project lead or the creator
	KindOther  = "other"  // no handoff, blocked
	KindParked = "parked" // backlog: not counted as work
	KindEnd    = "end"    // done or cancelled: reaching it finishes the run
)

// Outcomes of a visit that is over.
const (
	OutcomePassed   = "passed"    // the issue moved on
	OutcomeSentBack = "sent_back" // the issue went to the step's "if rejected" status
	OutcomeBlocked  = "blocked"
	OutcomeWaiting  = "waiting" // the issue is still here
)

const (
	statusBacklog   = "backlog"
	statusBlocked   = "blocked"
	statusDone      = "done"
	statusCancelled = "cancelled"
)

// slack is how much later than leaving a step a person's comment may still count as their answer to it.
const slack = 30 * time.Second

// Step is what the timeline needs to know about one step of the workflow.
type Step struct {
	Key     string
	Handler string
	Back    string // the "if rejected, send back to" status; "" when unset
}

// StatusChange is the issue moving from one status to another.
type StatusChange struct {
	From string
	To   string
	At   time.Time
}

// Run is one run of an agent on the issue. A run that has not finished has no Completed time and counts up to Now.
type Run struct {
	Agent     string
	Started   time.Time
	Completed *time.Time
}

// Comment is a comment a person wrote on the issue.
type Comment struct {
	Author string
	At     time.Time
}

// Input is everything the timeline of one issue is built from.
type Input struct {
	Steps         []Step
	Names         map[string]string // status key -> display name; the key is used when missing
	Created       time.Time
	CurrentStatus string
	Changes       []StatusChange
	Runs          []Run
	Comments      []Comment
	Now           time.Time
}

// Visit is one stay of the issue in one status. An issue sent back for rework visits a status again.
type Visit struct {
	Key            string
	Name           string
	Kind           string
	Handler        string
	Number         int // 1 for the first visit to this status, 2 after a rework
	EnteredAt      time.Time
	LeftAt         *time.Time
	Open           bool
	ElapsedSeconds int64
	AgentSeconds   int64
	Agents         []string
	WaitSeconds    int64 // person steps: until their first comment, or until the issue left
	AnsweredAt     *time.Time
	AnsweredBy     string
	Outcome        string
}

// Timeline is the whole run of one issue.
type Timeline struct {
	Visits         []Visit
	StartedAt      *time.Time
	EndedAt        *time.Time // set when the issue reached done or cancelled
	Open           bool       // not finished: totals count up to Now
	ElapsedSeconds int64
	AgentSeconds   int64
	PeopleSeconds  int64
	OtherSeconds   int64
	Reworks        int
}

func seconds(d time.Duration) int64 {
	if d < 0 {
		return 0
	}
	return int64(d / time.Second)
}

func kindOf(key, handler string, known bool) string {
	switch key {
	case statusBacklog:
		return KindParked
	case statusDone, statusCancelled:
		return KindEnd
	case statusBlocked:
		return KindOther
	}
	if !known {
		return KindOther
	}
	switch handler {
	case HandlerAgent, HandlerSquad:
		return KindAgent
	case HandlerMember, HandlerProjectLead, HandlerCreator:
		return KindPerson
	}
	return KindOther
}

// Build measures one issue. It never fails: facts that are missing show up as zeros, not errors.
func Build(in Input) Timeline {
	steps := map[string]Step{}
	for _, s := range in.Steps {
		steps[s.Key] = s
	}
	changes := append([]StatusChange(nil), in.Changes...)
	sort.SliceStable(changes, func(i, j int) bool { return changes[i].At.Before(changes[j].At) })

	// The status the issue started in is where its first change came from.
	cur := in.CurrentStatus
	if len(changes) > 0 {
		cur = changes[0].From
	}
	type span struct {
		key     string
		entered time.Time
		left    *time.Time
	}
	spans := []span{{key: cur, entered: in.Created}}
	for _, c := range changes {
		at := c.At
		if at.Before(spans[len(spans)-1].entered) {
			at = spans[len(spans)-1].entered
		}
		left := at
		spans[len(spans)-1].left = &left
		spans = append(spans, span{key: c.To, entered: at})
	}

	// Leading backlog time is before the work began; it is not part of the run.
	for len(spans) > 1 && spans[0].key == statusBacklog {
		spans = spans[1:]
	}
	var tl Timeline
	if len(spans) == 1 && (spans[0].key == statusBacklog || spans[0].key == "") {
		return tl
	}

	visits := make([]Visit, 0, len(spans))
	count := map[string]int{}
	for _, sp := range spans {
		step, known := steps[sp.key]
		count[sp.key]++
		name := in.Names[sp.key]
		if name == "" {
			name = sp.key
		}
		kind := kindOf(sp.key, step.Handler, known)
		v := Visit{Key: sp.key, Name: name, Kind: kind, Handler: step.Handler, Number: count[sp.key], EnteredAt: sp.entered, LeftAt: sp.left, Open: sp.left == nil}
		end := in.Now
		if sp.left != nil {
			end = *sp.left
		}
		if kind == KindEnd {
			// Done and cancelled rest nowhere: reaching them finishes the run.
			v.Open, v.LeftAt, end = false, nil, sp.entered
		}
		v.ElapsedSeconds = seconds(end.Sub(sp.entered))
		v.AgentSeconds, v.Agents = agentTime(in.Runs, sp.entered, end, in.Now)
		if kind == KindPerson {
			v.WaitSeconds = v.ElapsedSeconds
			if at, by := firstAnswer(in.Comments, sp.entered, end, v.Open); at != nil {
				v.AnsweredAt, v.AnsweredBy = at, by
				v.WaitSeconds = seconds(at.Sub(sp.entered))
			}
		}
		visits = append(visits, v)
	}

	// How each visit ended, from where the issue went next.
	for i := range visits {
		v := &visits[i]
		switch {
		case v.Kind == KindEnd:
			continue
		case v.Open:
			v.Outcome = OutcomeWaiting
		case i+1 < len(visits):
			next := visits[i+1].Key
			switch {
			case steps[v.Key].Back != "" && next == steps[v.Key].Back:
				v.Outcome = OutcomeSentBack
				tl.Reworks++
			case next == statusBlocked:
				v.Outcome = OutcomeBlocked
			default:
				v.Outcome = OutcomePassed
			}
		}
	}

	first := visits[0].EnteredAt
	tl.StartedAt = &first
	last := visits[len(visits)-1]
	if last.Kind == KindEnd {
		ended := last.EnteredAt
		tl.EndedAt = &ended
		tl.ElapsedSeconds = seconds(ended.Sub(first))
	} else {
		tl.Open = true
		tl.ElapsedSeconds = seconds(in.Now.Sub(first))
	}
	for _, v := range visits {
		tl.AgentSeconds += v.AgentSeconds
		tl.PeopleSeconds += v.WaitSeconds
	}
	tl.OtherSeconds = tl.ElapsedSeconds - tl.AgentSeconds - tl.PeopleSeconds
	if tl.OtherSeconds < 0 {
		tl.OtherSeconds = 0
	}
	tl.Visits = visits
	return tl
}

// agentTime adds up the runs that overlapped the visit, each clipped to it, and names the agents.
func agentTime(runs []Run, from, to, now time.Time) (int64, []string) {
	var total int64
	seen := map[string]bool{}
	var names []string
	for _, r := range runs {
		end := now
		if r.Completed != nil {
			end = *r.Completed
		}
		start := r.Started
		if start.Before(from) {
			start = from
		}
		if end.After(to) {
			end = to
		}
		if !end.After(start) {
			continue
		}
		total += seconds(end.Sub(start))
		if r.Agent != "" && !seen[r.Agent] {
			seen[r.Agent] = true
			names = append(names, r.Agent)
		}
	}
	return total, names
}

// firstAnswer is the first comment a person wrote while the issue was at the step. A little after it left
// still counts: the person comments, then moves the issue.
func firstAnswer(comments []Comment, from, to time.Time, open bool) (*time.Time, string) {
	sorted := append([]Comment(nil), comments...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At.Before(sorted[j].At) })
	for _, c := range sorted {
		if !c.At.After(from) || (!open && c.At.After(to.Add(slack))) {
			continue
		}
		at := c.At
		return &at, c.Author
	}
	return nil, ""
}

// StepInsight is how long the issues of a workflow spent in one step. Medians and the slowest 10% use only
// the visits that are over; a visit still going is counted in Visits and OpenVisits.
type StepInsight struct {
	Key           string
	Name          string
	Kind          string
	Visits        int
	OpenVisits    int
	MedianSeconds int64
	P90Seconds    int64
	TotalSeconds  int64
	SentBack      int // how often the issue left this step for its "if rejected" status
}

// AgentInsight is how long one agent ran per visit.
type AgentInsight struct {
	Agent         string
	Visits        int
	MedianSeconds int64
	P90Seconds    int64
	TotalSeconds  int64
}

// PersonInsight is how quickly one person answered at the steps they handle.
type PersonInsight struct {
	Ref            string
	Answers        int
	MedianSeconds  int64
	P90Seconds     int64
	SlowestSeconds int64
}

// Insights summarises many issues of one workflow.
type Insights struct {
	Runs                 int
	Finished             int
	Open                 int
	MedianElapsedSeconds int64 // finished runs only
	P90ElapsedSeconds    int64
	MedianAgentSeconds   int64
	MedianPeopleSeconds  int64
	MedianOtherSeconds   int64
	SentBack             int
	// BottleneckKey is the step that took the largest share of all the time, "" when nothing was timed.
	BottleneckKey string
	Steps         []StepInsight
	Agents        []AgentInsight
	People        []PersonInsight
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

// Summarise turns the timelines of many issues into insights. order lists the workflow's status keys in board order.
func Summarise(timelines []Timeline, order []string) Insights {
	var out Insights
	type acc struct {
		name, kind string
		closed     []int64
		visits     int
		open       int
		total      int64
		sentBack   int
	}
	steps := map[string]*acc{}
	agents := map[string][]int64{}
	people := map[string][]int64{}
	var elapsed, agentSec, peopleSec, otherSec []int64

	for _, tl := range timelines {
		if len(tl.Visits) == 0 {
			continue
		}
		out.Runs++
		out.SentBack += tl.Reworks
		if tl.Open {
			out.Open++
		} else {
			out.Finished++
			elapsed = append(elapsed, tl.ElapsedSeconds)
			agentSec = append(agentSec, tl.AgentSeconds)
			peopleSec = append(peopleSec, tl.PeopleSeconds)
			otherSec = append(otherSec, tl.OtherSeconds)
		}
		for _, v := range tl.Visits {
			if v.Kind == KindEnd {
				continue
			}
			a := steps[v.Key]
			if a == nil {
				a = &acc{name: v.Name, kind: v.Kind}
				steps[v.Key] = a
			}
			a.visits++
			a.total += v.ElapsedSeconds
			if v.Open {
				a.open++
			} else {
				a.closed = append(a.closed, v.ElapsedSeconds)
			}
			if v.Outcome == OutcomeSentBack {
				a.sentBack++
			}
			for _, name := range v.Agents {
				if v.AgentSeconds > 0 {
					agents[name] = append(agents[name], v.AgentSeconds)
				}
			}
			if v.Kind == KindPerson && v.AnsweredAt != nil && v.AnsweredBy != "" {
				people[v.AnsweredBy] = append(people[v.AnsweredBy], v.WaitSeconds)
			}
		}
	}

	out.MedianElapsedSeconds, out.P90ElapsedSeconds = Median(elapsed), Percentile90(elapsed)
	out.MedianAgentSeconds, out.MedianPeopleSeconds, out.MedianOtherSeconds = Median(agentSec), Median(peopleSec), Median(otherSec)

	seen := map[string]bool{}
	add := func(key string) {
		a := steps[key]
		if a == nil || seen[key] {
			return
		}
		seen[key] = true
		out.Steps = append(out.Steps, StepInsight{
			Key: key, Name: a.name, Kind: a.kind, Visits: a.visits, OpenVisits: a.open,
			MedianSeconds: Median(a.closed), P90Seconds: Percentile90(a.closed), TotalSeconds: a.total, SentBack: a.sentBack,
		})
	}
	for _, key := range order {
		add(key)
	}
	var rest []string
	for key := range steps {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	for _, key := range rest {
		add(key)
	}
	var top int64
	for _, s := range out.Steps {
		if s.Kind != KindParked && s.TotalSeconds > top {
			top, out.BottleneckKey = s.TotalSeconds, s.Key
		}
	}

	for name, v := range agents {
		out.Agents = append(out.Agents, AgentInsight{Agent: name, Visits: len(v), MedianSeconds: Median(v), P90Seconds: Percentile90(v), TotalSeconds: sum(v)})
	}
	sort.Slice(out.Agents, func(i, j int) bool {
		if out.Agents[i].TotalSeconds != out.Agents[j].TotalSeconds {
			return out.Agents[i].TotalSeconds > out.Agents[j].TotalSeconds
		}
		return out.Agents[i].Agent < out.Agents[j].Agent
	})
	for ref, v := range people {
		var slowest int64
		for _, x := range v {
			if x > slowest {
				slowest = x
			}
		}
		out.People = append(out.People, PersonInsight{Ref: ref, Answers: len(v), MedianSeconds: Median(v), P90Seconds: Percentile90(v), SlowestSeconds: slowest})
	}
	sort.Slice(out.People, func(i, j int) bool {
		if out.People[i].MedianSeconds != out.People[j].MedianSeconds {
			return out.People[i].MedianSeconds > out.People[j].MedianSeconds
		}
		return out.People[i].Ref < out.People[j].Ref
	})
	return out
}
