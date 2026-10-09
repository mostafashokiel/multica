package handler

import (
	"reflect"
	"testing"

	"github.com/multica-ai/multica/server/internal/workflow"
)

// The agents a workflow needs include those on the branches of a parallel stage,
// once each and in stage order, so applying it adds them to the squad too.
func TestWorkflowAgentRefsIncludeParallelBranches(t *testing.T) {
	def := &workflow.Definition{Stages: []workflow.Stage{
		{ID: "a", Type: workflow.StageAgent, Agent: "planner"},
		{ID: "p", Type: workflow.StageParallel, Branches: []workflow.Branch{{Agent: "nyc"}, {Agent: "planner"}, {Agent: ""}, {Agent: "cairo"}}},
		{ID: "e", Type: workflow.StageEnd},
	}}
	got := workflowAgentRefs(def)
	if want := []string{"planner", "nyc", "cairo"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("workflowAgentRefs = %v, want %v", got, want)
	}
}
