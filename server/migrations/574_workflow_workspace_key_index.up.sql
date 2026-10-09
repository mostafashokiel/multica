-- A workflow's key is unique within its workspace, and this index also serves
-- "the workflows of one workspace". Single-statement migration: CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction or share a migration file.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_workspace_key
    ON workflow(workspace_id, key);
