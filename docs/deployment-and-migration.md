# Deployment and migration guide

This is the production runbook for Belki's multi-user release, invite-only
signup, prompt-based plans, multiple tracking sources, Stripe Direct
subscriptions, safe plan changes, and Cloudflare operator protection.

The repository supports two operating models:

| Installation | DataForSEO credentials | Stripe | Customer billing |
|---|---|---|---|
| Self-hosted | The deployer adds their own Worker secrets | Disabled | None |
| Belki managed cloud | Belki's platform Worker secrets | Stripe Direct | Starter, Studio, and Agency prompt allowances |

Provider credentials never belong in an application settings screen. Keep
DataForSEO and Stripe credentials as encrypted **Worker runtime secrets**. A
managed customer purchases a prompt allowance and never sees or supplies
Belki's DataForSEO credentials. Internal workload budgets still protect the
platform from runaway provider spend, but they are not a customer-facing
currency.

## Rules that prevent production mistakes

1. Deploy production from a reviewed Git commit on `main`. Do not run a local
   Wrangler deployment at the same time as a Cloudflare Git build.
2. Runtime secrets go under **Worker → Settings → Variables & Secrets**. Do not
   put them in GitHub, `wrangler.jsonc`, deployment profiles, chat, or
   **Settings → Build → Variables and secrets**.
3. Test and live Stripe data are isolated by `STRIPE_ENVIRONMENT` and the
   `stripe_livemode` stored in D1. Never change Stripe keys while payments are
   enabled.
4. Database migrations run before the Worker upload. Migrations `0015` and
   `0016` add managed billing. Migration `0017` adds source identity without
   rebuilding or dropping the foreign-key parent `crawl_jobs` table; its
   defaults keep the previous Worker compatible during the short
   migration/upload window. Avoid initiating manual collection during the
   cutover. Legacy data is backfilled as ChatGPT and legacy workspaces remain
   self-hosted and active.
5. Plan downgrades are scheduled through Stripe Subscription Schedules. Never
   configure Stripe's generic portal to perform Belki plan switches.

Commands below assume the managed Worker is `ai-visibility-tracker` and its
origin is `https://app.getbelki.com`. Self-hosters replace those values.

## 1. Local and account prerequisites

- Node.js 24+, pnpm 11, Wrangler 4, GitHub CLI, and Stripe CLI.
- Cloudflare Workers Paid, D1, R2, Queues, and an active custom domain.
- Stripe Billing and Stripe Tax configured for the legal entity selling Belki.
- DataForSEO APIs required by the application enabled on the platform account.

Authenticate without copying tokens into a command:

```bash
gh auth login -h github.com
stripe login
pnpm exec wrangler login
```

Verify before modifying production:

```bash
gh auth status
stripe whoami
pnpm exec wrangler whoami
pnpm install --frozen-lockfile
pnpm check
pnpm types:check
pnpm deploy:getbelki:dry
```

`stripe login` opens a browser and stores a restricted CLI credential. The
checked-in Stripe helper uses that session and never reads or prints a secret
key.

## 2. Git and Cloudflare Builds

Belki production uses `deployment/getbelki.json`, a non-secret overlay on the
safe self-hosted `wrangler.jsonc`. This avoids turning the open-source default
into a live managed-billing deployment.

**Complete this section before pushing the first release branch.** A branch
build that runs `wrangler deploy` without a separate preview Worker can replace
the production Worker even when the GitHub pull request is still a draft.

Configure **Worker → Settings → Build**:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `/` |
| Build command | `pnpm build` |
| Deploy command | `pnpm deploy:getbelki` |
| Non-production builds | Disabled |

Save the settings, then verify that the dashboard identifies `main` as the
only production branch and shows branch/preview builds as disabled. Do not
open or update the release PR until both conditions are visible.

GitHub Actions validates pull requests but does not have deployment
credentials. Cloudflare deploys only after a reviewed PR is merged into
`main`. `pnpm deploy:getbelki` uploads the generated managed configuration
without contacting every D1 database, so code-only publishes do not depend on
33 migration control-plane checks.

For a release that adds D1 migrations, apply the reviewed additive migrations
before merging the code that consumes them:

```bash
pnpm db:migrate:remote
```

For an explicitly approved direct release from a clean, merged `main`, the
combined command remains available:

```bash
pnpm deploy:getbelki:with-migrations
```

The current managed sandbox profile is:

```json
{
  "DEPLOYMENT_MODE": "managed",
  "PAYMENT_MODE": "stripe_direct",
  "BILLING_PLAN_CHANGES_ENABLED": "true",
  "TRACKING_SOURCE_GEMINI_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED": "false",
  "STRIPE_ENVIRONMENT": "test"
}
```

The three source flags intentionally remain false for the initial deployment.
ChatGPT is always available. Enable the other sources one at a time only after
the source-specific sandbox tests in section 6 pass.

`workers_dev` is disabled and `app.getbelki.com` is the only managed route, so
the `workers.dev` hostname cannot bypass Cloudflare Access.

## 3. Existing-production migration

Use this section for an existing single-workspace Belki installation. Do not
use the fresh-install ordering.

### 3.1 Record recovery points

Avoid starting manual crawls during the cutover. Record the current Git SHA,
Worker version, D1 counts, and Time Travel bookmark:

```bash
git rev-parse HEAD
pnpm exec wrangler versions list
pnpm exec wrangler d1 migrations list CONTROL_DB --remote
pnpm exec wrangler d1 time-travel info ai-tracker-control
```

Export the control database to a private absolute path outside the repository:

```bash
pnpm exec wrangler d1 export CONTROL_DB --remote --output <secure-absolute-path>/control-before-multi-user.sql
```

Record invariant counts instead of relying on values captured on an earlier
day:

```bash
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM memberships) AS memberships, (SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL) AS active_projects"
```

### 3.2 Merge the foundation release

The release PR contains the application code, Durable Object migration,
control migration, and snapshot-shard migration. Merge only after:

```bash
pnpm check
pnpm types:check
pnpm deploy:getbelki:dry
```

Before merging this schema release, run `pnpm db:migrate:remote`, which applies:

- `0015_managed_multi_tenant.sql`: users/workspaces/invites/operators/billing,
  usage, Stripe environment markers, and legacy backfill.
- `0016_billing_plan_changes.sql`: canonical Stripe item/schedule state,
  checkout locking, webhook claiming, and durable plan-change records.
- `0017_tracking_sources.sql`: prompt/source entitlements, project source
  settings, additive source-aware job fields and indexes, source-aware
  reporting, archived projects, and stored downgrade previews. It deliberately
  preserves the existing `crawl_jobs` table and its foreign-key dependents.
- `0018_operator_insights.sql`: response-level Site, Reviews, and year fan-out
  classifications plus the bounded analytics read-model backfill used by the
  operator-wide trend reports.
- `0021_fanout_signal_metrics.sql`: additive response-level fan-out signal
  counts, schema-v7 backfill scheduling, and multi-denominator operator trends.
- Snapshot migration `0005_tracking_sources.sql` on every snapshot shard:
  source identity and AI-surface presence.
- Durable Object migration `v1`: `WorkspaceUsageGate` for atomic internal
  workload, prompt, source, and project-limit enforcement.

After the migrations succeed, merge the reviewed PR. Cloudflare then runs
`pnpm deploy:getbelki` to upload the Worker without rechecking every database.
If migrations succeed but upload fails, fix the build and redeploy the same Git
SHA. The new columns have safe ChatGPT defaults, so the previous Worker remains
compatible while you recover; it simply cannot use the new sources. Do not
restore D1 merely because the upload failed.

Cloudflare Durable Object migrations are forward-only. After `v1` has ever
been uploaded, an older Worker version that does not declare
`WorkspaceUsageGate` cannot be selected with `wrangler rollback`. A recovery
build must retain the `WorkspaceUsageGate` export, binding, and `v1` migration
metadata even if it otherwise uses the pre-foundation application code.

### 3.3 Verify the migration

```bash
pnpm exec wrangler d1 migrations list CONTROL_DB --remote
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT status, plan_key, COUNT(*) FROM workspaces GROUP BY status, plan_key"
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT payment_mode, status, stripe_livemode, COUNT(*) FROM billing_accounts GROUP BY payment_mode, status, stripe_livemode"
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT email FROM platform_operators"
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT tracking_source, COUNT(*) FROM crawl_jobs GROUP BY tracking_source"
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT source, COUNT(*) FROM project_tracking_sources WHERE enabled = 1 GROUP BY source"
```

Expected results:

- Existing workspaces are `active` and `self_hosted`.
- Existing billing accounts are `disabled` with `stripe_livemode` null.
- Existing projects, memberships, snapshots, jobs, queues, and R2 keys remain.
- Existing projects have ChatGPT enabled and existing jobs/snapshots are marked
  as ChatGPT; no historical Gemini or Google data is invented.
- The earliest existing owner is the initial platform operator.

Re-run the pre-cutover invariant query and exercise login, project reads,
analytics, exports, a normal crawl, and a DataForSEO postback.

## 4. Protect the operator console with Cloudflare Access

`/api/v1/operator/*` is the administration API used by the `/operator` React
page. It is part of the same Worker, not a separate Cloudflare service.

In **Cloudflare Zero Trust → Access controls → Applications**, create one
Self-hosted application named `Belki operator` with these public hostname paths:

```text
app.getbelki.com/operator*
app.getbelki.com/api/v1/operator/*
```

Add an Allow policy for exact operator emails. Do not allow an entire customer
domain. Both paths must use the same application so the browser Access session
also covers the operator API.

Belki requires both controls:

1. Cloudflare Access injects `cf-access-authenticated-user-email`.
2. The active Belki session email must match that header and exist in
   `platform_operators`.

Do not protect `/api/webhooks/stripe`, DataForSEO webhooks, signup, login, or the
customer application with the operator Access policy.

Verify in a private browser:

- `/operator` redirects to Access authentication.
- A non-allow-listed email is denied.
- An allow-listed email without a Belki operator record is denied by Belki.
- The allow-listed platform operator can load workspace and signup-code data.

## 5. Stripe product and portal model

Belki supports one monthly EUR subscription item at quantity 1:

| Plan | Tax-exclusive price | Active prompts | Active projects | Tracking sources per project |
|---|---:|---:|---:|---|
| Starter | €10/month | 25 | 1 | ChatGPT only |
| Studio | €29/month | 75 | 5 | Choose any 2 enabled sources |
| Agency | €149/month | 250 | 30 | All 4 enabled sources |

One active prompt is one query Belki tracks on schedule. If a project has two
tracking sources enabled, that prompt is collected from both sources. Do not
market internal workload weights as prompts, checks, credits, or requests.

Use three Products with one Price each—not three same-interval Prices on one
Product. This avoids Stripe's “This pricing plan can't be added” portal error.

Configure two portal experiences separately in sandbox and live mode:

1. **Default portal**, managed in Stripe Dashboard:
   - Enable payment-method updates and invoice history.
   - Disable subscription switching.
   - Disable subscription cancellation.
   - Do not add Belki Products under subscription switching.
2. **Belki action portal**, managed by the checked-in helper:
   - Immediate prorated upgrades through `subscription_update_confirm`.
   - Cancellation at period end through a deep link.
   - Not exposed as the general “Manage subscription” portal.

Stripe Dashboard manages only the default portal configuration. The helper
creates the non-default action configuration through Stripe's API.

## 6. Sandbox rollout on the invite-only live app

Sandbox uses the real Cloudflare Worker/domain but Stripe test objects and test
credentials. Existing self-hosted workspaces are unchanged.

### 6.1 Configure sandbox Stripe objects

In Stripe sandbox mode, activate the default portal and apply the settings from
the previous section. Then run:

```bash
pnpm stripe:configure -- \
  --origin https://app.getbelki.com \
  --bootstrap-catalogue
```

The command prints only:

```text
STRIPE_ENVIRONMENT=test
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_STUDIO_PRICE_ID=price_...
STRIPE_AGENCY_PRICE_ID=price_...
STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID=bpc_...
```

Copy those non-secret IDs into `deployment/getbelki.json`.

### 6.2 Create the sandbox webhook

Create a Stripe sandbox webhook destination:

```text
https://app.getbelki.com/api/webhooks/stripe
```

Select event API version **`2025-03-31.basil`**, not **Latest**. Stripe fixes
the payload version when it creates the destination; it cannot be changed on an
existing endpoint. A different release family can contain breaking object-shape
changes even when the Worker uses a pinned version for its own API requests.

Subscribe to exactly:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
invoice.payment_action_required
subscription_schedule.created
subscription_schedule.updated
subscription_schedule.released
subscription_schedule.completed
subscription_schedule.canceled
subscription_schedule.aborted
```

Now run the complete read-only check. It fails unless there is exactly one
enabled webhook at the expected URL with the pinned API version and exact event
allowlist:

```bash
pnpm stripe:check -- \
  --origin https://app.getbelki.com \
  --starter-price price_... \
  --studio-price price_... \
  --agency-price price_... \
  --portal-id bpc_...
```

Do not put Cloudflare Access in front of this endpoint. Belki authenticates the
bounded raw body with Stripe's signature, rejects the wrong test/live mode, and
deduplicates event IDs in D1.

### OWNER SECRET CHECKPOINT A — sandbox

In **Workers & Pages → ai-visibility-tracker → Settings → Variables & Secrets →
Add → Secret**, paste:

1. `STRIPE_SECRET_KEY`: the sandbox `sk_test_...` server key.
2. `STRIPE_WEBHOOK_SECRET`: the sandbox endpoint's `whsec_...` signing secret.

Do not paste either value into a terminal command, `.dev.vars.production`,
GitHub, documentation, or chat. Verify names without revealing values:

```bash
pnpm exec wrangler secret list
```

### 6.3 Activate sandbox through Git

In a dedicated PR, change only the managed profile:

```json
{
  "DEPLOYMENT_MODE": "managed",
  "PAYMENT_MODE": "stripe_direct",
  "BILLING_PLAN_CHANGES_ENABLED": "true",
  "TRACKING_SOURCE_GEMINI_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED": "false",
  "STRIPE_ENVIRONMENT": "test"
}
```

Use the sandbox Price/action-portal IDs. Merge after CI and Stripe checks pass.

From `/operator`, create one test-only signup code and exercise:

- Signup remains `pending_payment` before Checkout.
- Repeated Checkout clicks reuse one open attempt.
- A valid webhook activates the workspace; an invalid or replayed event cannot
  grant entitlement twice.
- Starter → Studio uses Stripe's immediate confirmation and proration.
- Agency → Starter succeeds even when the workspace is above the Starter
  limits. The confirmation must identify how many projects will be archived,
  prompts paused, and sources removed.
- A valid downgrade creates a next-renewal schedule and retains the current
  plan, prompts, projects, and sources for the paid period.
- At renewal, excess projects are archived, excess prompts are paused, and
  unsupported sources are disabled deterministically. No history is deleted.
- After upgrading, an archived project can be restored when project capacity
  is available; paused prompts remain available for deliberate reactivation.
- “Keep current plan” releases the schedule.
- Replacing a downgrade or canceling a subscription explicitly releases the
  previous pending schedule.
- Cancellation is end-of-period and reactivation clears it.
- Prompt, project, and source limits stop new paid work without deleting
  customer data.

### 6.4 Validate and release tracking sources

No new provider secret is required. Gemini, Google AI Mode, Google AI
Overviews, and ChatGPT all use the existing `DATAFORSEO_LOGIN` and
`DATAFORSEO_PASSWORD` Worker runtime secrets.

Release optional sources independently, in this order:

1. Set `TRACKING_SOURCE_GEMINI_ENABLED=true` in
   `deployment/getbelki.json`, merge the profile PR, and enable Gemini on one
   internal Studio or Agency project.
2. Allow one scheduled prompt update. Verify a source-specific result,
   citations, provider cost, prompt history, alert, and CSV export. Confirm
   ChatGPT reporting did not change.
3. Repeat for `TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED`.
4. Repeat for `TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED`. Test one query with
   an AI Overview and one without. Absence is a successful observation shown as
   “not present,” not a failed job.

Google AI Overviews uses Google Organic Advanced with asynchronous AI Overview
loading; DataForSEO charges that option at a higher multiplier. Watch actual
provider cost before expanding access. To stop a source safely, change only its
flag to false and redeploy. Existing history remains readable; new selection
and dispatch stop. Work already accepted by DataForSEO may still finish and is
normalized into the preserved source history.

Source behavior is intentionally explicit:

- New and migrated projects start with ChatGPT only.
- Enabling a source starts with the next scheduled update; Belki does not
  fabricate or backfill historical responses.
- Reports, alerts, exports, snapshots, and related-query views stay separated
  by source; Belki never blends unlike responses into one visibility score.
- Managed customers cannot trigger ad-hoc paid collection. Self-hosters may run
  one explicitly selected source manually.

### 6.5 Close sandbox safely

Before changing credentials:

1. Release pending schedules.
2. Cancel the sandbox subscription and wait for terminal webhooks.
3. Revoke every unused signup code.
4. Archive/suspend the sandbox workspace and confirm no active plan-change row.
5. Merge a small PR restoring `PAYMENT_MODE=disabled` and
   `BILLING_PLAN_CHANGES_ENABLED=false`.
6. Disable the sandbox webhook destination.

The archived workspace remains marked `stripe_livemode=0`, so live credentials
cannot accidentally reconcile it.

## 7. Live Stripe activation

### 7.1 Configure live catalogue and portal

Activate and secure the default portal in Stripe live mode. Explicit live
confirmation is mandatory for helper mutations:

Live configuration is blocked until the default portal contains published
HTTPS privacy-policy and terms-of-service URLs. Sandbox testing may proceed
while those pages are being prepared, but customer invitations and live
activation may not.

```bash
pnpm stripe:configure -- \
  --live \
  --confirm-live app.getbelki.com \
  --origin https://app.getbelki.com \
  --bootstrap-catalogue
```

Create the live webhook destination with the same URL, exact event list, and
event API version **`2025-03-31.basil`**. Test and live webhook destinations
have different signing secrets.

### OWNER SECRET CHECKPOINT B — live rotation

While payments are still disabled, replace the two Worker runtime secrets:

1. `STRIPE_SECRET_KEY`: live `sk_live_...` server key.
2. `STRIPE_WEBHOOK_SECRET`: live endpoint `whsec_...` signing secret.

Do not change the five existing DataForSEO/bootstrap/crypto secrets.

Run a read-only live check using the non-secret IDs printed by the helper:

```bash
pnpm stripe:check -- \
  --live \
  --origin https://app.getbelki.com \
  --starter-price price_... \
  --studio-price price_... \
  --agency-price price_... \
  --portal-id bpc_...
```

### 7.2 Activate live billing through Git

Merge a dedicated profile-only PR with:

```json
{
  "DEPLOYMENT_MODE": "managed",
  "PAYMENT_MODE": "stripe_direct",
  "BILLING_PLAN_CHANGES_ENABLED": "true",
  "TRACKING_SOURCE_GEMINI_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED": "false",
  "TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED": "false",
  "STRIPE_ENVIRONMENT": "live"
}
```

Use only live Price/action-portal IDs. After Cloudflare reports the expected Git
SHA/version, create one owner-controlled live invite and complete a Starter
Checkout. The browser must leave the pricing screen only after the signed
webhook makes the subscription active, then open `/onboarding/project`.

Complete the customer path before treating the release as healthy:

1. Create the first project. Confirm the app advances to
   `/onboarding/prompts`, not Settings or an empty dashboard.
2. Add at least one prompt and confirm `/prompts` shows it. Also verify that
   **Skip for now** reaches the project overview without an onboarding loop.
3. Open Billing. Confirm managed workspaces show the plan, active prompt and
   project allowances, source entitlements, and Stripe management action. Raw
   provider costs must not be exposed to managed customers.
4. Confirm a self-hosted workspace defaults to **Provider costs** and labels
   the other view **Limits**; it must not show managed checkout actions.
5. Open the operator console through Cloudflare Access. Create and revoke a
   test invitation, and verify a workspace status change requires confirmation.

Finally verify the signed webhook, active entitlement, invoice, automatic tax,
and D1 state. Cancel that smoke subscription, issue a full refund, wait for the
deletion webhook, and archive the smoke workspace.

Do not issue customer invitations until this smoke test passes.

Keep optional tracking-source flags false during the Stripe credential
rotation. Release them afterward using the one-source-at-a-time procedure in
section 6.4. This separates billing incidents from provider-integration
incidents and makes rollback a one-variable Git change.

## 8. Billing invariants and support operations

Belki deliberately treats plan changes asymmetrically:

| Request | Stripe operation | Entitlement timing |
|---|---|---|
| First purchase | Checkout Session | After verified webhook and canonical fetch |
| Upgrade | Action portal confirmation | After Stripe confirmation/webhook; immediate proration |
| Downgrade | Subscription Schedule | Next renewal; no mid-cycle credit |
| Cancel downgrade | Release schedule | Current plan remains active |
| Cancel subscription | Action portal cancellation | End of current period |
| Reactivate | Clear `cancel_at_period_end` | Immediate |

This permanently fixes the Agency-to-Starter hard stop. The current paid plan
remains fully active until renewal. At renewal, Belki atomically applies the
new prompt, project, and source limits: it archives excess projects, pauses
excess prompts, and disables excess sources. Historical snapshots and settings
are retained. While a downgrade is pending, the customer keeps the current
plan's limits; the stored transition preview makes the renewal changes explicit
and reproducible. The Billing page recalculates affected counts as the customer
changes projects, prompts, or sources during the remaining paid period.

Inspect state:

```bash
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT workspace_id, kind, status, from_plan_key, to_plan_key, effective_at, transition_json, failure_code FROM billing_plan_changes ORDER BY created_at DESC LIMIT 25"
pnpm exec wrangler d1 execute CONTROL_DB --remote --command \
  "SELECT workspace_id, stripe_livemode, plan_key, status, stripe_subscription_schedule_id, billing_synced_at, billing_sync_error FROM billing_accounts ORDER BY updated_at DESC LIMIT 25"
```

Operator recovery endpoints:

```text
POST   /api/v1/operator/workspaces/{workspace-id}/billing/reconcile
DELETE /api/v1/operator/workspaces/{workspace-id}/billing/plan-change
DELETE /api/v1/operator/signup-codes/{signup-code-id}
```

All require a Belki operator session, CSRF protection, and the matching
Cloudflare Access identity. Operators cannot manually overwrite Stripe-backed
plan or allowance fields.

Unsupported subscription shapes fail closed for operator review: trials,
discounts, quantity other than one, multiple items, non-monthly/non-EUR Prices,
missing automatic tax, unknown Prices, and foreign Subscription Schedules.

## 9. Rollback and direct-deploy fallback

Normal changes always use Git. If Cloudflare's build fails:

1. Confirm there is no active/concurrent build.
2. Confirm the clean checkout is the exact merged `main` SHA.
3. Run `pnpm check`, `pnpm types:check`, and `pnpm build` again.
4. With explicit production approval, run `pnpm deploy:getbelki`.
5. Record the resulting Worker version and keep Git/Cloudflare aligned.

If the exact merged release includes unapplied D1 migrations, use
`pnpm deploy:getbelki:with-migrations` in step 4 instead.

For a billing incident:

1. Deploy `BILLING_PLAN_CHANGES_ENABLED=false` to stop new changes.
2. Inspect `creating`, `updating`, `scheduled`, and `releasing` rows.
3. Release unwanted schedules and reconcile each workspace.
4. Roll the Worker back to the recorded compatible version.
5. Leave additive D1 tables/columns and the Durable Object namespace in place.

Restore D1 only for confirmed data corruption with traffic and queues stopped:

```bash
pnpm exec wrangler d1 time-travel restore ai-tracker-control --bookmark <bookmark>
```

After rollback, verify login, workspace isolation, prompt/source limits, queues,
DataForSEO postbacks, Stripe webhook signatures, operator Access, and canonical
billing reconciliation before reopening invitations.

## 10. Fresh self-hosted installation

Self-hosters keep `DEPLOYMENT_MODE=self_hosted`, `PAYMENT_MODE=disabled`, and
their own DataForSEO credentials as Worker runtime secrets. Stripe secrets and
managed deployment profiles are unnecessary. The checked-in self-hosted
configuration enables every tracking source and provides high local prompt and
project limits; ChatGPT remains the default on existing and new projects until
the owner enables more sources in Project Settings.

Set the five required secrets interactively:

```bash
pnpm exec wrangler secret put DATAFORSEO_LOGIN
pnpm exec wrangler secret put DATAFORSEO_PASSWORD
pnpm exec wrangler secret put DATAFORSEO_WEBHOOK_TOKEN
pnpm exec wrangler secret put APP_CRYPTO_KEY
pnpm exec wrangler secret put BOOTSTRAP_TOKEN
```

Then provision bindings, migrate, and deploy from the configured fork:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm deploy:dry
pnpm db:migrate:remote
pnpm exec wrangler deploy
pnpm r2:lifecycle
```

## Provider references

- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Stripe CLI authentication](https://docs.stripe.com/stripe-cli/keys)
- [Stripe Customer Portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Stripe Customer Portal deep links](https://docs.stripe.com/customer-management/portal-deep-links)
- [Stripe Subscription Schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
- [Stripe webhook setup](https://docs.stripe.com/webhooks)
- [DataForSEO LLM Responses](https://docs.dataforseo.com/v3/ai_optimization-llm_responses-overview/)
- [DataForSEO Google AI Mode](https://docs.dataforseo.com/v3/serp/google/ai_mode/overview/)
- [DataForSEO Google Organic AI Overview](https://docs.dataforseo.com/v3/serp/google/organic/task_post/)
