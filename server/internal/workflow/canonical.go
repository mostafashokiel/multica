package workflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"

	"gopkg.in/yaml.v3"
)

// OrderedStages returns the stages in canonical order: depth-first from start,
// following the main path first and rework edges after it, ties broken by id.
// Stages not reachable from start follow, sorted by id. The result depends only
// on the graph, never on the order the stages were written in, so the same
// workflow always produces the same text.
func (d *Definition) OrderedStages() []Stage {
	first := map[string]int{}
	for i, s := range d.Stages {
		if _, seen := first[s.ID]; !seen {
			first[s.ID] = i
		}
	}
	emitted := make([]bool, len(d.Stages))
	visited := map[string]bool{}
	var out []Stage

	// Explicit stack: a long chain of stages must not overflow the call stack.
	stack := []string{d.Start}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		i, known := first[id]
		if !known || visited[id] {
			continue
		}
		visited[id] = true
		emitted[i] = true
		s := d.Stages[i]
		out = append(out, s)
		forward, reject := s.Targets()
		next := append(sortedUnique(forward), sortedUnique(reject)...)
		// Pushed in reverse so the first target in canonical order is popped first.
		for j := len(next) - 1; j >= 0; j-- {
			stack = append(stack, next[j])
		}
	}

	var rest []Stage
	for i, s := range d.Stages {
		if !emitted[i] {
			rest = append(rest, s)
		}
	}
	sort.SliceStable(rest, func(a, b int) bool { return rest[a].ID < rest[b].ID })
	return append(out, rest...)
}

func sortedUnique(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// orderedApproverGroups lists group names in order of first use by a gate
// (following the canonical stage order), then the unused ones by name.
func orderedApproverGroups(d *Definition, stages []Stage) []string {
	var names []string
	seen := map[string]bool{}
	add := func(name string) {
		if _, defined := d.Approvers[name]; defined && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	for _, s := range stages {
		if s.Type == StageHumanGate {
			add(s.Approvers)
		}
	}
	rest := make([]string, 0, len(d.Approvers))
	for name := range d.Approvers {
		rest = append(rest, name)
	}
	sort.Strings(rest)
	for _, name := range rest {
		add(name)
	}
	return names
}

// str is a text scalar. Text that YAML's plain and block styles would not
// carry faithfully (leading or trailing whitespace, control characters) is
// written double-quoted, where every character is explicit.
func str(s string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
	if needsQuotes(s) {
		n.Style = yaml.DoubleQuotedStyle
	}
	return n
}

func needsQuotes(s string) bool {
	if s == "" {
		return false
	}
	switch s[0] {
	case ' ', '\n', '\t', '\r':
		return true
	}
	switch s[len(s)-1] {
	case ' ', '\n', '\t', '\r':
		return true
	}
	for _, r := range s {
		if r < 0x20 && r != '\n' || r == 0x7f || r == 0x85 || r == 0x2028 || r == 0x2029 {
			return true
		}
	}
	return false
}

func integer(n int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(n)}
}

func flowList(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
	for _, item := range items {
		n.Content = append(n.Content, str(item))
	}
	return n
}

type mapping struct{ node *yaml.Node }

func newMapping() *mapping { return &mapping{&yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}} }

func (m *mapping) set(key string, value *yaml.Node) *mapping {
	m.node.Content = append(m.node.Content, str(key), value)
	return m
}

// Marshal writes the definition in its canonical form: fixed key order,
// canonical stage and approver-group order, two-space indentation, one trailing
// newline. Parsing the output and marshalling again gives the same bytes.
// Comments are not preserved.
func Marshal(d *Definition) ([]byte, error) {
	stages := d.OrderedStages()

	meta := newMapping().set("id", str(d.Metadata.ID)).set("version", integer(d.Metadata.Version))
	if d.Metadata.Owner != "" {
		meta.set("owner", str(d.Metadata.Owner))
	}
	if d.Metadata.Description != "" {
		meta.set("description", str(d.Metadata.Description))
	}

	root := newMapping().
		set("apiVersion", str(APIVersion)).
		set("kind", str(Kind)).
		set("metadata", meta.node)
	if d.Target != nil {
		squad := newMapping().set("name", str(d.Target.SquadName)).set("leader", str(d.Target.SquadLeader))
		root.set("target", newMapping().set("squad", squad.node).node)
	}

	approvers := newMapping()
	for _, name := range orderedApproverGroups(d, stages) {
		approvers.set(name, flowList(d.Approvers[name]))
	}
	root.set("approvers", approvers.node)
	root.set("start", str(d.Start))

	list := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, s := range stages {
		list.Content = append(list.Content, stageNode(s))
	}
	root.set("stages", list)

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root.node}}); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func stageNode(s Stage) *yaml.Node {
	m := newMapping().set("id", str(s.ID)).set("type", str(s.Type))
	if s.Name != "" {
		m.set("name", str(s.Name))
	}
	switch s.Type {
	case StageAgent:
		m.set("agent", str(s.Agent))
		if len(s.Skills) > 0 {
			m.set("skills", flowList(s.Skills))
		}
		if s.ExpectedOutput != "" {
			m.set("expected_output", str(s.ExpectedOutput))
		}
		m.set("next", str(s.Next))
	case StageHumanGate:
		m.set("approvers", str(s.Approvers)).set("on_approve", str(s.OnApprove)).set("on_reject", str(s.OnReject))
		if s.MaxRework > 0 {
			m.set("max_rework", integer(s.MaxRework))
		}
		if s.EscalateAfterHours > 0 {
			m.set("escalate_after_hours", integer(s.EscalateAfterHours))
		}
	case StageCondition:
		m.set("when", str(s.When)).set("then", str(s.Then)).set("else", str(s.Else))
	}
	return m.node
}

// ContentHash is the SHA-256 (hex) of the canonical text: equal workflows have
// equal hashes.
func ContentHash(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}
