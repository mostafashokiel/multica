-- One row per (workflow, version): the uniqueness is what stops two concurrent
-- saves from both becoming version N, and the index serves "the versions of
-- one workflow". Single-statement migration (see 574).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_version_workflow_version
    ON workflow_version(workflow_id, version);
