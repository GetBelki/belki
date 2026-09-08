-- Extend provider/platform checks without rebuilding parent tables.
-- Replace checked non-key columns in place; rebuild only leaf tables.
-- Explicit column lists preserve data even when column order changes.
PRAGMA defer_foreign_keys = ON;


-- crawl_jobs

DROP INDEX "idx_jobs_status_time";

DROP INDEX "idx_jobs_query_time";

DROP INDEX "idx_jobs_query_created_seek";

DROP INDEX "crawl_jobs_provider_account_idx";

DROP INDEX "crawl_jobs_source_schedule_idx";

DROP INDEX "crawl_jobs_source_status_idx";

DROP INDEX "idx_jobs_query_source_created_seek";

ALTER TABLE crawl_jobs ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE crawl_jobs SET tracking_source_olostep = tracking_source;

ALTER TABLE crawl_jobs DROP COLUMN tracking_source;

ALTER TABLE crawl_jobs RENAME COLUMN tracking_source_olostep TO tracking_source;

ALTER TABLE crawl_jobs ADD COLUMN capture_provider_olostep TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider_olostep IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep'));

UPDATE crawl_jobs SET capture_provider_olostep = capture_provider;

ALTER TABLE crawl_jobs DROP COLUMN capture_provider;

ALTER TABLE crawl_jobs RENAME COLUMN capture_provider_olostep TO capture_provider;

CREATE INDEX idx_jobs_status_time ON crawl_jobs(status, created_at);

CREATE INDEX idx_jobs_query_time ON crawl_jobs(tracked_query_id, scheduled_for DESC);

CREATE INDEX idx_jobs_query_created_seek
  ON crawl_jobs(tracked_query_id, created_at DESC, id DESC);

CREATE INDEX crawl_jobs_provider_account_idx ON crawl_jobs(provider_account_id, status);

CREATE UNIQUE INDEX crawl_jobs_source_schedule_idx
  ON crawl_jobs(tracked_query_id, tracking_source, scheduled_for, run_type);

CREATE INDEX crawl_jobs_source_status_idx ON crawl_jobs(tracking_source, status, created_at);

CREATE INDEX idx_jobs_query_source_created_seek
  ON crawl_jobs(tracked_query_id, tracking_source, created_at DESC, id DESC);


-- snapshot_index

DROP INDEX "idx_snapshot_project_time";

DROP INDEX "idx_snapshot_query_time";

DROP INDEX "idx_snapshot_project_time_seek";

DROP INDEX "idx_snapshot_query_time_seek";

DROP INDEX "snapshot_index_project_source_time_idx";

DROP INDEX "idx_snapshot_query_source_time_seek";

DROP INDEX "snapshot_index_capture_provider_idx";

ALTER TABLE snapshot_index ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE snapshot_index SET tracking_source_olostep = tracking_source;

ALTER TABLE snapshot_index DROP COLUMN tracking_source;

ALTER TABLE snapshot_index RENAME COLUMN tracking_source_olostep TO tracking_source;

ALTER TABLE snapshot_index ADD COLUMN capture_provider_olostep TEXT NOT NULL DEFAULT 'dataforseo'
  CHECK (capture_provider_olostep IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep'));

UPDATE snapshot_index SET capture_provider_olostep = capture_provider;

ALTER TABLE snapshot_index DROP COLUMN capture_provider;

ALTER TABLE snapshot_index RENAME COLUMN capture_provider_olostep TO capture_provider;

CREATE INDEX idx_snapshot_project_time ON snapshot_index(project_id, captured_at DESC);

CREATE INDEX idx_snapshot_query_time ON snapshot_index(tracked_query_id, captured_at DESC);

CREATE INDEX idx_snapshot_project_time_seek
  ON snapshot_index(project_id, captured_at DESC, id DESC);

CREATE INDEX idx_snapshot_query_time_seek
  ON snapshot_index(tracked_query_id, captured_at DESC, id DESC);

CREATE INDEX snapshot_index_project_source_time_idx
  ON snapshot_index(project_id, tracking_source, captured_at DESC);

CREATE INDEX idx_snapshot_query_source_time_seek
  ON snapshot_index(tracked_query_id, tracking_source, captured_at DESC, id DESC);

CREATE INDEX snapshot_index_capture_provider_idx
  ON snapshot_index(capture_provider, captured_at DESC, id DESC);


-- metric_contributions

DROP INDEX "idx_metric_contributions_project_date_query";

ALTER TABLE metric_contributions ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE metric_contributions SET tracking_source_olostep = tracking_source;

ALTER TABLE metric_contributions DROP COLUMN tracking_source;

ALTER TABLE metric_contributions RENAME COLUMN tracking_source_olostep TO tracking_source;

CREATE INDEX idx_metric_contributions_project_date_query
  ON metric_contributions(project_id, metric_date, tracked_query_id, snapshot_id);


-- alert_rules

ALTER TABLE alert_rules ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE alert_rules SET tracking_source_olostep = tracking_source;

ALTER TABLE alert_rules DROP COLUMN tracking_source;

ALTER TABLE alert_rules RENAME COLUMN tracking_source_olostep TO tracking_source;


-- analytics_snapshot_facts

DROP INDEX "idx_analytics_snapshot_project_time";

DROP INDEX "idx_analytics_snapshot_query_time";

DROP INDEX "analytics_snapshot_project_source_time_idx";

DROP INDEX "analytics_snapshot_metric_source_idx";

DROP INDEX "idx_analytics_snapshot_project_source_date_query";

DROP INDEX "analytics_snapshot_facts_fanout_model_idx";

ALTER TABLE analytics_snapshot_facts ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt'
  CHECK (tracking_source_olostep IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'));

UPDATE analytics_snapshot_facts SET tracking_source_olostep = tracking_source;

ALTER TABLE analytics_snapshot_facts DROP COLUMN tracking_source;

ALTER TABLE analytics_snapshot_facts RENAME COLUMN tracking_source_olostep TO tracking_source;

CREATE INDEX idx_analytics_snapshot_project_time
  ON analytics_snapshot_facts(project_id, captured_at DESC, snapshot_id DESC);

CREATE INDEX idx_analytics_snapshot_query_time
  ON analytics_snapshot_facts(tracked_query_id, captured_at DESC, snapshot_id DESC);

CREATE INDEX analytics_snapshot_project_source_time_idx
  ON analytics_snapshot_facts(project_id, tracking_source, captured_at DESC, snapshot_id DESC);

CREATE INDEX analytics_snapshot_metric_source_idx
  ON analytics_snapshot_facts(metric_date, tracking_source, snapshot_id);

CREATE INDEX idx_analytics_snapshot_project_source_date_query
  ON analytics_snapshot_facts(
    project_id,
    tracking_source,
    metric_date,
    tracked_query_id
  );

CREATE INDEX analytics_snapshot_facts_fanout_model_idx
  ON analytics_snapshot_facts(
    metric_date, tracking_source, provider_model, fan_out_telemetry_status,
    snapshot_id
  );


-- billing_accounts

DROP INDEX "billing_accounts_schedule_idx";

DROP INDEX "billing_accounts_billing_plan_idx";

ALTER TABLE billing_accounts ADD COLUMN source_limit_olostep INTEGER NOT NULL DEFAULT 4
  CHECK (source_limit_olostep BETWEEN 0 AND 6);

UPDATE billing_accounts SET source_limit_olostep = source_limit;

ALTER TABLE billing_accounts DROP COLUMN source_limit;

ALTER TABLE billing_accounts RENAME COLUMN source_limit_olostep TO source_limit;

CREATE INDEX billing_accounts_schedule_idx
  ON billing_accounts(stripe_subscription_schedule_id)
  WHERE stripe_subscription_schedule_id IS NOT NULL;

CREATE INDEX billing_accounts_billing_plan_idx
  ON billing_accounts(billing_plan_id, status, updated_at);


-- project_tracking_sources

CREATE TABLE project_tracking_sources_olostep (
  project_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO project_tracking_sources_olostep ("project_id", "source", "enabled", "created_at", "updated_at") SELECT "project_id", "source", "enabled", "created_at", "updated_at" FROM project_tracking_sources;

DROP TABLE project_tracking_sources;

ALTER TABLE project_tracking_sources_olostep RENAME TO project_tracking_sources;


-- analytics_brand_snapshot_metrics

DROP INDEX "analytics_brand_snapshot_project_revision_date_idx";

ALTER TABLE analytics_brand_snapshot_metrics ADD COLUMN tracking_source_olostep TEXT NOT NULL DEFAULT 'chatgpt' CHECK (tracking_source_olostep IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  ));

UPDATE analytics_brand_snapshot_metrics SET tracking_source_olostep = tracking_source;

ALTER TABLE analytics_brand_snapshot_metrics DROP COLUMN tracking_source;

ALTER TABLE analytics_brand_snapshot_metrics RENAME COLUMN tracking_source_olostep TO tracking_source;

CREATE INDEX analytics_brand_snapshot_project_revision_date_idx
  ON analytics_brand_snapshot_metrics(
    project_id, brand_metrics_revision, tracking_source, metric_date, snapshot_id
  );


-- analytics_daily_brand_metrics

CREATE TABLE analytics_daily_brand_metrics_olostep (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  metric_date TEXT NOT NULL,
  brand_metrics_revision INTEGER NOT NULL,
  tracked_brand_id TEXT NOT NULL,
  mentioned_response_count INTEGER NOT NULL DEFAULT 0,
  position_sum REAL NOT NULL DEFAULT 0,
  position_sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    project_id, tracking_source, metric_date,
    brand_metrics_revision, tracked_brand_id
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (tracked_brand_id) REFERENCES tracked_brands(id) ON DELETE CASCADE
);

INSERT INTO analytics_daily_brand_metrics_olostep ("project_id", "tracking_source", "metric_date", "brand_metrics_revision", "tracked_brand_id", "mentioned_response_count", "position_sum", "position_sample_count", "updated_at") SELECT "project_id", "tracking_source", "metric_date", "brand_metrics_revision", "tracked_brand_id", "mentioned_response_count", "position_sum", "position_sample_count", "updated_at" FROM analytics_daily_brand_metrics;

DROP TABLE analytics_daily_brand_metrics;

ALTER TABLE analytics_daily_brand_metrics_olostep RENAME TO analytics_daily_brand_metrics;

CREATE INDEX analytics_daily_brand_project_revision_source_date_idx
  ON analytics_daily_brand_metrics(
    project_id, brand_metrics_revision, tracking_source,
    metric_date, tracked_brand_id
  );


-- analytics_daily_owned_brand_metrics

CREATE TABLE analytics_daily_owned_brand_metrics_olostep (
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  metric_date TEXT NOT NULL,
  brand_metrics_revision INTEGER NOT NULL,
  mentioned_response_count INTEGER NOT NULL DEFAULT 0,
  position_sum REAL NOT NULL DEFAULT 0,
  position_sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    project_id, tracking_source, metric_date, brand_metrics_revision
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO analytics_daily_owned_brand_metrics_olostep ("project_id", "tracking_source", "metric_date", "brand_metrics_revision", "mentioned_response_count", "position_sum", "position_sample_count", "updated_at") SELECT "project_id", "tracking_source", "metric_date", "brand_metrics_revision", "mentioned_response_count", "position_sum", "position_sample_count", "updated_at" FROM analytics_daily_owned_brand_metrics;

DROP TABLE analytics_daily_owned_brand_metrics;

ALTER TABLE analytics_daily_owned_brand_metrics_olostep RENAME TO analytics_daily_owned_brand_metrics;

CREATE INDEX analytics_daily_owned_brand_project_revision_source_date_idx
  ON analytics_daily_owned_brand_metrics(
    project_id, brand_metrics_revision, tracking_source, metric_date
  );


-- project_events

DROP INDEX "idx_project_events_project_date";

DROP INDEX "idx_project_events_project_source_date";

ALTER TABLE project_events ADD COLUMN tracking_source_olostep TEXT CHECK (
    tracking_source_olostep IS NULL OR tracking_source_olostep IN (
      'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
    )
  );

UPDATE project_events SET tracking_source_olostep = tracking_source;

ALTER TABLE project_events DROP COLUMN tracking_source;

ALTER TABLE project_events RENAME COLUMN tracking_source_olostep TO tracking_source;

CREATE INDEX idx_project_events_project_date
  ON project_events(project_id, event_date, occurred_at, id);

CREATE INDEX idx_project_events_project_source_date
  ON project_events(project_id, tracking_source, event_date, event_type);


-- analytics_citation_url_first_seen

CREATE TABLE analytics_citation_url_first_seen_olostep (
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  canonical_url TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracking_source, canonical_url)
);

INSERT INTO analytics_citation_url_first_seen_olostep ("tracking_source", "canonical_url", "registrable_domain", "first_seen_at", "first_seen_date", "updated_at") SELECT "tracking_source", "canonical_url", "registrable_domain", "first_seen_at", "first_seen_date", "updated_at" FROM analytics_citation_url_first_seen;

DROP TABLE analytics_citation_url_first_seen;

ALTER TABLE analytics_citation_url_first_seen_olostep RENAME TO analytics_citation_url_first_seen;

CREATE INDEX analytics_citation_url_first_seen_date_idx
  ON analytics_citation_url_first_seen(
    tracking_source, first_seen_date, canonical_url
  );


-- analytics_citation_domain_first_seen

CREATE TABLE analytics_citation_domain_first_seen_olostep (
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  registrable_domain TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracking_source, registrable_domain)
);

INSERT INTO analytics_citation_domain_first_seen_olostep ("tracking_source", "registrable_domain", "first_seen_at", "first_seen_date", "updated_at") SELECT "tracking_source", "registrable_domain", "first_seen_at", "first_seen_date", "updated_at" FROM analytics_citation_domain_first_seen;

DROP TABLE analytics_citation_domain_first_seen;

ALTER TABLE analytics_citation_domain_first_seen_olostep RENAME TO analytics_citation_domain_first_seen;

CREATE INDEX analytics_citation_domain_first_seen_date_idx
  ON analytics_citation_domain_first_seen(
    tracking_source, first_seen_date, registrable_domain
  );


-- capture_provider_accounts

DROP INDEX "capture_provider_accounts_one_default_idx";

DROP INDEX "capture_provider_accounts_routing_idx";

ALTER TABLE capture_provider_accounts ADD COLUMN provider_olostep TEXT NOT NULL DEFAULT 'dataforseo' CHECK (
    provider_olostep IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep')
  );

UPDATE capture_provider_accounts SET provider_olostep = provider;

ALTER TABLE capture_provider_accounts DROP COLUMN provider;

ALTER TABLE capture_provider_accounts RENAME COLUMN provider_olostep TO provider;

CREATE UNIQUE INDEX capture_provider_accounts_one_default_idx
  ON capture_provider_accounts(is_default) WHERE is_default = 1;

CREATE INDEX capture_provider_accounts_routing_idx
  ON capture_provider_accounts(status, priority, created_at);


-- capture_provider_routes

CREATE TABLE capture_provider_routes_olostep (
  tracking_source TEXT PRIMARY KEY CHECK (
    tracking_source IN ('chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  provider_account_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_account_id) REFERENCES capture_provider_accounts(id)
    ON DELETE SET NULL
);

INSERT INTO capture_provider_routes_olostep ("tracking_source", "enabled", "provider_account_id", "updated_by_user_id", "created_at", "updated_at") SELECT "tracking_source", "enabled", "provider_account_id", "updated_by_user_id", "created_at", "updated_at" FROM capture_provider_routes;

DROP TABLE capture_provider_routes;

ALTER TABLE capture_provider_routes_olostep RENAME TO capture_provider_routes;


-- capture_provider_attempts

DROP INDEX "capture_provider_attempts_external_task_idx";

DROP INDEX "capture_provider_attempts_job_status_idx";

DROP INDEX "capture_provider_attempts_provider_status_idx";

DROP INDEX "capture_provider_attempts_activity_idx";

ALTER TABLE capture_provider_attempts ADD COLUMN provider_olostep TEXT NOT NULL DEFAULT 'dataforseo' CHECK (
    provider_olostep IN ('dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep')
  );

UPDATE capture_provider_attempts SET provider_olostep = provider;

ALTER TABLE capture_provider_attempts DROP COLUMN provider;

ALTER TABLE capture_provider_attempts RENAME COLUMN provider_olostep TO provider;

CREATE UNIQUE INDEX capture_provider_attempts_external_task_idx
  ON capture_provider_attempts(provider_account_id, external_task_id)
  WHERE external_task_id IS NOT NULL;

CREATE INDEX capture_provider_attempts_job_status_idx
  ON capture_provider_attempts(crawl_job_id, status, attempt_number);

CREATE INDEX capture_provider_attempts_provider_status_idx
  ON capture_provider_attempts(provider, status, created_at);

CREATE INDEX capture_provider_attempts_activity_idx
  ON capture_provider_attempts(created_at, provider_account_id, status);


-- project_capture_provider_events

CREATE TABLE project_capture_provider_events_olostep (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tracking_source TEXT NOT NULL CHECK (tracking_source IN (
    'chatgpt', 'gemini', 'google_ai_mode', 'google_ai_overview', 'perplexity', 'copilot'
  )),
  capture_provider TEXT NOT NULL CHECK (capture_provider IN (
    'dataforseo', 'brightdata', 'cloro', 'oxylabs', 'olostep'
  )),
  event_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, tracking_source, capture_provider),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO project_capture_provider_events_olostep ("id", "project_id", "tracking_source", "capture_provider", "event_date", "occurred_at", "created_at", "updated_at") SELECT "id", "project_id", "tracking_source", "capture_provider", "event_date", "occurred_at", "created_at", "updated_at" FROM project_capture_provider_events;

DROP TABLE project_capture_provider_events;

ALTER TABLE project_capture_provider_events_olostep RENAME TO project_capture_provider_events;

CREATE INDEX idx_project_capture_provider_events_project_date
  ON project_capture_provider_events(
    project_id, event_date, tracking_source, occurred_at, id
  );


-- Operators explicitly enable the newly available platforms after connecting a provider.
INSERT INTO capture_provider_routes (tracking_source, enabled, provider_account_id, created_at, updated_at)
VALUES ('perplexity', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       ('copilot', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Self-hosted installations have access to every platform. Managed plan entitlements
-- remain operator-controlled and can be expanded through billing settings.
UPDATE billing_accounts SET source_limit = 6,
  allowed_sources_json = '["chatgpt","gemini","google_ai_mode","google_ai_overview","perplexity","copilot"]'
WHERE plan_key = 'self_hosted';


PRAGMA defer_foreign_keys = OFF;
