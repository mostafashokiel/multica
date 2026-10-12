DROP TRIGGER IF EXISTS capture_workflow_stage_event ON issue_to_label;
DROP FUNCTION IF EXISTS capture_workflow_stage_event();
DROP TABLE IF EXISTS workflow_stage_event;
