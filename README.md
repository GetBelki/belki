# Belki

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xyborg/AI-Visibility-Tracker)

Self-hosted ChatGPT web visibility tracking on Cloudflare. Belki schedules
DataForSEO LLM Scraper runs, stores normalized evidence, and reports citations,
retrieved domains, contextual entities, shopping results, and visibility changes.

The implementation is designed for multi-user installations and at least one
million runs per month. It uses a control D1 database plus 32 snapshot D1
shards, queue-backed ingestion, and R2 for raw evidence and exports.

## What is included

- React 19 dashboard with projects, tracked prompts, snapshots, evidence,
  domains, brands, products, alerts, exports, users, and settings
- Shared prompt tags with bulk assignment, stable color labels, and match-all
  filtering across single and bulk prompt workflows
- Local password authentication, CSRF protection, role-based access, manual
  invitation links, and manual password-reset links
- Daily and weekly schedules evaluated in each query's IANA timezone
- DataForSEO Standard postbacks for monitoring and Live Advanced runs for
  manual refreshes
- Recovery through `tasks_ready`, signed provider tags, idempotent ingestion,
  queue retries, and dead-letter queues
- Normalized D1 analytics and streamed gzip evidence/export storage in R2
- Cross-industry named entity extraction with exact-answer validation,
  competitor discovery, evidence, confidence, and guarded automatic tracking
- Separate estimated Workers AI inference reporting, usage warnings, pause
  controls, and preserved billing totals when prompts are deleted
- Permanent single and bulk prompt deletion with asynchronous D1/R2 cleanup,
  export invalidation, and anonymous billing-total preservation
- In-app alerts and HMAC-signed HTTPS webhooks
- Twelve-month hot snapshots, two-year raw evidence, opt-in 90-day HTML
  evidence, and seven-day export retention

## Architecture

```mermaid
flowchart LR
  UI[React SPA] --> API[Hono Worker API]
  Cron[Worker crons] --> SQ[Standard queue]
  API --> LQ[Live queue]
  SQ --> DFS[DataForSEO LLM Scraper]
  LQ --> DFS
  DFS --> Hook[Signed postback]
  Hook --> R2[(R2 evidence)]
  Hook --> NQ[Normalize queue]
  NQ --> Shards[(32 snapshot D1 shards)]
  NQ --> Control[(Control D1)]
  NQ --> EQ[Entity extraction queue]
  EQ --> WAI[Workers AI]
  EQ --> Control
  Shards --> RQ[Rollup queue]
  RQ --> Control
  Control --> Alerts[Alerts / webhook queue]
  API --> Control
  API --> Shards
  API --> R2
```

The control database owns tenancy, auth, scheduling, job state, compact
snapshot indexes, rollups, alerts, and exports. A tracked query is assigned to
one snapshot shard for its lifetime, keeping detail reads local and avoiding
cross-database joins.

## Requirements

- Node.js 24 or newer
- pnpm 11
- A Cloudflare account with Workers Paid
- DataForSEO API credentials with ChatGPT LLM Scraper access

Workers Paid is required for the default architecture because it provisions one
control database and 32 snapshot databases. Workers Free currently allows only
10 D1 databases per account.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Fill `.dev.vars` with DataForSEO credentials and three independently generated,
high-entropy secrets. `BOOTSTRAP_TOKEN` is entered once in the first-run setup
screen. `APP_CRYPTO_KEY` signs provider job tags; changing it invalidates
outstanding jobs. `DATAFORSEO_WEBHOOK_TOKEN` protects the postback endpoint.

For locally posted Standard tasks, DataForSEO must be able to reach the Worker.
Use a deployed staging Worker or a secure public tunnel and ensure the
workspace's `public_base_url` points to it. Live manual runs work without an
inbound postback.

## Cloudflare deployment

### Deploy button

The button at the top of this README deploys a copy into the selected Cloudflare
account, provisions the declared D1, R2, and Queue resources, prompts for the
five required secrets, applies all D1 migrations, and connects the resulting
repository to Workers Builds.

Cloudflare requires the source repository to be public for this flow. While
`Xyborg/AI-Visibility-Tracker` remains private, use the private-repository
instructions below instead. Keep the default resource names during setup so the
checked-in R2 lifecycle command continues to target the provisioned bucket.

The requested secrets are:

- `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` — DataForSEO API credentials
- `DATAFORSEO_WEBHOOK_TOKEN` — a unique high-entropy postback token
- `APP_CRYPTO_KEY` — an independent high-entropy signing key
- `BOOTSTRAP_TOKEN` — an independent high-entropy first-run token

### Deploy from this private GitHub repository

1. In Cloudflare, open **Workers & Pages**, select **Create application**, and
   choose **Import a repository**.
2. Authorize the Cloudflare GitHub App for this private repository and select
   `Xyborg/AI-Visibility-Tracker`.
3. Use `main` as the production branch, `/` as the root directory,
   `pnpm build` as the build command, and `pnpm deploy` as the deploy command.
4. Keep the Worker name `ai-tracker`, matching `wrangler.jsonc`.
5. After the Worker is created, add the five values above as encrypted runtime
   secrets under **Settings → Variables & Secrets**.
6. Run `pnpm r2:lifecycle` once from an authenticated local checkout to install
   the evidence-retention policy.

Future pushes to `main` will deploy automatically through Workers Builds.
Non-production branch builds can be enabled in Cloudflare to receive preview
URLs on pull requests.

### Deploy with Wrangler

Authenticate Wrangler, then run:

```bash
pnpm build
pnpm deploy
pnpm r2:lifecycle
```

Wrangler provisions resources declared in `wrangler.jsonc` when they do not
exist. The deploy script publishes the Worker and applies the control migration
plus the same snapshot migration to all 32 shards. The lifecycle command
replaces the `ai-tracker-evidence` bucket lifecycle with the checked-in
prefix-specific retention policy.

Set production secrets before completing setup:

```bash
pnpm wrangler secret put DATAFORSEO_LOGIN
pnpm wrangler secret put DATAFORSEO_PASSWORD
pnpm wrangler secret put DATAFORSEO_WEBHOOK_TOKEN
pnpm wrangler secret put APP_CRYPTO_KEY
pnpm wrangler secret put BOOTSTRAP_TOKEN
```

## Operations

| Schedule | Responsibility |
|---|---|
| Every 5 minutes | Enqueue due queries and recover stale submissions |
| Every minute | Collect failed/missed postbacks, reconcile prompt purges and entity extraction, and advance analytics backfills |
| Daily 03:00 UTC | Expire sessions, tokens, jobs, indexes, and hot snapshots |
| Sunday 04:00 UTC | Refresh locale catalog and reconcile metric outboxes |

The Settings health page reports recent job and ingest failures. Cloudflare
observability is enabled, and each scheduled handler emits structured metrics.
Webhook destinations receive HMAC SHA-256 signatures in
`x-ai-tracker-signature`; secrets are shown once.

HTML evidence is off by default and can be enabled per project. Raw prompts
should not contain personal data. R2 objects are private and evidence downloads
are authorized through the Worker.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm deploy:dry
```

The unit tests cover validation, entity hallucination rejection and
corroboration, URL/domain normalization, DST-aware schedules, and date-bound
utilities. CI runs the full verification sequence on every pull request.

## Repository map

- `src/app` — React dashboard
- `src/worker` — API, ingestion, analytics, alerts, and exports
- `src/shared` — request schemas and queue contracts
- `migrations/control` — tenancy, orchestration, and rollup schema
- `migrations/snapshot` — detailed snapshot schema
- `infrastructure` — R2 lifecycle configuration
- `scripts/migrate.mjs` — applies migrations across all D1 bindings
- `ai-tracker-prd.md` — source product and architecture requirements

## License

Apache-2.0
