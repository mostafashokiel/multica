package workflow

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Rule codes. They are stable: tools and users match on them. There is no V007.
const (
	CodeStageID      = "V001" // ids unique, lowercase kebab-case, at most 40 characters
	CodeReference    = "V002" // start and every referenced stage exist
	CodeReachable    = "V003" // every stage reachable from start
	CodeEnds         = "V004" // an end stage reachable from every stage
	CodeLoops        = "V005" // every loop passes through a gate with max_rework
	CodeApprovers    = "V006" // every gate's approver group exists and is non-empty
	CodeCondition    = "V008" // `when` parses
	maxStageIDLength = 40
)

var kebab = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ValidID reports whether s is acceptable as a stage id or a workflow key:
// lowercase kebab-case, at most 40 characters.
func ValidID(s string) bool { return len(s) <= maxStageIDLength && kebab.MatchString(s) }

// Validate returns every rule violation, never just the first, in a fixed
// order: same definition, same list.
func Validate(def *Definition) []Issue {
	var issues []Issue
	for _, rule := range []func(*Definition) []Issue{v001, v002, v003, v004, v005, v006, v008} {
		issues = append(issues, rule(def)...)
	}
	return issues
}

func byID(def *Definition) map[string]*Stage {
	m := make(map[string]*Stage, len(def.Stages))
	for i := range def.Stages {
		if _, seen := m[def.Stages[i].ID]; !seen {
			m[def.Stages[i].ID] = &def.Stages[i]
		}
	}
	return m
}

func successors(s *Stage) []string {
	forward, reject := s.Targets()
	seen := map[string]bool{}
	var out []string
	for _, t := range append(append([]string{}, forward...), reject...) {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

func v001(def *Definition) []Issue {
	var issues []Issue
	seen, reported := map[string]bool{}, map[string]bool{}
	for _, s := range def.Stages {
		if seen[s.ID] {
			if !reported[s.ID] {
				reported[s.ID] = true
				issues = append(issues, Issue{Code: CodeStageID, StageID: s.ID, Field: "id",
					Message: fmt.Sprintf("Stage id %q is used more than once", s.ID)})
			}
			continue
		}
		seen[s.ID] = true
		if !kebab.MatchString(s.ID) {
			issues = append(issues, Issue{Code: CodeStageID, StageID: s.ID, Field: "id",
				Message: fmt.Sprintf("Stage id %q must be lowercase kebab-case (a-z, 0-9, single hyphens)", s.ID)})
		}
		if len(s.ID) > maxStageIDLength {
			issues = append(issues, Issue{Code: CodeStageID, StageID: s.ID, Field: "id",
				Message: fmt.Sprintf("Stage id %q is longer than %d characters", s.ID, maxStageIDLength)})
		}
	}
	return issues
}

type reference struct{ field, target string }

func references(s Stage) []reference {
	switch s.Type {
	case StageAgent:
		return []reference{{"next", s.Next}}
	case StageHumanGate:
		return []reference{{"on_approve", s.OnApprove}, {"on_reject", s.OnReject}}
	case StageCondition:
		return []reference{{"then", s.Then}, {"else", s.Else}}
	}
	return nil
}

func v002(def *Definition) []Issue {
	var issues []Issue
	stages := byID(def)
	if _, ok := stages[def.Start]; !ok {
		issues = append(issues, Issue{Code: CodeReference, Field: "start",
			Message: fmt.Sprintf("start refers to unknown stage %q", def.Start)})
	}
	for _, s := range def.Stages {
		for _, ref := range references(s) {
			if _, ok := stages[ref.target]; !ok {
				issues = append(issues, Issue{Code: CodeReference, StageID: s.ID, Field: ref.field,
					Message: fmt.Sprintf("Stage %q: %s refers to unknown stage %q", s.ID, ref.field, ref.target)})
			}
		}
	}
	return issues
}

// reachableFrom walks every edge (forward and rework) to existing stages.
func reachableFrom(stages map[string]*Stage, from string) map[string]bool {
	seen := map[string]bool{}
	stack := []string{from}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		s, ok := stages[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		stack = append(stack, successors(s)...)
	}
	return seen
}

func v003(def *Definition) []Issue {
	stages := byID(def)
	if _, ok := stages[def.Start]; !ok {
		return nil // V002 already says so
	}
	reachable := reachableFrom(stages, def.Start)
	var issues []Issue
	reported := map[string]bool{}
	for _, s := range def.Stages {
		if !reachable[s.ID] && !reported[s.ID] {
			reported[s.ID] = true
			issues = append(issues, Issue{Code: CodeReachable, StageID: s.ID,
				Message: fmt.Sprintf("Stage %q cannot be reached from start %q", s.ID, def.Start)})
		}
	}
	return issues
}

func v004(def *Definition) []Issue {
	stages := byID(def)
	var ends []string
	for _, s := range def.Stages {
		if s.Type == StageEnd {
			ends = append(ends, s.ID)
		}
	}
	if len(ends) == 0 {
		return []Issue{{Code: CodeEnds, Message: "The workflow has no end stage"}}
	}
	// Walk the graph backwards from every end stage.
	predecessors := map[string][]string{}
	for id, s := range stages {
		for _, next := range successors(s) {
			predecessors[next] = append(predecessors[next], id)
		}
	}
	canFinish := map[string]bool{}
	stack := append([]string{}, ends...)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if canFinish[id] || stages[id] == nil {
			continue
		}
		canFinish[id] = true
		stack = append(stack, predecessors[id]...)
	}
	var issues []Issue
	seen := map[string]bool{}
	for _, s := range def.Stages {
		if !canFinish[s.ID] && !seen[s.ID] {
			seen[s.ID] = true
			issues = append(issues, Issue{Code: CodeEnds, StageID: s.ID,
				Message: fmt.Sprintf("Stage %q cannot reach an end stage", s.ID)})
		}
	}
	return issues
}

// v005 finds loops that no gate with max_rework limits: it removes those gates
// and looks for cycles in what is left.
func v005(def *Definition) []Issue {
	stages := byID(def)
	include := func(s *Stage) bool { return !(s.Type == StageHumanGate && s.MaxRework > 0) }

	// Iterative Tarjan over the sub-graph, so a very long chain cannot overflow the stack.
	index, low := map[string]int{}, map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	var components [][]string
	counter := 0

	edges := func(id string) []string {
		var out []string
		for _, next := range successors(stages[id]) {
			if t, ok := stages[next]; ok && include(t) {
				out = append(out, next)
			}
		}
		return out
	}
	ids := make([]string, 0, len(stages))
	for id, s := range stages {
		if include(s) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	type frame struct {
		id    string
		edges []string
		next  int
	}
	for _, root := range ids {
		if _, seen := index[root]; seen {
			continue
		}
		work := []*frame{{id: root, edges: edges(root)}}
		index[root], low[root] = counter, counter
		counter++
		stack = append(stack, root)
		onStack[root] = true
		for len(work) > 0 {
			f := work[len(work)-1]
			if f.next < len(f.edges) {
				next := f.edges[f.next]
				f.next++
				if _, seen := index[next]; !seen {
					index[next], low[next] = counter, counter
					counter++
					stack = append(stack, next)
					onStack[next] = true
					work = append(work, &frame{id: next, edges: edges(next)})
				} else if onStack[next] && index[next] < low[f.id] {
					low[f.id] = index[next]
				}
				continue
			}
			work = work[:len(work)-1]
			if len(work) > 0 {
				parent := work[len(work)-1]
				if low[f.id] < low[parent.id] {
					low[parent.id] = low[f.id]
				}
			}
			if low[f.id] == index[f.id] {
				var component []string
				for {
					member := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					onStack[member] = false
					component = append(component, member)
					if member == f.id {
						break
					}
				}
				selfLoop := false
				if len(component) == 1 {
					for _, e := range f.edges {
						selfLoop = selfLoop || e == f.id
					}
				}
				if len(component) > 1 || selfLoop {
					sort.Strings(component)
					components = append(components, component)
				}
			}
		}
	}
	sort.Slice(components, func(i, j int) bool { return components[i][0] < components[j][0] })
	issues := make([]Issue, 0, len(components))
	for _, c := range components {
		quoted := make([]string, len(c))
		for i, id := range c {
			quoted[i] = fmt.Sprintf("%q", id)
		}
		issues = append(issues, Issue{Code: CodeLoops, StageID: c[0],
			Message: fmt.Sprintf("Stages %s form a loop that no human_gate with max_rework limits", strings.Join(quoted, ", "))})
	}
	return issues
}

func v006(def *Definition) []Issue {
	var issues []Issue
	for _, s := range def.Stages {
		if s.Type != StageHumanGate {
			continue
		}
		members, defined := def.Approvers[s.Approvers]
		switch {
		case !defined:
			issues = append(issues, Issue{Code: CodeApprovers, StageID: s.ID, Field: "approvers",
				Message: fmt.Sprintf("Gate %q: approver group %q is not defined", s.ID, s.Approvers)})
		case len(members) == 0:
			issues = append(issues, Issue{Code: CodeApprovers, StageID: s.ID, Field: "approvers",
				Message: fmt.Sprintf("Gate %q: approver group %q has no members", s.ID, s.Approvers)})
		}
	}
	return issues
}

func v008(def *Definition) []Issue {
	var issues []Issue
	for _, s := range def.Stages {
		if s.Type != StageCondition {
			continue
		}
		if _, err := ParseCondition(s.When); err != nil {
			issues = append(issues, Issue{Code: CodeCondition, StageID: s.ID, Field: "when",
				Message: fmt.Sprintf("Condition %q: %s (column %d)", s.ID, err.Message, err.Column)})
		}
	}
	return issues
}
