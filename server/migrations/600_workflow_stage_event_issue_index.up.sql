-- "The moves of this issue, in order." Single-statement migration (see 574).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_stage_event_issue
    ON workflow_stage_event(issue_id, occurred_at);
