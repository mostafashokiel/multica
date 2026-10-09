package workflow

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"

	"gopkg.in/yaml.v3"
)

// MaxSourceBytes bounds a definition's YAML before any parsing happens.
const MaxSourceBytes = 1 << 20

// coreTags are the only tags a definition may use. Anything else (custom
// tags, merge keys) is rejected so a definition can never smuggle in
// application-specific constructs.
var coreTags = map[string]bool{
	"!!str": true, "!!int": true, "!!float": true, "!!bool": true,
	"!!null": true, "!!map": true, "!!seq": true,
}

var yamlLine = regexp.MustCompile(`line (\d+)`)

// Parse reads a definition from YAML. It is strict: unknown keys, duplicate
// keys, aliases, anchors, merge keys, custom tags and more than one document
// are all rejected. A definition that parses may still be invalid; see
// Validate. Parse never panics on bad input and reports every problem it can
// find in one pass.
func Parse(source []byte) (*Definition, []Issue) {
	if len(source) > MaxSourceBytes {
		return nil, []Issue{{Message: fmt.Sprintf("YAML is larger than %d bytes", MaxSourceBytes)}}
	}

	decoder := yaml.NewDecoder(bytes.NewReader(source))
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, []Issue{{Message: "the document is empty"}}
		}
		return nil, []Issue{syntaxIssue(err)}
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err != nil {
			return nil, []Issue{syntaxIssue(err)}
		}
		return nil, []Issue{{Message: "only one YAML document is allowed", Line: extra.Line}}
	}
	if len(document.Content) != 1 {
		return nil, []Issue{{Message: "the document is empty"}}
	}

	p := &parser{}
	p.rejectForbidden(document.Content[0])
	if len(p.issues) > 0 {
		return nil, p.issues
	}
	def := p.definition(document.Content[0])
	if len(p.issues) > 0 {
		return nil, p.issues
	}
	return def, nil
}

func syntaxIssue(err error) Issue {
	issue := Issue{Message: err.Error()}
	if m := yamlLine.FindStringSubmatch(err.Error()); m != nil {
		issue.Line, _ = strconv.Atoi(m[1])
	}
	return issue
}

type parser struct {
	issues []Issue
}

func (p *parser) add(path string, node *yaml.Node, format string, args ...any) {
	issue := Issue{Path: path, Message: fmt.Sprintf(format, args...)}
	if node != nil {
		issue.Line = node.Line
	}
	p.issues = append(p.issues, issue)
}

// rejectForbidden walks the whole tree once for constructs that are never
// allowed, wherever they appear. Only an explicit tag counts: text such as
// 2026-10-07 or << is implicitly typed by the YAML resolver but is just text
// to us, as in any other YAML 1.2 core reader.
func (p *parser) rejectForbidden(n *yaml.Node) {
	p.walkForbidden(n, false)
}

func (p *parser) walkForbidden(n *yaml.Node, isKey bool) {
	switch {
	case n.Kind == yaml.AliasNode:
		p.add("", n, "YAML aliases are not allowed")
		return
	case n.Anchor != "":
		p.add("", n, "YAML anchors are not allowed")
	}
	if isKey && n.Kind == yaml.ScalarNode && n.ShortTag() == "!!merge" {
		p.add("", n, "YAML merge keys are not allowed")
	}
	if n.Kind != yaml.DocumentNode && n.Style&yaml.TaggedStyle != 0 && !coreTags[n.ShortTag()] {
		p.add("", n, "the YAML tag %q is not allowed", n.ShortTag())
	}
	for i, child := range n.Content {
		p.walkForbidden(child, n.Kind == yaml.MappingNode && i%2 == 0)
	}
}

// fields checks a mapping against the keys it may and must have and returns
// its entries. Unknown and duplicate keys are reported.
func (p *parser) fields(n *yaml.Node, path string, allowed, required []string) map[string]*yaml.Node {
	if n.Kind != yaml.MappingNode {
		p.add(path, n, "expected a mapping")
		return nil
	}
	allow := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		allow[key] = true
	}
	out := make(map[string]*yaml.Node, len(n.Content)/2)
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, value := n.Content[i], n.Content[i+1]
		if key.Kind != yaml.ScalarNode {
			p.add(path, key, "mapping keys must be plain text")
			continue
		}
		if _, dup := out[key.Value]; dup {
			p.add(join(path, key.Value), key, "the key %q appears more than once", key.Value)
			continue
		}
		if !allow[key.Value] {
			p.add(join(path, key.Value), key, "unrecognized key %q", key.Value)
			continue
		}
		out[key.Value] = value
	}
	for _, key := range required {
		if _, ok := out[key]; !ok {
			p.add(join(path, key), n, "%q is required", key)
		}
	}
	return out
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func index(path string, i int) string { return fmt.Sprintf("%s[%d]", path, i) }

// str reads a text value. A number, boolean or null is not text: `next: 42`
// is a mistake, not a stage called "42".
func (p *parser) str(n *yaml.Node, path string) (string, bool) {
	if n.Kind != yaml.ScalarNode || !isText(n) {
		p.add(path, n, "expected text")
		return "", false
	}
	return n.Value, true
}

// isText reports whether a scalar is text. Plain scalars the resolver types as
// a timestamp or a merge marker are still text to us; numbers, booleans and
// null are not.
func isText(n *yaml.Node) bool {
	switch n.ShortTag() {
	case "!!str":
		return true
	case "!!timestamp", "!!merge":
		return n.Style&yaml.TaggedStyle == 0
	}
	return false
}

func (p *parser) positiveInt(n *yaml.Node, path string) (int, bool) {
	if n.Kind != yaml.ScalarNode || n.ShortTag() != "!!int" {
		p.add(path, n, "expected a whole number")
		return 0, false
	}
	v, err := strconv.Atoi(n.Value)
	if err != nil || v < 1 {
		p.add(path, n, "expected a whole number greater than zero")
		return 0, false
	}
	return v, true
}

func (p *parser) strList(n *yaml.Node, path string, nonEmpty bool) ([]string, bool) {
	if n.Kind != yaml.SequenceNode {
		p.add(path, n, "expected a list")
		return nil, false
	}
	out := make([]string, 0, len(n.Content))
	ok := true
	for i, item := range n.Content {
		s, itemOK := p.str(item, index(path, i))
		if itemOK && nonEmpty && s == "" {
			p.add(index(path, i), item, "must not be empty")
			itemOK = false
		}
		ok = ok && itemOK
		out = append(out, s)
	}
	return out, ok
}

func (p *parser) definition(root *yaml.Node) *Definition {
	f := p.fields(root, "",
		[]string{"apiVersion", "kind", "metadata", "target", "approvers", "start", "stages"},
		[]string{"apiVersion", "kind", "metadata", "approvers", "start", "stages"})
	if f == nil {
		return nil
	}
	def := &Definition{}

	if n, ok := f["apiVersion"]; ok {
		if v, ok := p.str(n, "apiVersion"); ok && v != APIVersion {
			p.add("apiVersion", n, "must be %q", APIVersion)
		}
	}
	if n, ok := f["kind"]; ok {
		if v, ok := p.str(n, "kind"); ok && v != Kind {
			p.add("kind", n, "must be %q", Kind)
		}
	}
	if n, ok := f["metadata"]; ok {
		def.Metadata = p.metadata(n)
	}
	if n, ok := f["target"]; ok {
		def.Target = p.target(n)
	}
	if n, ok := f["approvers"]; ok {
		def.Approvers = p.approvers(n)
	}
	if n, ok := f["start"]; ok {
		def.Start, _ = p.str(n, "start")
	}
	if n, ok := f["stages"]; ok {
		def.Stages = p.stages(n)
	}
	return def
}

func (p *parser) metadata(n *yaml.Node) Metadata {
	var m Metadata
	f := p.fields(n, "metadata", []string{"id", "version", "owner", "description"}, []string{"id", "version"})
	if f == nil {
		return m
	}
	if v, ok := f["id"]; ok {
		if s, ok := p.str(v, "metadata.id"); ok {
			if s == "" {
				p.add("metadata.id", v, "must not be empty")
			}
			m.ID = s
		}
	}
	if v, ok := f["version"]; ok {
		m.Version, _ = p.positiveInt(v, "metadata.version")
	}
	if v, ok := f["owner"]; ok {
		m.Owner, _ = p.str(v, "metadata.owner")
	}
	if v, ok := f["description"]; ok {
		m.Description, _ = p.str(v, "metadata.description")
	}
	return m
}

func (p *parser) target(n *yaml.Node) *Target {
	f := p.fields(n, "target", []string{"squad"}, []string{"squad"})
	if f == nil {
		return nil
	}
	squad := p.fields(f["squad"], "target.squad", []string{"name", "leader"}, []string{"name", "leader"})
	if squad == nil {
		return nil
	}
	t := &Target{}
	t.SquadName, _ = p.str(squad["name"], "target.squad.name")
	t.SquadLeader, _ = p.str(squad["leader"], "target.squad.leader")
	return t
}

func (p *parser) approvers(n *yaml.Node) map[string][]string {
	if n.Kind != yaml.MappingNode {
		p.add("approvers", n, "expected a mapping")
		return nil
	}
	out := make(map[string][]string, len(n.Content)/2)
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, value := n.Content[i], n.Content[i+1]
		if _, dup := out[key.Value]; dup {
			p.add(join("approvers", key.Value), key, "the group %q appears more than once", key.Value)
			continue
		}
		members, _ := p.strList(value, join("approvers", key.Value), false)
		out[key.Value] = members
	}
	return out
}

func (p *parser) stages(n *yaml.Node) []Stage {
	if n.Kind != yaml.SequenceNode {
		p.add("stages", n, "expected a list")
		return nil
	}
	out := make([]Stage, 0, len(n.Content))
	for i, item := range n.Content {
		out = append(out, p.stage(item, index("stages", i)))
	}
	return out
}

var stageKeys = map[string]struct{ allowed, required []string }{
	StageAgent: {
		allowed:  []string{"id", "type", "name", "agent", "skills", "expected_output", "next"},
		required: []string{"id", "type", "agent", "next"},
	},
	StageParallel: {
		allowed:  []string{"id", "type", "name", "branches", "next"},
		required: []string{"id", "type", "branches", "next"},
	},
	StageHumanGate: {
		allowed:  []string{"id", "type", "name", "approvers", "on_approve", "on_reject", "max_rework", "escalate_after_hours"},
		required: []string{"id", "type", "approvers", "on_approve", "on_reject"},
	},
	StageCondition: {
		allowed:  []string{"id", "type", "name", "when", "then", "else"},
		required: []string{"id", "type", "when", "then", "else"},
	},
	StageEnd: {
		allowed:  []string{"id", "type", "name"},
		required: []string{"id", "type"},
	},
}

func (p *parser) stage(n *yaml.Node, path string) Stage {
	var s Stage
	if n.Kind != yaml.MappingNode {
		p.add(path, n, "expected a mapping")
		return s
	}
	// The type decides which keys are allowed, so read it first.
	var typeNode *yaml.Node
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == "type" {
			typeNode = n.Content[i+1]
		}
	}
	if typeNode == nil {
		p.add(join(path, "type"), n, "\"type\" is required")
		return s
	}
	typ, ok := p.str(typeNode, join(path, "type"))
	keys, known := stageKeys[typ]
	if !ok || !known {
		if ok {
			p.add(join(path, "type"), typeNode, "unknown stage type %q (use agent, parallel, human_gate, condition or end)", typ)
		}
		return s
	}
	s.Type = typ
	f := p.fields(n, path, keys.allowed, keys.required)
	if f == nil {
		return s
	}
	text := func(key string, dst *string) {
		if v, ok := f[key]; ok {
			*dst, _ = p.str(v, join(path, key))
		}
	}
	text("id", &s.ID)
	if v, ok := f["id"]; ok && s.ID == "" {
		p.add(join(path, "id"), v, "must not be empty")
	}
	text("name", &s.Name)
	text("agent", &s.Agent)
	text("expected_output", &s.ExpectedOutput)
	text("next", &s.Next)
	text("approvers", &s.Approvers)
	text("on_approve", &s.OnApprove)
	text("on_reject", &s.OnReject)
	text("when", &s.When)
	text("then", &s.Then)
	text("else", &s.Else)
	if v, ok := f["skills"]; ok {
		s.Skills, _ = p.strList(v, join(path, "skills"), true)
	}
	if v, ok := f["branches"]; ok {
		s.Branches = p.branches(v, join(path, "branches"))
	}
	if v, ok := f["max_rework"]; ok {
		s.MaxRework, _ = p.positiveInt(v, join(path, "max_rework"))
	}
	if v, ok := f["escalate_after_hours"]; ok {
		s.EscalateAfterHours, _ = p.positiveInt(v, join(path, "escalate_after_hours"))
	}
	return s
}

func (p *parser) branches(n *yaml.Node, path string) []Branch {
	if n.Kind != yaml.SequenceNode {
		p.add(path, n, "expected a list")
		return nil
	}
	out := make([]Branch, 0, len(n.Content))
	for i, item := range n.Content {
		at := index(path, i)
		var b Branch
		f := p.fields(item, at, []string{"name", "agent", "skills", "expected_output"}, []string{"agent"})
		if f != nil {
			if v, ok := f["name"]; ok {
				b.Name, _ = p.str(v, join(at, "name"))
			}
			if v, ok := f["agent"]; ok {
				b.Agent, _ = p.str(v, join(at, "agent"))
			}
			if v, ok := f["expected_output"]; ok {
				b.ExpectedOutput, _ = p.str(v, join(at, "expected_output"))
			}
			if v, ok := f["skills"]; ok {
				b.Skills, _ = p.strList(v, join(at, "skills"), true)
			}
		}
		out = append(out, b)
	}
	return out
}
