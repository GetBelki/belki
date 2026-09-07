# AI Analytics

AI Analytics measures sessions that enter a customer website with a recognized
`utm_source`. It measures tagged traffic, not verified referrals or all visits
from AI products. It does not infer attribution from referrers.

## Installation in a project

1. Open **AI Analytics → Installation** in the selected project.
2. Add exact hostnames as tags with **Enter** or **Add**, including each subdomain.
   You can paste a comma- or newline-separated list and remove tags individually.
   Select **Save settings** when done. Collection can remain off.
3. Copy the complete generated tag (the queue initializer and the asynchronous
   `belki-analytics.js` script) into the site's global template, before calls to `belki.track`.
4. Enter an authorized page URL and select **Create test link**. Use **Open test page**
   or **Copy link** to open the generated URL in another browser or on another device.
   Navigate or complete a conversion. The dashboard displays received pages,
   events and matched goals. The temporary test works while collection is off,
   is excluded from reports, and expires after ten minutes. Creating a new test
   replaces the previous one. It is intended for sites you control.
5. Enable collection and save when ready. **Overview** displays real traffic;
   **Conversions** manages goals and **Sources** lists every recognized value,
   manages aliases and allows project-specific sources.

The installation key is public and identifies a project; never put an API token
or secret in the tag. The collector checks the request origin against configured
hostnames. CORS/origin checks do not authenticate a visitor or prove AI provenance.
The public configuration endpoint returns only the source alias map.

For Content Security Policy, allow the script's origin in `script-src`, the
analytics origin in `connect-src`, and authorize the inline queue initializer
with your site's nonce or hash. You can instead move the initializer into an
existing permitted local script that executes before your conversion code.
If an access proxy protects Belki, leave `/belki-analytics.js`, the published SDK
assets and `/v1/*` public; keep the dashboard and `/api/v1/*` protected. Load the
tag through the site's consent manager when appropriate.

## Open-source hosting configuration

The default installation is complete with **one application Worker**. No extra
hostname, subscription or Belki-hosted service is required. The SDK and public
endpoints use the application's public origin. Set `PUBLIC_APP_ORIGIN` when an
installation is accessed through a proxy or more than one hostname.

Use the configurator before building/deploying:

```sh
# Interactive selection: integrated, separate service, optional custom CDN.
pnpm configure:analytics

# Non-interactive examples:
pnpm configure:analytics -- --integrated
pnpm configure:analytics -- --origin https://analytics.example.com
pnpm configure:analytics -- --origin https://analytics.example.com \
  --script-url https://cdn.example.com/belki-analytics.js
```

The command writes non-secret deployment variables to `wrangler.jsonc`. For a
managed profile, append `--profile deployment/getbelki.json`. The guided deploy
also offers this step interactively. Configuration changes take effect after a
build and deployment; they are not per-project settings.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_ANALYTICS_ORIGIN` | Empty: use application origin | Public origin of the configuration/events service |
| `PUBLIC_ANALYTICS_SCRIPT_URL` | `<analytics-origin>/belki-analytics.js` | Optional complete URL of the SDK on your CDN |

URLs require HTTPS in production, without credentials, query strings or
fragments. The generated tag supplies `data-api` explicitly, so a CDN-hosted
script never guesses where events belong. Local development supports localhost
HTTP; use the integrated `pnpm dev` setup for that mode.

For the **separate service**, the regular deploy commands publish an independent
`<application-worker-name>-analytics` Worker before publishing the application.
It has only the control D1 binding and the shared public analytics routes: no
dashboard, app secrets, scheduled jobs or application placement setting. It
shares the existing analytics tables with the app. Its hostname must be a domain
available for a Cloudflare Workers Custom Domain in your account; Cloudflare
provisions the route and certificate. An external CDN must be configured/uploaded
by its operator before using its script URL.

```sh
pnpm build
pnpm db:migrate:remote
pnpm deploy:analytics             # Separate service only; integrated mode is a no-op
pnpm deploy                      # Normal self-hosted deployment, including analytics
pnpm deploy:getbelki:with-migrations  # Managed profile, including analytics
pnpm deploy:dry                  # Check self-hosted packages without publishing
pnpm deploy:getbelki:dry         # Check managed packages without publishing
```

`deploy:analytics -- --dry-run` uses a placeholder D1 ID when the config has no
explicit ID. A real deploy uses `CONTROL_DB.database_id` when configured. A managed profile
can supply `analytics.controlDatabaseId` instead, keeping account-specific IDs
out of the open-source default configuration. If neither is present, it resolves
the existing database by name. Scoped tokens that cannot list D1 databases require
an explicit ID; obtain it from the existing database's Cloudflare settings.
The GetBelki profile uses this explicit binding. The child deployment also
isolates Workers Builds name overrides so it cannot target the application Worker. Deploy/migrate the application's database first; analytics
must never create a separate empty control database.

**Operator → Analytics service** displays resolved addresses and offers an
availability check. Hosting settings remain in deployment configuration. The
separate hostname isolates execution and deployment, not the shared D1 workload.
Changing domains does not make a third-party tracker immune to blockers.

## SDK publishing and cache

`pnpm build` generates the minified standalone SDK before the application build:

- `/belki-analytics.js`: the complete SDK in one request, cached for five minutes.
- `/assets/belki-analytics.<content-hash>.js`: immutable release artifact, cached
  for one year. Useful for operators deliberately pinning a release on their CDN;
  those operators must retain pinned artifacts and choose when to update them.
- `/v1/config/:key`: browser and edge cache of up to 60 seconds, separated by
  installation/project key and request origin. Test configuration is never cached.
- `/v1/events`: never cached; every request checks the current enabled flag,
  domain allowlist, workspace and project state before writing.

Static assets bypass Worker code. The checked-in `public/_headers` configures both
integrated and separate Workers. CDN operators should use equivalent headers.
The stable URL requires no tag edits for SDK updates; allow five minutes for
cached versions to expire, including after a rollback. The small full SDK avoids
an extra loader request on cold visits. The browser, API and dashboard have no
hardcoded dependency on `getbelki.com`.

The old `/api/traffic/v1.js` and collector routes have been replaced directly.
Re-copy the tag on existing development/test sites. Stored report data is retained.

## Attribution

Built-in source names and domains:

| Source | Values |
| --- | --- |
| ChatGPT | `chatgpt`, `chatgpt.com`, `chat.openai.com`, `openai.com` |
| Claude | `claude`, `claude.ai`, `claude.anthropic.com` |
| Gemini | `gemini`, `gemini.google.com`, `bard`, `bard.google.com` |
| Perplexity | `perplexity`, `perplexity.ai` |
| Copilot | `copilot`, `copilot.com`, `copilot.microsoft.com`, `edgepilot`, `edgeservices` |
| Grok | `grok`, `grok.com` |

Projects can add up to 100 aliases across these sources and up to 20 custom
sources. Creating a source adds its normalized identifier as a recognized value;
the first UTM value entered in the dashboard becomes an alias when it differs.
Values are trimmed and compared case-insensitively, without substring or regular
expression matching. Aliases cannot override a recognized value or refer to a
missing source. Removing a custom source also removes its aliases; stored sessions
keep their source identifier and remain in historical reports. These traffic
sources are independent of the platforms enabled for AI-answer capture or billing
plans.

No UTM and no existing attributed session or queued delivery means no configuration
request either. An unknown UTM can trigger a configuration lookup to check custom
aliases. Explicit installation tests are an exception to this network optimization.

No recognized UTM and no existing attributed session means no analytics events
or visitor identifiers. A qualifying session uses a random ID in `sessionStorage`
and expires after 30 minutes without navigation or interaction. Heartbeats do not
extend activity. Pages without UTMs retain the current session. An explicit
unrecognized UTM clears attribution; a different recognized UTM starts a session.
Reloading the same tagged page retains the session but counts a new page view.
SPA query/hash-only changes do not create new views; retained UTM parameters on
SPA navigation do not repeatedly restart the campaign. No cross-origin or
cross-device attribution is performed. With storage blocked, attribution lasts
only within the current document.

## Metrics and conversions

Reports group sessions and their page views by session start date in UTC. The
default period is 30 days. Breakdown tables show the top 100 entries.

- **Sessions:** distinct attributed session IDs.
- **Page views:** distinct page IDs, including traditional loads and SPA pathname
  changes. Cumulative heartbeats and unload retries never increment views.
- **Visible time:** approximate time while the document is visible, sent every
  30 seconds and when hidden or unloaded. This is not a measure of attention;
  browser suspension, blocking or failed delivery can undercount time.
- **Countries:** Cloudflare country metadata or Unknown. No geolocation prompt.
- **Devices:** a User-Agent estimate of mobile, tablet, desktop or Unknown.
- **Conversion rate:** sessions completing at least one goal / all selected
  sessions. Per-goal rates use the same denominator. Each goal counts once per
  session; rates for separate goals must not be added together.

Define up to 30 goals using an exact pathname (for example `/thanks`) or an
explicit event name. Fire an event only after a successful action:

```js
// After your application's successful registration response:
window.belki.track('signup_completed');
```

Use descriptive `snake_case` names for new events. Existing simple event names
are still accepted. The generated tag already initializes a bounded early-event
queue with the original time and URL; copy the complete snippet. A page goal
matches an exact pathname, ignores queries/fragments, and distinguishes trailing
slashes. Arrival at `/thanks` alone does not verify a completed business action.

The SDK keeps up to 30 unacknowledged deliveries in per-tab `sessionStorage` for
up to five minutes. Conversions send immediately. Transient network failures,
408/429 and server errors retry with bounded backoff (at most five fetch attempts),
using the same event ID and original page/session/time. A successful HTTP response
acknowledges the database write; permanent validation failures are discarded.
`sendBeacon` on exit does not acknowledge delivery, so a subsequent document may
retry the same ID. Server deduplication prevents duplicate conversions. Offline
storage, tab closure, blockers or extended outages can still cause undercounting.

Only an event name is accepted; there are no arbitrary event properties, revenue
fields or customer identifiers. Server-to-server conversion tracking is not included. Unknown event names do not create goals. Goal
definitions are evaluated on arrival, not against historical pages or events.
Changing a goal's matching rule creates a new goal ID; historical conversion
names remain unchanged. Disabling collection retains historical reports.

## Storage and operation

Migration 0037 creates separate settings, sessions, pages, conversion and event
receipt tables in the control D1 database. No response/citation data is reused.
Migration 0038 adds one expiring installation-test record per project. Normal
migration commands apply both before publication.
Pages store cumulative time; only custom events need deduplication receipts.
Reports never include sessions older than 12 calendar months, and scheduled
cleanup removes expired sessions and cascades to their child records.

Stored data is limited to session/page/event identifiers, timestamps, normalized
source, hostname/pathname, country, device class and completed goal names.
IP addresses, full User-Agents and URL queries/fragments are not persisted by
this feature or added to application logs. The browser temporarily stores bounded,
sanitized event payloads for retries; it never stores the original full URL there.
Diagnostic tokens are stored hashed on the server; diagnostics retain one bounded
result per project until their ten-minute expiry and subsequent scheduled cleanup. Avoid embedding personal
information in pathnames or goal names. Hosting-provider access logs are governed
by the operator's own configuration.

The public collector accepts bounded 4 KiB POST bodies and enforces a project
limit of 30,000 requests per 15-minute window using one rate-limit row per project.
Collection is opt-in and requires an active workspace. Configuration requires
editor privileges; reports retain the existing workspace/project access checks.
Pausing AI prompt capture does not disable website traffic collection; use its
own switch to stop receiving traffic.

Authenticated interfaces:

- `GET /api/v1/traffic/:projectId/config`
- `PUT /api/v1/traffic/:projectId/config`
- `POST /api/v1/traffic/:projectId/test` (editor, authorized page URL)
- `GET /api/v1/traffic/:projectId/test`
- `GET /api/v1/operator/analytics` (operator)
- `POST /api/v1/operator/analytics/check` (operator)
- `GET /api/v1/traffic/:projectId/report?from=YYYY-MM-DD&to=YYYY-MM-DD&source=chatgpt`

Public interfaces:

- `GET /belki-analytics.js` (static SDK)
- `GET /v1/health`
- `GET /v1/config/:publicKey`
- `POST /v1/events` (plain text JSON, no credentials)

Unit tests exercise browser attribution and visibility. Workers tests use a
dedicated local D1 binding to verify real SQL, isolation, deduplication and
retention. No production database is used by these tests.
