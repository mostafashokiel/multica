-- name: ListWorkflows :many
-- Every member may read; whether a workflow can be edited is a handler
-- decision. LOWER(name) keeps the order stable across equal names.
SELECT * FROM workflow
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.arg('include_archived')::bool OR status = 'active')
ORDER BY LOWER(name) ASC, key ASC;

-- name: GetWorkflow :one
SELECT * FROM workflow
WHERE id = $1 AND workspace_id = $2;

-- name: GetWorkflowForUpdate :one
-- Takes the row lock a new version is written under, so two saves of the same
-- workflow are serialised and the second sees the first's version number.
SELECT * FROM workflow
WHERE id = $1 AND workspace_id = $2
FOR UPDATE;

-- name: CountActiveWorkflows :one
SELECT COUNT(*) FROM workflow
WHERE workspace_id = $1 AND status = 'active';

-- name: CreateWorkflow :one
INSERT INTO workflow (
    workspace_id, key, name, description, created_by_type, created_by_id
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('key')::text,
    sqlc.arg('name')::text,
    sqlc.arg('description')::text,
    sqlc.arg('created_by_type')::text,
    sqlc.arg('created_by_id')::uuid
)
RETURNING *;

-- name: UpdateWorkflowDetails :one
-- COALESCE-on-narg partial update of the head. `revision` is the optimistic
-- concurrency guard: the caller passes the revision it loaded and gets no row
-- back if someone changed the head since.
UPDATE workflow SET
    name = COALESCE(sqlc.narg('name'), name),
    description = COALESCE(sqlc.narg('description'), description),
    status = COALESCE(sqlc.narg('status'), status),
    revision = revision + 1,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND revision = sqlc.arg('expected_revision')::bigint
RETURNING *;

-- name: SetWorkflowLatestVersion :one
-- Called inside the transaction that inserted the version, under the row lock
-- from GetWorkflowForUpdate.
UPDATE workflow SET
    latest_version = sqlc.arg('latest_version')::int,
    revision = revision + 1,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: InsertWorkflowVersion :one
-- Versions are only ever inserted. There is deliberately no UPDATE or DELETE
-- query for this table.
INSERT INTO workflow_version (
    workspace_id, workflow_id, version, definition, content_hash, layout, note,
    created_by_type, created_by_id
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('workflow_id')::uuid,
    sqlc.arg('version')::int,
    sqlc.arg('definition')::text,
    sqlc.arg('content_hash')::text,
    sqlc.arg('layout')::jsonb,
    sqlc.arg('note')::text,
    sqlc.arg('created_by_type')::text,
    sqlc.arg('created_by_id')::uuid
)
RETURNING *;

-- name: ListWorkflowVersions :many
-- The history list leaves out the definition and layout bodies; fetch one
-- version for those.
SELECT id, workspace_id, workflow_id, version, content_hash, note,
       created_by_type, created_by_id, created_at
FROM workflow_version
WHERE workflow_id = $1 AND workspace_id = $2
ORDER BY version DESC;

-- name: GetWorkflowVersion :one
SELECT * FROM workflow_version
WHERE workflow_id = $1 AND workspace_id = $2 AND version = $3;

-- name: InsertWorkflowAudit :exec
INSERT INTO workflow_audit (
    workspace_id, workflow_id, version, action, actor_type, actor_id, detail
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('workflow_id')::uuid,
    sqlc.narg('version')::int,
    sqlc.arg('action')::text,
    sqlc.arg('actor_type')::text,
    sqlc.arg('actor_id')::uuid,
    sqlc.arg('detail')::jsonb
);

-- name: ListWorkflowAudit :many
SELECT * FROM workflow_audit
WHERE workflow_id = $1 AND workspace_id = $2
ORDER BY created_at DESC, id DESC
LIMIT $3;

-- name: ListWorkflowPipelineIssues :many
-- The issues that carry a workflow's wf:<key> label, with the names of every
-- phase:* label each one has (a healthy issue has exactly one). Cancelled issues
-- are left out. squad_id keeps only the issues assigned to that squad;
-- without_squad keeps only those not assigned to any squad. Newest activity
-- first; the caller asks for one row more than it shows so it can tell that the
-- list was cut.
SELECT i.id, i.number, i.title, i.status, i.assignee_type, i.assignee_id, i.updated_at,
    COALESCE(
        (SELECT array_agg(pl.name ORDER BY pl.name)
         FROM issue_to_label pa
         JOIN issue_label pl ON pl.id = pa.label_id
         WHERE pa.issue_id = i.id
           AND pl.workspace_id = i.workspace_id
           AND pl.resource_type = 'issue'
           AND pl.name LIKE 'phase:%'),
        '{}')::text[] AS phases
FROM issue i
WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND i.status <> 'cancelled'
  AND (sqlc.narg('squad_id')::uuid IS NULL
       OR (i.assignee_type = 'squad' AND i.assignee_id = sqlc.narg('squad_id')::uuid))
  AND (NOT sqlc.arg('without_squad')::bool
       OR i.assignee_type IS DISTINCT FROM 'squad')
  AND EXISTS (
      SELECT 1
      FROM issue_to_label wa
      JOIN issue_label wl ON wl.id = wa.label_id
      WHERE wa.issue_id = i.id
        AND wl.workspace_id = i.workspace_id
        AND wl.resource_type = 'issue'
        AND wl.name = sqlc.arg('wf_label')::text)
ORDER BY i.updated_at DESC, i.id DESC
LIMIT sqlc.arg('row_limit')::int;

-- name: ListWorkflowPipelineChildren :many
-- The sub-issues of the given issues, oldest first, with whether each one is
-- closed (its status is in a done or closed category) and whether it was
-- cancelled (closed category), how long agents have worked on it, and when it
-- was closed. Used to show the progress of a parallel stage: the leader hands
-- each branch to an agent as a sub-issue.
SELECT c.parent_issue_id, c.id, c.number, c.title, c.status, c.assignee_type, c.assignee_id,
    c.created_at, c.updated_at,
    EXISTS (SELECT 1 FROM issue_status s
            WHERE s.workspace_id = c.workspace_id AND s.key = c.status
              AND s.category IN ('done', 'closed'))::bool AS closed,
    EXISTS (SELECT 1 FROM issue_status s
            WHERE s.workspace_id = c.workspace_id AND s.key = c.status
              AND s.category = 'closed')::bool AS cancelled,
    COALESCE((SELECT sum(extract(epoch FROM (COALESCE(t.completed_at, now()) - t.started_at)))
              FROM agent_task_queue t
              WHERE t.issue_id = c.id AND t.started_at IS NOT NULL), 0)::bigint AS work_seconds,
    COALESCE((SELECT ag.name FROM agent ag WHERE ag.id = c.assignee_id AND c.assignee_type = 'agent'), '')::text AS assignee_name,
    (SELECT max(a.created_at) FROM activity_log a
     WHERE a.issue_id = c.id AND a.action = 'status_changed'
       AND a.details ->> 'to' IN (SELECT s.key FROM issue_status s
                                  WHERE s.workspace_id = c.workspace_id AND s.category IN ('done', 'closed')))::timestamptz AS closed_at
FROM issue c
WHERE c.workspace_id = sqlc.arg('workspace_id')::uuid
  AND c.parent_issue_id = ANY(sqlc.arg('parent_ids')::uuid[])
ORDER BY c.created_at, c.id
LIMIT sqlc.arg('row_limit')::int;

-- name: DeleteArchivedWorkflow :execrows
-- Removes the workflow head, but only while it is archived: an active one must be
-- archived first, and the guard holds even if someone restores it in between.
DELETE FROM workflow
WHERE id = $1 AND workspace_id = $2 AND status = 'archived';

-- name: DeleteWorkflowVersions :exec
DELETE FROM workflow_version WHERE workflow_id = $1 AND workspace_id = $2;

-- name: DeleteWorkflowAudit :exec
DELETE FROM workflow_audit WHERE workflow_id = $1 AND workspace_id = $2;

-- name: GetWorkflowByKey :one
SELECT * FROM workflow WHERE workspace_id = $1 AND key = $2;

-- name: GetIssueWorkflowKey :one
-- The key of the workflow an issue follows: its wf:<key> label.
SELECT substr(l.name, 4)::text AS key
FROM issue_to_label il
JOIN issue_label l ON l.id = il.label_id
WHERE il.issue_id = sqlc.arg('issue_id')::uuid
  AND l.workspace_id = sqlc.arg('workspace_id')::uuid
  AND l.resource_type = 'issue'
  AND l.name LIKE 'wf:%'
ORDER BY l.name
LIMIT 1;

-- name: ListWorkflowStageEvents :many
-- When the given issues entered and left their stages, in order.
SELECT issue_id, stage_id, kind, occurred_at
FROM workflow_stage_event
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
ORDER BY issue_id, occurred_at, id;

-- name: ListWorkflowRunTasks :many
-- The agent runs on the given issues (the issue itself and its sub-issues) that have started.
SELECT t.issue_id, a.name AS agent_name, t.started_at, t.completed_at
FROM agent_task_queue t
JOIN agent a ON a.id = t.agent_id
WHERE t.issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND t.started_at IS NOT NULL
  AND a.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY t.issue_id, t.started_at;

-- name: ListWorkflowRunComments :many
-- The comments people wrote on the given issues: their time is when a gate was answered.
SELECT c.issue_id, c.author_id, c.created_at
FROM comment c
WHERE c.workspace_id = sqlc.arg('workspace_id')::uuid
  AND c.issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND c.author_type = 'member'
ORDER BY c.issue_id, c.created_at
LIMIT sqlc.arg('row_limit')::int;

-- name: ListWorkflowRunIssues :many
-- The issues that follow a workflow and entered a stage since a given time, newest first.
SELECT i.id, i.number, i.title, i.status
FROM issue i
WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND EXISTS (SELECT 1 FROM issue_to_label wa JOIN issue_label wl ON wl.id = wa.label_id
              WHERE wa.issue_id = i.id AND wl.workspace_id = i.workspace_id
                AND wl.resource_type = 'issue' AND wl.name = sqlc.arg('wf_label')::text)
  AND EXISTS (SELECT 1 FROM workflow_stage_event e
              WHERE e.issue_id = i.id AND e.kind = 'entered' AND e.occurred_at >= sqlc.arg('since')::timestamptz)
ORDER BY i.created_at DESC, i.id DESC
LIMIT sqlc.arg('row_limit')::int;
