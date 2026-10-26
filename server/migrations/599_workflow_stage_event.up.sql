-- When an issue entered and left each stage of a workflow, so that time in a stage can be measured.
--
-- A stage is the issue's phase:<stage> label (see the leader briefing), so this records the label
-- changes: a label added is `entered`, a label removed is `left`. A trigger on issue_to_label writes
-- the rows, which keeps the record complete whoever changes a label (the leader, a person, the CLI)
-- and costs one primary-key lookup per label change. Issues that were moved before this table existed
-- are filled in below from the leader's own "Moved from X to Y" comments, marked source = 'backfill'.
--
-- No foreign keys, per the database rules: rows go with their issue's workspace
-- (workspace_delete.sql) and are ignored for an issue that no longer exists.
CREATE TABLE workflow_stage_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    stage_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('entered', 'left')),
    source TEXT NOT NULL DEFAULT 'label' CHECK (source IN ('label', 'backfill')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION capture_workflow_stage_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    row_issue UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
    row_label UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.label_id ELSE NEW.label_id END;
    label_name TEXT;
    ws UUID;
BEGIN
    SELECT name INTO label_name FROM issue_label WHERE id = row_label AND resource_type = 'issue';
    IF label_name IS NULL OR label_name NOT LIKE 'phase:%' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    -- The issue (or its label) is being deleted: there is nothing left to measure.
    SELECT workspace_id INTO ws FROM issue WHERE id = row_issue;
    IF ws IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    INSERT INTO workflow_stage_event (workspace_id, issue_id, stage_id, kind)
    VALUES (ws, row_issue, substr(label_name, 7), CASE WHEN TG_OP = 'INSERT' THEN 'entered' ELSE 'left' END);
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER capture_workflow_stage_event
    AFTER INSERT OR DELETE ON issue_to_label
    FOR EACH ROW EXECUTE FUNCTION capture_workflow_stage_event();

-- Backfill: the briefing makes the leader record every move in one comment that starts
-- "Moved from <phase:old or (start)> to <phase:new>", and the comment's time is the move's time.
WITH moves AS (
    SELECT c.workspace_id, c.issue_id, c.created_at,
           regexp_match(c.content, '^Moved from (\(start\)|phase:[a-z0-9-]+) to phase:([a-z0-9-]+)') AS m
    FROM comment c
    WHERE c.author_type = 'agent' AND c.content LIKE 'Moved from %'
), parsed AS (
    SELECT workspace_id, issue_id, created_at, m[1] AS from_stage, m[2] AS to_stage
    FROM moves WHERE m IS NOT NULL
)
INSERT INTO workflow_stage_event (workspace_id, issue_id, stage_id, kind, source, occurred_at)
SELECT workspace_id, issue_id, substr(from_stage, 7), 'left', 'backfill', created_at
FROM parsed WHERE from_stage <> '(start)'
UNION ALL
SELECT workspace_id, issue_id, to_stage, 'entered', 'backfill', created_at
FROM parsed;

-- The index lives in the next, single-statement migration (CREATE INDEX CONCURRENTLY).
