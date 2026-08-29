PRAGMA foreign_keys = ON;

CREATE TABLE billing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  monthly_units INTEGER NOT NULL CHECK (monthly_units > 0),
  project_limit INTEGER NOT NULL CHECK (project_limit > 0),
  prompt_limit INTEGER NOT NULL CHECK (prompt_limit > 0),
  source_limit INTEGER NOT NULL CHECK (source_limit > 0),
  allowed_sources_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX billing_plans_status_order_idx
  ON billing_plans(status, sort_order, id);

INSERT INTO billing_plans (
  id, name, description, sort_order, is_featured, status,
  monthly_units, project_limit, prompt_limit, source_limit,
  allowed_sources_json, created_at, updated_at
) VALUES
  ('starter', 'Starter', 'A single brand getting started', 0, 0, 'active',
    4000, 1, 25, 1, '["chatgpt"]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('studio', 'Studio', 'Growing teams and consultants', 1, 1, 'active',
    20000, 5, 75, 2,
    '["chatgpt","gemini","google_ai_mode","google_ai_overview"]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('agency', 'Agency', 'Agencies and multi-brand teams', 2, 0, 'active',
    125000, 30, 250, 4,
    '["chatgpt","gemini","google_ai_mode","google_ai_overview"]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE workspaces ADD COLUMN billing_plan_id TEXT
  REFERENCES billing_plans(id);
ALTER TABLE billing_accounts ADD COLUMN billing_plan_id TEXT
  REFERENCES billing_plans(id);
ALTER TABLE billing_accounts ADD COLUMN allowed_sources_json TEXT NOT NULL DEFAULT
  '["chatgpt","gemini","google_ai_mode","google_ai_overview"]';
ALTER TABLE billing_checkout_sessions ADD COLUMN billing_plan_id TEXT
  REFERENCES billing_plans(id);
ALTER TABLE billing_plan_changes ADD COLUMN from_billing_plan_id TEXT
  REFERENCES billing_plans(id);
ALTER TABLE billing_plan_changes ADD COLUMN to_billing_plan_id TEXT
  REFERENCES billing_plans(id);

UPDATE workspaces SET billing_plan_id = plan_key
WHERE plan_key IN ('starter', 'studio', 'agency');
UPDATE billing_accounts SET billing_plan_id = plan_key
WHERE plan_key IN ('starter', 'studio', 'agency');
UPDATE billing_accounts SET allowed_sources_json = CASE plan_key
  WHEN 'starter' THEN '["chatgpt"]'
  ELSE '["chatgpt","gemini","google_ai_mode","google_ai_overview"]'
END;
UPDATE billing_checkout_sessions SET billing_plan_id = plan_key;
UPDATE billing_plan_changes SET
  from_billing_plan_id = from_plan_key,
  to_billing_plan_id = to_plan_key;

CREATE INDEX workspaces_billing_plan_idx
  ON workspaces(billing_plan_id, status, created_at);
CREATE INDEX billing_accounts_billing_plan_idx
  ON billing_accounts(billing_plan_id, status, updated_at);
CREATE INDEX billing_checkout_sessions_plan_idx
  ON billing_checkout_sessions(billing_plan_id, status, updated_at);
CREATE INDEX billing_plan_changes_dynamic_plan_idx
  ON billing_plan_changes(to_billing_plan_id, status, updated_at);

CREATE TABLE payment_provider_plan_mappings (
  provider_account_id TEXT NOT NULL,
  billing_plan_id TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  external_product_id TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_account_id, billing_plan_id),
  UNIQUE (provider_account_id, external_reference),
  FOREIGN KEY (provider_account_id) REFERENCES payment_provider_accounts(id)
    ON DELETE CASCADE,
  FOREIGN KEY (billing_plan_id) REFERENCES billing_plans(id)
);

INSERT INTO payment_provider_plan_mappings (
  provider_account_id, billing_plan_id, external_reference, external_product_id,
  currency, amount_minor, billing_interval, created_at, updated_at
)
SELECT
  provider_account_id, plan_key, external_reference, external_product_id,
  currency, amount_minor, billing_interval, created_at, updated_at
FROM payment_provider_plan_catalog;
