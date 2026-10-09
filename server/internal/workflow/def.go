// Package workflow is the pure core of the Workflows feature: it parses a
// workflow definition, validates it, and writes it back in one canonical form.
// It does not touch the database or HTTP, so everything here is unit-testable
// without a server.
//
// A definition describes the stages work moves through: an agent stage, a human
// approval gate, a condition, and an end. Structure is checked while parsing;
// meaning (reachability, loops, approver groups, condition syntax) is checked by
// Validate. The split lets a half-drawn definition be saved and reopened:
// references may be empty while it is being drawn, and Validate reports them.
package workflow

// APIVersion and Kind identify the definition format.
const (
	APIVersion = "composer.noqodi/v1"
	Kind       = "Workflow"
)

// Stage types.
const (
	StageAgent     = "agent"
	StageHumanGate = "human_gate"
	StageCondition = "condition"
	StageEnd       = "end"
)

// Definition is a parsed workflow definition.
type Definition struct {
	Metadata  Metadata
	Target    *Target // optional: which squad the workflow was written for
	Approvers map[string][]string
	Start     string
	Stages    []Stage
}

// Metadata identifies the workflow.
type Metadata struct {
	ID          string
	Version     int
	Owner       string
	Description string
}

// Target names the squad a definition was written for. It is informational:
// applying a workflow to a squad uses the squad chosen at apply time.
type Target struct {
	SquadName   string
	SquadLeader string
}

// Stage is one step. Only the fields of its Type are used.
type Stage struct {
	ID   string
	Type string
	Name string

	// agent
	Agent          string
	Skills         []string
	ExpectedOutput string
	Next           string

	// human_gate
	Approvers          string // approver group name
	OnApprove          string
	OnReject           string
	MaxRework          int // 0 = not set
	EscalateAfterHours int // 0 = not set

	// condition
	When string
	Then string
	Else string
}

// Targets lists where a stage can lead. Forward edges are the main path
// (next, on_approve, then/else); Reject edges are the rework loops.
func (s Stage) Targets() (forward, reject []string) {
	switch s.Type {
	case StageAgent:
		return []string{s.Next}, nil
	case StageHumanGate:
		return []string{s.OnApprove}, []string{s.OnReject}
	case StageCondition:
		return []string{s.Then, s.Else}, nil
	}
	return nil, nil
}

// Issue is one problem found while parsing or validating, with a stable code.
// Parse problems carry no code; validation rules use V001..V008 (there is no
// V007).
type Issue struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
	StageID string `json:"stage_id,omitempty"`
	Field   string `json:"field,omitempty"`
	// Path and Line locate parse problems in the source text.
	Path string `json:"path,omitempty"`
	Line int    `json:"line,omitempty"`
}
