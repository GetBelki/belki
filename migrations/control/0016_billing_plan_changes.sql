PRAGMA foreign_keys = ON;

ALTER TABLE billing_accounts ADD COLUMN stripe_subscription_item_id TEXT;
ALTER TABLE billing_accounts ADD COLUMN stripe_subscription_schedule_id TEXT;
ALTER TABLE billing_accounts ADD COLUMN billing_synced_at TEXT;
ALTER TABLE billing_accounts ADD COLUMN billing_sync_error TEXT;
ALTER TABLE billing_events ADD COLUMN processing_started_at TEXT;

CREATE INDEX billing_accounts_schedule_idx
  ON billing_accounts(stripe_subscription_schedule_id)
  WHERE stripe_subscription_schedule_id IS NOT NULL;

CREATE TABLE billing_plan_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  requested_by_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('upgrade', 'downgrade')),
  status TEXT NOT NULL CHECK (status IN (
    'pending_customer', 'creating', 'updating', 'scheduled', 'releasing',
    'applied', 'cancelled', 'superseded', 'expired', 'failed'
  )),
  from_plan_key TEXT NOT NULL CHECK (from_plan_key IN ('starter', 'studio', 'agency')),
  to_plan_key TEXT NOT NULL CHECK (to_plan_key IN ('starter', 'studio', 'agency')),
  stripe_subscription_id TEXT NOT NULL,
  stripe_subscription_item_id TEXT,
  stripe_portal_session_id TEXT,
  stripe_subscription_schedule_id TEXT,
  effective_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX billing_plan_changes_workspace_idx
  ON billing_plan_changes(workspace_id, created_at DESC);
CREATE INDEX billing_plan_changes_reconcile_idx
  ON billing_plan_changes(status, effective_at, updated_at);
CREATE UNIQUE INDEX billing_plan_changes_active_schedule_idx
  ON billing_plan_changes(workspace_id)
  WHERE status IN ('creating', 'updating', 'scheduled', 'releasing');

CREATE TABLE billing_checkout_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'studio', 'agency')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'completed', 'expired', 'failed')),
  stripe_session_id TEXT,
  checkout_url TEXT,
  expires_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX billing_checkout_sessions_stripe_idx
  ON billing_checkout_sessions(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX billing_checkout_sessions_active_idx
  ON billing_checkout_sessions(workspace_id)
  WHERE status IN ('creating', 'open');
CREATE INDEX billing_checkout_sessions_reconcile_idx
  ON billing_checkout_sessions(status, expires_at, updated_at);
