# AI Traffic

AI Traffic measures sessions that enter a customer website with a recognized
`utm_source`. It measures tagged traffic, not verified referrals or all visits
from AI products. It does not infer attribution from referrers.

## Installation

1. Apply control migration `0037_ai_traffic.sql` with the normal migration runner
   before deploying this release. No new production bindings are required.
2. Open **AI Traffic → Installation & goals** in the selected project.
3. List exact hostnames, including each subdomain, enable collection, and save.
4. Copy the generated asynchronous script into every page to be measured.
5. Visit the site with `?utm_source=chatgpt`, navigate to another page, and check
   the last-event timestamp and dashboard. The dashboard refreshes every minute.

The installation key is public and identifies a project; never put an API token
or secret in the tag. The collector checks the request origin against configured
hostnames. CORS/origin checks do not authenticate a visitor or prove AI provenance.
The tag configuration endpoint returns only the source alias map.

For sites with a Content Security Policy, allow the Belki origin in `script-src`
and `connect-src`. If Belki sits behind an access proxy, allow public access to
`/api/traffic/*` while keeping the dashboard and `/api/v1/*` protected. Load the
tag through the site's consent manager when appropriate.

## Attribution

Built-in source names and domains:

| Source | Values |
| --- | --- |
| ChatGPT | `chatgpt`, `chatgpt.com`, `chat.openai.com` |
| Claude | `claude`, `claude.ai` |
| Gemini | `gemini`, `gemini.google.com` |
| Perplexity | `perplexity`, `perplexity.ai` |
| Copilot | `copilot`, `copilot.microsoft.com` |
| Grok | `grok`, `grok.com` |

Projects can add up to 50 aliases assigned to these sources. Values are trimmed
and compared case-insensitively, without substring matching. Aliases cannot
override a built-in value with a different source. These traffic sources are
independent of the platforms enabled for AI-answer capture or billing plans.

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
  15 seconds and when hidden or unloaded. This is not a measure of attention;
  browser suspension, blocking or failed delivery can undercount time.
- **Countries:** Cloudflare country metadata or Unknown. No geolocation prompt.
- **Devices:** a User-Agent estimate of mobile, tablet, desktop or Unknown.
- **Conversion rate:** sessions completing at least one goal / all selected
  sessions. Per-goal rates use the same denominator. Each goal counts once per
  session; rates for separate goals must not be added together.

Define up to 30 goals using an exact pathname (for example `/thanks`) or an
explicit event name. Fire an event only after a successful action:

```js
window.belki?.track('signup');
```

For actions that can occur before the asynchronous script loads, initialize a
queue before the tag:

```js
window.belki = window.belki || {
  q: [],
  track(name) { this.q.push(name); }
};
```

Only an event name is accepted; there are no arbitrary event properties, revenue
fields or customer identifiers. Unknown event names do not create goals. Goal
definitions are evaluated on arrival, not against historical pages or events.
Changing a goal's matching rule creates a new goal ID; historical conversion
names remain unchanged. Disabling collection retains historical reports.

## Storage and operation

Migration 0037 creates separate settings, sessions, pages, conversion and event
receipt tables in the control D1 database. No response/citation data is reused.
Pages store cumulative time; only custom events need deduplication receipts.
Reports never include sessions older than 12 calendar months, and scheduled
cleanup removes expired sessions and cascades to their child records.

Stored data is limited to session/page/event identifiers, timestamps, normalized
source, hostname/pathname, country, device class and completed goal names.
IP addresses, full User-Agents, URL queries/fragments and request bodies are not
persisted by this feature or added to application logs. Avoid embedding personal
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
- `GET /api/v1/traffic/:projectId/report?from=YYYY-MM-DD&to=YYYY-MM-DD&source=chatgpt`

Public interfaces:

- `GET /api/traffic/v1.js`
- `GET /api/traffic/config/:publicKey`
- `POST /api/traffic/collect` (plain text JSON, no credentials)

Unit tests exercise browser attribution and visibility. Workers tests use a
dedicated local D1 binding to verify real SQL, isolation, deduplication and
retention. No production database is used by these tests.
