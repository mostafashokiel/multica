# Workflows

A workflow is a workspace-level, versioned definition of the stages work moves
through: agent stages, human approval gates, conditions and an end. It is not an
engine and it does not move issues by itself. Applying a workflow writes a
briefing into a squad's `instructions`; the squad leader then follows it.

The feature is off unless the deployment enables `workflows_v1`. With it off,
every `multica workflow` command fails with `Workflows are not enabled`; that is
a deployment setting, not something to work around.

- [Debugging a squad that does not follow its workflow](#debugging-a-squad-that-does-not-follow-its-workflow)
- [Core model](#core-model)
- [CLI](#cli)
- [The managed block in squad instructions](#the-managed-block-in-squad-instructions)
- [Labels](#labels)
- [Who may do what](#who-may-do-what)
- [Common wrong assumptions](#common-wrong-assumptions)

## Debugging a squad that does not follow its workflow

Inspect first:

```bash
multica workflow list --output json
multica workflow get <workflow-key> --output json
multica squad get <squad-id> --output json
multica workflow render <workflow-key> --squad <squad-id>
```

Then compare. The squad's `instructions` should contain a block that starts with
`<!-- workflow-managed:begin workflow=<key> version=<n> sha256=<hash> -->`:

- no block: the workflow was never applied to this squad;
- a different `workflow=` key: the squad follows another workflow;
- an older `version` or a different `sha256` than `workflow get` reports: a newer
  version exists and has not been applied;
- the markers are damaged: someone edited them by hand; applying is refused until
  the damaged marker is fixed or removed.

If the block is right, the problem is elsewhere: the issue is missing the
`wf:<key>` label, or the labels the briefing names do not exist in the workspace
(see [Labels](#labels)).

## Core model

- A workflow has a stable **key** (the `metadata.id` in its definition,
  lowercase kebab-case) and **immutable versions**. Saving never edits a version;
  it adds the next one. Restoring an old version adds a new version with the old
  content.
- A definition has five stage types: `agent` (delegate work to an agent by @mention), `parallel`
  (two to eight branches, each a sub-issue assigned to an agent, all started together; the stage ends
  when every sub-issue is Done, so each agent must finish its sub-issue as Done and not In Review),
  `human_gate`
  (wait for a listed approver's decision, with an optional `max_rework` and
  `escalate_after_hours`), `condition` (branch on the issue's labels) and `end`.
- A version can be saved with problems, but only a version that passes validation
  can be rendered or applied. Validation codes are `V001`-`V009` (there is no
  `V007`).
- The text a leader follows is generated from the definition. The same version
  always renders to the same text.

## CLI

Read-only commands, safe to run at any time:

```bash
multica workflow list --output json
multica workflow get <workflow> --output json          # newest version
multica workflow get <workflow> --version 2 --output yaml
multica workflow validate --file definition.yaml        # nothing is saved
multica workflow render <workflow> --squad <squad>      # preview, nothing is written
multica workflow render <workflow> --labels             # the labels it implies
```

`<workflow>` is a workflow ID, its key, or a UUID prefix. `--squad` takes a squad
ID or its exact name. `validate` exits non-zero when the definition has problems.

The one write:

```bash
multica workflow apply <workflow> --squad <squad> [--version <n>] [--replace]
```

`apply` changes a squad's instructions, so treat it like any other write: do not
run it to see what happens. Preview with `render` first, and propose the apply to
the user instead of making it unless they asked for it.

## The managed block in squad instructions

`apply` puts the briefing between two marker lines and touches nothing else in
the instructions:

```text
<!-- workflow-managed:begin workflow=<key> version=<n> sha256=<hash> -->
...generated briefing...
<!-- workflow-managed:end workflow=<key> -->
```

- Text the squad already had stays where it is; the block is added after it.
- Applying the same version again changes nothing and reports it.
- `apply` also adds to the squad the agents the stages name (matched by exact name among
  active agents) and the people in the approver groups the gates use (written `user:<id>`,
  registered members of the workspace). People get the squad role `approver`. Names nobody
  has are reported, not added; run `apply` again once they exist.
- Applying a new version replaces the block in place.
- A squad that already follows a different workflow is refused (`squad_has_workflow`)
  unless `--replace` is passed. A squad follows one workflow at a time.
- Do not edit inside the markers. The next apply overwrites that text, and a
  marker that no longer parses makes apply refuse (`managed_block_invalid`) rather
  than guess where the block ends.
- Do not put your own text between or inside the markers; put it above or below.

## Labels

The briefing records where an issue stands with two labels: `wf:<key>` marks an
issue as part of the workflow and `phase:<stage>` is its current stage. Condition
stages get no phase label. `render --labels` lists them. `apply` does not create
labels; they have to exist in the workspace before issues enter the workflow.

A human gate needs no label from the person: they reply on the issue in their own
words. The squad leader is woken by that comment (the squad owns the issue) and
decides from it whether the gate is approved, rejected or still open.

## Who may do what

- Any workspace member can read workflows and preview a rendering.
- Only a **human** workspace owner or admin can apply a workflow (and change one).
  An agent cannot, even one acting for an owner: the workflow decides who approves
  what, so it is not something a run may rewrite. If a task needs an apply, say so
  in a comment and let a person run it.
- Only a listed approver's comment decides a gate. A leader following a briefing never
  approves for a person, and never reassigns the issue away from its squad.

## Common wrong assumptions

- "Applying a workflow starts work." It only rewrites the squad's instructions. No
  issue moves until an issue carries the `wf:` label and the leader acts on it.
- "`render` changed the squad." It never does; only `apply` writes.
- "The squad's instructions are all generated." Only the text between the markers
  is; the rest belongs to whoever wrote it.
- "A newer version is live once saved." Saving adds a version; a squad keeps the
  version it was last applied with until someone applies again.
- "Validation problems stop a save." They do not; they stop render and apply.
