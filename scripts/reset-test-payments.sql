-- Destructive, test-only cleanup. Execute only through reset-test-payments.mjs,
-- which audits the migrated schema and refuses to continue when live or
-- ambiguous payment state exists.
PRAGMA foreign_keys = ON;

-- Restore only workspaces that are connected to explicitly test-scoped state.
-- Suspended/deleted workspaces keep their administrative status.
UPDATE workspaces
SET
  status = CASE
    WHEN status IN ('pending_payment', 'read_only') THEN 'active'
    ELSE status
  END,
  plan_key = 'self_hosted',
  billing_plan_id = NULL,
  read_only_until = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
  UNION
  SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
  UNION
  SELECT checkout.workspace_id
  FROM billing_checkout_sessions checkout
  JOIN payment_provider_accounts account
    ON account.id = checkout.payment_provider_account_id
  WHERE account.environment = 'test'
  UNION
  SELECT change.workspace_id
  FROM billing_plan_changes change
  JOIN payment_provider_accounts account
    ON account.id = change.payment_provider_account_id
  WHERE account.environment = 'test'
  UNION
  SELECT workspace_id FROM billing_events
  WHERE workspace_id IS NOT NULL
    AND (stripe_livemode = 0 OR payment_environment = 'test')
);

DELETE FROM billing_checkout_sessions
WHERE payment_provider_account_id IN (
    SELECT id FROM payment_provider_accounts WHERE environment = 'test'
  )
  OR workspace_id IN (
    SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
    UNION
    SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
  );

DELETE FROM billing_plan_changes
WHERE payment_provider_account_id IN (
    SELECT id FROM payment_provider_accounts WHERE environment = 'test'
  )
  OR workspace_id IN (
    SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
    UNION
    SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
  );

DELETE FROM billing_events
WHERE stripe_livemode = 0
  OR payment_environment = 'test'
  OR payment_provider_account_id IN (
    SELECT id FROM payment_provider_accounts WHERE environment = 'test'
  );

UPDATE billing_accounts
SET
  provider = 'self_hosted',
  payment_mode = 'disabled',
  stripe_customer_id = NULL,
  stripe_subscription_id = NULL,
  stripe_livemode = NULL,
  stripe_subscription_item_id = NULL,
  stripe_subscription_schedule_id = NULL,
  billing_synced_at = NULL,
  billing_sync_error = NULL,
  plan_key = 'self_hosted',
  billing_plan_id = NULL,
  status = 'active',
  monthly_units = COALESCE(
    (SELECT workspace.monthly_run_cap FROM workspaces workspace
     WHERE workspace.id = billing_accounts.workspace_id),
    monthly_units
  ),
  project_limit = 1000000,
  prompt_limit = 1000000,
  source_limit = 4,
  allowed_sources_json = '["chatgpt","gemini","google_ai_mode","google_ai_overview"]',
  cycle_started_at = strftime('%Y-%m-01T00:00:00.000Z', 'now'),
  cycle_ends_at = strftime('%Y-%m-01T00:00:00.000Z', 'now', '+1 month'),
  cancel_at_period_end = 0,
  read_only_until = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE stripe_livemode = 0
  OR workspace_id IN (
    SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
  );

DELETE FROM workspace_billing_subscriptions WHERE environment = 'test';

UPDATE payment_configuration
SET
  mode = 'undecided',
  enabled = 0,
  default_provider_account_id = NULL,
  updated_by_user_id = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'installation'
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_accounts WHERE environment = 'live'
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_billing_subscriptions WHERE environment = 'live'
  );

-- Credential and catalogue rows cascade. Test subscription links were removed
-- above because their account foreign key intentionally does not cascade.
DELETE FROM payment_provider_accounts WHERE environment = 'test';
