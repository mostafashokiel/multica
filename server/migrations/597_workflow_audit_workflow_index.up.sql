-- "What happened to this workflow", newest first. Single-statement migration
-- (see 574).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_audit_workflow_created
    ON workflow_audit(workflow_id, created_at DESC);
