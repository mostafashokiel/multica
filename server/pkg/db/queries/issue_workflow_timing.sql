-- Timing of project workflows (MUL-7420). Read-only: how long issues spent in
-- each step, measured from rows Multica already records (the status changes in
-- activity_log, the agent runs, the comments members wrote). Nothing is stored.

-- name: ListIssueStatusChanges :many
SELECT issue_id,
       COALESCE(details->>'from', '')::text AS from_status,
       COALESCE(details->>'to', '')::text AS to_status,
       created_at
FROM activity_log
WHERE issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND action = 'status_changed'
ORDER BY issue_id, created_at, id;

-- name: ListIssueRunsForTiming :many
SELECT issue_id, agent_id, started_at::timestamptz AS started_at, completed_at
FROM agent_task_queue
WHERE issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND started_at IS NOT NULL
ORDER BY issue_id, started_at, id;

-- name: ListIssueMemberCommentsForTiming :many
SELECT issue_id, author_id, created_at
FROM comment
WHERE issue_id = ANY(sqlc.arg('issue_ids')::uuid[])
  AND author_type = 'member'
  AND type = 'comment'
ORDER BY issue_id, created_at, id;

-- name: ListWorkflowIssuesForTiming :many
-- The issues of the projects that use a workflow, newest first, that were
-- created since the given time. A project without a workflow uses Default, so
-- Default also takes the projects whose workflow_id is NULL.
SELECT i.id, i.created_at, i.status
FROM issue i
JOIN project p ON p.id = i.project_id
WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND i.created_at >= sqlc.arg('since')::timestamptz
  AND (p.workflow_id = sqlc.arg('workflow_id')::uuid
       OR (sqlc.arg('is_default')::boolean AND p.workflow_id IS NULL))
ORDER BY i.created_at DESC, i.id DESC
LIMIT sqlc.arg('max_issues')::int;
