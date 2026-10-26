DELETE FROM workflow_audit WHERE action = 'apply';
ALTER TABLE workflow_audit DROP CONSTRAINT workflow_audit_action_check;
ALTER TABLE workflow_audit ADD CONSTRAINT workflow_audit_action_check
    CHECK (action IN ('create', 'save', 'restore', 'archive', 'unarchive', 'rename'));
