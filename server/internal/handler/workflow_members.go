package handler

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/workflow"
	"github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	workflowMemberAgent  = "agent"
	workflowMemberPerson = "person"

	// What applying does (or did) about one named agent or person.
	workflowMemberAdd        = "add"        // preview: will be added
	workflowMemberAdded      = "added"      // apply: was added
	workflowMemberPresent    = "present"    // already a member of the squad
	workflowMemberUnresolved = "unresolved" // not an active agent / registered member of this workspace

	// workflowApproverRole is the squad role given to a person added as an approver.
	workflowApproverRole = "approver"

	workflowUserRefPrefix = "user:"
)

// WorkflowMemberResponse is one agent or person a workflow names, and what
// applying does about it.
type WorkflowMemberResponse struct {
	Kind string `json:"kind"`
	// Ref is the text as the workflow writes it: an agent's name, or user:<id>.
	Ref  string `json:"ref"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
	// Status is add, added, present or unresolved.
	Status string `json:"status"`
	// CanWakeLeader is set for a registered person when a squad is chosen: whether a
	// comment from them wakes the squad's leader. A leader that is private to its
	// owner is woken only by its owner, so an approver who is someone else could
	// decide at a gate and nothing would happen.
	CanWakeLeader *bool `json:"can_wake_leader,omitempty"`
	// CannotRunAgents names the workflow's agents that work delegated after this
	// person's comment cannot reach: the leader hands work on with the identity of
	// the person whose comment woke it, so a private agent owned by someone else is
	// refused, silently. Empty when every agent can be run, and for agents.
	CannotRunAgents []string `json:"cannot_run_agents,omitempty"`
}

// workflowAgentRefs are the agents the stages name, in stage order, once each.
func workflowAgentRefs(def *workflow.Definition) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range def.Stages {
		if s.Type != workflow.StageAgent || s.Agent == "" || seen[s.Agent] {
			continue
		}
		seen[s.Agent] = true
		out = append(out, s.Agent)
	}
	return out
}

// workflowApproverRefs are the entries of the approver groups that gates use,
// in stage order, once each. A group no gate uses is not part of the briefing.
func workflowApproverRefs(def *workflow.Definition) []string {
	var out []string
	seenGroup, seen := map[string]bool{}, map[string]bool{}
	for _, s := range def.Stages {
		if s.Type != workflow.StageHumanGate || seenGroup[s.Approvers] {
			continue
		}
		seenGroup[s.Approvers] = true
		for _, entry := range def.Approvers[s.Approvers] {
			if entry == "" || seen[entry] {
				continue
			}
			seen[entry] = true
			out = append(out, entry)
		}
	}
	return out
}

// resolveWorkflowMembers looks up every agent and approver the workflow names
// in the workspace and says whether the squad already has each. It reads only.
// An agent is matched by exact name among the workspace's active agents; a
// person must be written user:<id> and be a registered member of the workspace.
// Anything else (a placeholder such as user:<multica-user-id>, a name nobody has)
// is reported as unresolved and never guessed at.
func resolveWorkflowMembers(
	ctx context.Context, q *db.Queries, workspaceID, squadID pgtype.UUID, def *workflow.Definition,
) ([]WorkflowMemberResponse, error) {
	out := []WorkflowMemberResponse{}

	agentRefs := workflowAgentRefs(def)
	if len(agentRefs) > 0 {
		agents, err := q.ListAgents(ctx, workspaceID)
		if err != nil {
			return nil, err
		}
		byName := make(map[string]db.Agent, len(agents))
		for _, a := range agents {
			byName[a.Name] = a
		}
		for _, ref := range agentRefs {
			m := WorkflowMemberResponse{Kind: workflowMemberAgent, Ref: ref, Status: workflowMemberUnresolved}
			if a, ok := byName[ref]; ok {
				m.ID, m.Name = uuidToString(a.ID), a.Name
				present, err := q.IsSquadMember(ctx, db.IsSquadMemberParams{
					SquadID: squadID, MemberType: workflowMemberAgent, MemberID: a.ID,
				})
				if err != nil {
					return nil, err
				}
				m.Status = memberStatus(present)
			}
			out = append(out, m)
		}
	}

	for _, ref := range workflowApproverRefs(def) {
		m := WorkflowMemberResponse{Kind: workflowMemberPerson, Ref: ref, Status: workflowMemberUnresolved}
		var userID pgtype.UUID
		if id, ok := strings.CutPrefix(ref, workflowUserRefPrefix); ok && userID.Scan(id) == nil {
			if _, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
				UserID: userID, WorkspaceID: workspaceID,
			}); err == nil {
				user, err := q.GetUser(ctx, userID)
				if err != nil {
					return nil, err
				}
				m.ID, m.Name = uuidToString(userID), user.Name
				present, err := q.IsSquadMember(ctx, db.IsSquadMemberParams{
					SquadID: squadID, MemberType: "member", MemberID: userID,
				})
				if err != nil {
					return nil, err
				}
				m.Status = memberStatus(present)
			} else if !isNotFound(err) {
				return nil, err
			}
		}
		out = append(out, m)
	}
	return out, nil
}

func memberStatus(present bool) string {
	if present {
		return workflowMemberPresent
	}
	return workflowMemberAdd
}

// addWorkflowMembers adds every member still marked "add" to the squad and
// marks it "added". It runs inside the apply transaction, under the squad lock,
// so the check made by resolveWorkflowMembers still holds.
func addWorkflowMembers(ctx context.Context, q *db.Queries, squadID pgtype.UUID, members []WorkflowMemberResponse) (int, error) {
	added := 0
	for i := range members {
		m := &members[i]
		if m.Status != workflowMemberAdd {
			continue
		}
		memberType, role := workflowMemberAgent, ""
		if m.Kind == workflowMemberPerson {
			memberType, role = "member", workflowApproverRole
		}
		if _, err := q.AddSquadMember(ctx, db.AddSquadMemberParams{
			SquadID: squadID, MemberType: memberType, MemberID: parseUUID(m.ID), Role: role,
		}); err != nil {
			return added, err
		}
		m.Status = workflowMemberAdded
		added++
	}
	return added, nil
}

// markWhoCanWakeTheLeader fills CanWakeLeader and CannotRunAgents for every
// registered person, by asking the same question the comment trigger asks. A
// leader that cannot be read leaves CanWakeLeader unset: nothing is claimed.
func (h *Handler) markWhoCanWakeTheLeader(ctx context.Context, members []WorkflowMemberResponse, leaderID, workspaceID pgtype.UUID) {
	ws := uuidToString(workspaceID)
	leader, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: leaderID, WorkspaceID: workspaceID})
	if err != nil {
		return
	}
	var agents []db.Agent
	for _, m := range members {
		if m.Kind != workflowMemberAgent || m.ID == "" {
			continue
		}
		if a, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: parseUUID(m.ID), WorkspaceID: workspaceID}); err == nil && a.ID != leader.ID {
			agents = append(agents, a)
		}
	}
	for i := range members {
		m := &members[i]
		if m.Kind != workflowMemberPerson || m.ID == "" {
			continue
		}
		can := h.canInvokeAgent(ctx, leader, "member", m.ID, "", ws)
		m.CanWakeLeader = &can
		for _, a := range agents {
			// The leader acts for the person, so the check is made as them.
			if !h.canInvokeAgent(ctx, a, "member", m.ID, "", ws) {
				m.CannotRunAgents = append(m.CannotRunAgents, a.Name)
			}
		}
	}
}
