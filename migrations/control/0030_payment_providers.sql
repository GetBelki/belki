PRAGMA foreign_keys = ON;

CREATE TABLE payment_provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'dodo')),
  label TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  credential_source TEXT NOT NULL DEFAULT 'database' CHECK (
    credential_source IN ('environment', 'database')
  ),
  configuration_source TEXT NOT NULL DEFAULT 'database' CHECK (
    configuration_source IN ('environment', 'database')
  ),
  active_credential_version INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  adapter_version TEXT NOT NULL,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  webhook_endpoint_key TEXT NOT NULL UNIQUE,
  last_test_status TEXT CHECK (last_test_status IN ('passed', 'failed')),
  last_tested_at TEXT,
  last_test_message TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX payment_provider_accounts_one_default_idx
  ON payment_provider_accounts(is_default) WHERE is_default = 1;
CREATE INDEX payment_provider_accounts_status_idx
  ON payment_provider_accounts(status, provider, environment, created_at);

INSERT INTO payment_provider_accounts (
  id, provider, label, environment, status, credential_source,
  configuration_source, is_default, adapter_version, webhook_endpoint_key,
  created_at, updated_at
) SELECT
  'stripe:legacy:v1', 'stripe', 'Platform Stripe account', 'test', 'active',
  'environment', 'environment', 1, 'stripe-v1', 'stripe-legacy-v1',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE
  EXISTS (
    SELECT 1 FROM billing_accounts
    WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL
  )
  OR EXISTS (
    SELECT 1 FROM billing_checkout_sessions WHERE stripe_session_id IS NOT NULL
  )
  OR EXISTS (SELECT 1 FROM billing_plan_changes)
  OR EXISTS (SELECT 1 FROM billing_events WHERE provider = 'stripe');

CREATE TABLE payment_provider_credentials (
  provider_account_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm-hkdf-sha256'),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (provider_account_id, version),
  FOREIGN KEY (provider_account_id) REFERENCES payment_provider_accounts(id)
    ON DELETE CASCADE
);

CREATE TABLE payment_provider_plan_catalog (
  provider_account_id TEXT NOT NULL,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'studio', 'agency')),
  external_reference TEXT NOT NULL,
  external_product_id TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_account_id, plan_key),
  UNIQUE (provider_account_id, external_reference),
  FOREIGN KEY (provider_account_id) REFERENCES payment_provider_accounts(id)
    ON DELETE CASCADE
);

CREATE TABLE payment_configuration (
  id TEXT PRIMARY KEY CHECK (id = 'installation'),
  mode TEXT NOT NULL DEFAULT 'undecided'
    CHECK (mode IN ('undecided', 'self_hosted', 'managed')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_provider_account_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (default_provider_account_id) REFERENCES payment_provider_accounts(id)
    ON DELETE SET NULL
);

INSERT INTO payment_configuration (
  id, mode, enabled, default_provider_account_id, created_at, updated_at
) SELECT
  'installation',
  CASE WHEN EXISTS (
    SELECT 1 FROM payment_provider_accounts WHERE id = 'stripe:legacy:v1'
  ) THEN 'managed' ELSE 'undecided' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM payment_provider_accounts WHERE id = 'stripe:legacy:v1'
  ) THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM payment_provider_accounts WHERE id = 'stripe:legacy:v1'
  ) THEN 'stripe:legacy:v1' ELSE NULL END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
;

CREATE TABLE workspace_billing_subscriptions (
  workspace_id TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  adapter_version TEXT NOT NULL,
  provider_state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id) REFERENCES payment_provider_accounts(id)
);

CREATE UNIQUE INDEX workspace_billing_subscriptions_external_idx
  ON workspace_billing_subscriptions(provider_account_id, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE INDEX workspace_billing_subscriptions_provider_idx
  ON workspace_billing_subscriptions(provider_account_id, updated_at);

INSERT INTO workspace_billing_subscriptions (
  workspace_id, provider_account_id, external_customer_id,
  external_subscription_id, environment, adapter_version, created_at, updated_at
)
SELECT
  workspace_id, 'stripe:legacy:v1', stripe_customer_id, stripe_subscription_id,
  CASE WHEN stripe_livemode = 1 THEN 'live' ELSE 'test' END,
  'stripe-v1', created_at, updated_at
FROM billing_accounts
WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL;

ALTER TABLE billing_checkout_sessions ADD COLUMN payment_provider_account_id TEXT;
ALTER TABLE billing_checkout_sessions ADD COLUMN external_session_id TEXT;
ALTER TABLE billing_checkout_sessions ADD COLUMN adapter_version TEXT;
ALTER TABLE billing_checkout_sessions ADD COLUMN provider_state_json TEXT;

UPDATE billing_checkout_sessions SET
  payment_provider_account_id = 'stripe:legacy:v1',
  external_session_id = stripe_session_id,
  adapter_version = 'stripe-v1',
  provider_state_json = '{}'
WHERE payment_provider_account_id IS NULL
  AND stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX billing_checkout_sessions_external_idx
  ON billing_checkout_sessions(payment_provider_account_id, external_session_id)
  WHERE external_session_id IS NOT NULL;

ALTER TABLE billing_plan_changes ADD COLUMN payment_provider_account_id TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN external_subscription_id TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN external_item_id TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN external_action_id TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN external_schedule_id TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN adapter_version TEXT;
ALTER TABLE billing_plan_changes ADD COLUMN provider_state_json TEXT;

UPDATE billing_plan_changes SET
  payment_provider_account_id = 'stripe:legacy:v1',
  external_subscription_id = stripe_subscription_id,
  external_item_id = stripe_subscription_item_id,
  external_action_id = stripe_portal_session_id,
  external_schedule_id = stripe_subscription_schedule_id,
  adapter_version = 'stripe-v1',
  provider_state_json = '{}'
WHERE payment_provider_account_id IS NULL
  AND stripe_subscription_id IS NOT NULL;

ALTER TABLE billing_events ADD COLUMN payment_provider_account_id TEXT;
ALTER TABLE billing_events ADD COLUMN external_event_id TEXT;
ALTER TABLE billing_events ADD COLUMN payment_environment TEXT;
ALTER TABLE billing_events ADD COLUMN credential_version INTEGER;
ALTER TABLE billing_events ADD COLUMN adapter_version TEXT;

UPDATE billing_events SET
  payment_provider_account_id = 'stripe:legacy:v1',
  external_event_id = id,
  payment_environment = CASE WHEN stripe_livemode = 1 THEN 'live' ELSE 'test' END,
  adapter_version = 'stripe-v1'
WHERE provider = 'stripe' AND payment_provider_account_id IS NULL;

CREATE UNIQUE INDEX billing_events_provider_external_idx
  ON billing_events(payment_provider_account_id, external_event_id)
  WHERE payment_provider_account_id IS NOT NULL AND external_event_id IS NOT NULL;
CREATE INDEX billing_events_provider_status_idx
  ON billing_events(payment_provider_account_id, processed_at, received_at);
