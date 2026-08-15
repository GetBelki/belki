PRAGMA foreign_keys = ON;

ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending_payment', 'active', 'read_only', 'suspended', 'deleted'));
ALTER TABLE workspaces ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'self_hosted'
  CHECK (plan_key IN ('self_hosted', 'starter', 'studio', 'agency', 'custom'));
ALTER TABLE workspaces ADD COLUMN read_only_until TEXT;
ALTER TABLE workspaces ADD COLUMN signup_code_id TEXT;
CREATE UNIQUE INDEX workspaces_signup_code_idx ON workspaces(signup_code_id);

ALTER TABLE memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended', 'removed'));

ALTER TABLE sessions ADD COLUMN active_workspace_id TEXT;
UPDATE sessions
SET active_workspace_id = (
  SELECT membership.workspace_id
  FROM memberships membership
  WHERE membership.user_id = sessions.user_id
    AND membership.status = 'active'
  ORDER BY membership.created_at, membership.workspace_id
  LIMIT 1
)
WHERE active_workspace_id IS NULL;
CREATE INDEX sessions_active_workspace_idx ON sessions(active_workspace_id, user_id);

CREATE TABLE signup_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  consumed_by_user_id TEXT,
  revoked_by_user_id TEXT,
  workspace_id TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (consumed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX signup_codes_email_idx ON signup_codes(email, expires_at);

CREATE TABLE platform_operators (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE billing_accounts (
  workspace_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'stripe'
    CHECK (provider IN ('stripe', 'manual', 'self_hosted')),
  payment_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (payment_mode IN ('disabled', 'stripe_managed', 'stripe_direct')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_livemode INTEGER CHECK (stripe_livemode IN (0, 1)),
  plan_key TEXT NOT NULL DEFAULT 'self_hosted'
    CHECK (plan_key IN ('self_hosted', 'starter', 'studio', 'agency', 'custom')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'unpaid', 'cancelled', 'paused')),
  monthly_units INTEGER NOT NULL DEFAULT 1000000 CHECK (monthly_units >= 0),
  project_limit INTEGER NOT NULL DEFAULT 1000000 CHECK (project_limit >= 0),
  cycle_started_at TEXT NOT NULL,
  cycle_ends_at TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  read_only_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'stripe',
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  stripe_livemode INTEGER CHECK (stripe_livemode IN (0, 1)),
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);
CREATE INDEX billing_events_workspace_idx ON billing_events(workspace_id, received_at DESC);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  sku TEXT NOT NULL CHECK (
    sku IN ('llm_standard', 'llm_priority_html', 'llm_live', 'entity_extraction', 'product_enrichment')
  ),
  units INTEGER NOT NULL CHECK (units > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  cycle_started_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, reservation_id, status),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX usage_events_workspace_cycle_idx
  ON usage_events(workspace_id, cycle_started_at, created_at);

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('dataforseo')),
  kind TEXT NOT NULL CHECK (kind IN ('platform', 'customer')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  credential_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO provider_accounts (
  id, provider, kind, label, status, credential_version, created_at, updated_at
) VALUES (
  'dataforseo:platform:v1', 'dataforseo', 'platform', 'Platform DataForSEO account',
  'active', 'worker-secret-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

ALTER TABLE crawl_jobs ADD COLUMN provider_account_id TEXT;
ALTER TABLE crawl_jobs ADD COLUMN usage_reservation_id TEXT;
ALTER TABLE crawl_jobs ADD COLUMN usage_units INTEGER NOT NULL DEFAULT 0;
CREATE INDEX crawl_jobs_provider_account_idx ON crawl_jobs(provider_account_id, status);

INSERT INTO billing_accounts (
  workspace_id, provider, payment_mode, plan_key, status, monthly_units, project_limit,
  cycle_started_at, cycle_ends_at, created_at, updated_at
)
SELECT
  id, 'self_hosted', 'disabled', 'self_hosted', 'active', monthly_run_cap, 1000000,
  strftime('%Y-%m-01T00:00:00.000Z', 'now'),
  strftime('%Y-%m-01T00:00:00.000Z', 'now', '+1 month'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces;

INSERT OR IGNORE INTO platform_operators (email, user_id, created_at, created_by_user_id)
SELECT user.email, user.id, user.created_at, user.id
FROM users user
JOIN memberships membership ON membership.user_id = user.id
WHERE membership.role = 'owner'
ORDER BY membership.created_at
LIMIT 1;
