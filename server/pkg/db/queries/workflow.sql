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
