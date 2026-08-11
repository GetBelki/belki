PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_audit_workspace_action_created
  ON audit_log(workspace_id, action, created_at DESC);
