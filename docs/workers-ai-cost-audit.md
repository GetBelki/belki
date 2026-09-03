# Workers AI cost audit

Audit date: 2026-08-31

## Inference inventory

The Worker has two routine inference operations using
`@cf/qwen/qwen3-30b-a3b-fp8`, plus a high-precision confirmation using
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` immediately before an automatically
discovered competitor can be added to tracking. They are implemented in
`src/worker/automation/entity-extraction.ts`.

| Operation | Purpose | Trigger | Frequency | Optimization status |
| --- | --- | --- | --- | --- |
| `span_extraction` | Extract named-entity spans and types from answer text | Entity-extraction queue consumer | Once per non-empty answer chunk, where chunks contain at most 12,000 characters | Qwen MoE; exact, validated results are cached |
| `relationship_classification` | Classify untracked commercial entities as competitor, mentioned, or unknown | After span validation finds an untracked brand, company, or organization | Zero or one call per chunk | Qwen MoE; known brands are classified deterministically |
| `auto_track_confirmation` | Prevent a cheaper model from autonomously adding a false competitor | Only after recurrence, prompt-diversity, evidence-strength, and corroboration gates pass | Once per eligible entity/evidence level | 70B final reviewer; rejected evidence is not reviewed again until counts grow |

The private evaluation Worker has equivalent span and relationship calls. It is
run manually by `pnpm evaluate:entities`, is not deployed, and uses a remote,
billable Workers AI binding. Its calls now pass through the same structured-log
wrapper, but do not use the production D1 cache.

No executable Workers AI calls were found in the website or portable app. The
portable source retains the model constant but does not bind or invoke Workers
AI.

## Production call chains

Normal ChatGPT capture:

```text
Scheduled or manual capture
  -> DataForSEO provider
  -> normalize queue
  -> snapshot
  -> entity-extraction queue
  -> span extraction
  -> optional relationship classification
  -> D1 entity mentions and job totals
```

Gemini, Google AI Mode, and Google AI Overview snapshots reach the same entity
analysis through the every-minute missing-job reconciler and are recorded as
backfills. Read-only API routes, page loads, and frontend polling do not start
inference.

## Cost cause

Application records in the production control database showed the following as
of the audit:

- 6,629 v2 jobs and 10,415 completed chunks.
- 20.43 million input tokens and 1.88 million output tokens.
- $10.22 of application-estimated list-price usage.
- 104 jobs (1.57%) retried once; no job retried more than once.
- All 10,415 completed full-chunk input hashes were distinct, so repeated exact
  full analyses were not the primary historical cost source.

The August 21 spike is explained by the v2 migration and backfill. The migration
marked existing projects as serving v1 until all historical snapshots had v2
results, and the minute reconciler could enqueue 100 missing snapshots per run.
On August 21 it created 3,922 backfill jobs, completed 3,906 chunks, consumed
6.87 million recorded input tokens and 851 thousand output tokens, and produced
a $3.93 application estimate. This is sufficient to explain the roughly $3.30
Cloudflare billing spike; billing allocation and cycle boundaries can make the
Cloudflare amount lower than the stored list-price estimate.

Recurring usage after that event was approximately 207 new ChatGPT jobs per day
($0.37-$0.52 estimated) plus 78 other-source jobs found by reconciliation
($0.09-$0.11 estimated). This matches the observed $0.40-$0.60 daily pattern.

The private 300-answer evaluation workflow is another possible source of
one-off billable usage when run, but production job records already fully explain
the August 21 spike.

## Implemented controls

- A central `runAI` wrapper records feature, operation, model, project/query/job
  identifiers, retry attempt, input character count, token usage when returned,
  cache status, duration, and success or failure. It never records prompts,
  answers, API payloads, or error messages.
- Valid responses are cached using a SHA-256 key derived from project, tracked
  query, feature, operation, model, prompt version, and the exact serialized
  request. Model, prompt, scope, or input changes invalidate the key.
- Cache hits count as zero new input/output tokens in job cost totals.
- Cache and telemetry persistence are best-effort and cannot cause a successful
  inference to be retried.
- Queue consumers atomically claim only queued or failed entity jobs, preventing
  concurrent duplicate deliveries from running the same job.
- Jobs with more than ten chunks emit a high-inference-count warning instead of
  imposing an arbitrary limit on legitimate long answers.
- Cache and telemetry rows are deleted after 90 days. Project and prompt deletion
  also cascades to their cache and telemetry rows.

## Material model reduction

The private 300-answer corpus was rerun with Qwen3 30B-A3B in non-thinking mode.
The corpus is stratified across German (120), Spanish (90), English (60), and
Portuguese (30). It does not yet have a completed human gold file, so the
quality figures below are agreement with the prior 70B output, not absolute
accuracy:

- 83.2% span precision agreement and 63.2% span recall agreement.
- 79.8% competitor precision agreement and 84.8% competitor recall agreement.
- After the production recurrence/corroboration thresholds, 95.5% auto-track
  precision agreement and 96.3% auto-track recall agreement.
- 549,426 input tokens and 56,160 output tokens cost $0.0468 at Qwen list
  prices, versus a $0.2875 same-token 70B counterfactual: 83.7% lower.
- A paired 10-answer 70B control that captures each model's actual output-token
  behavior measured an 85.9% reduction.

The routine path therefore uses Qwen, while the consequential auto-track action
still requires a fresh 70B confirmation across up to 12 recent observations.
This separates cheap, high-volume discovery from expensive, low-volume
decision-making. Review verdicts are stored by entity and evidence counts in
`entity_auto_track_reviews`; a rejection is reconsidered only after new evidence
arrives.

At the observed post-backfill list-price rate of about $0.556/day, the measured
model reduction projects to roughly $2.35-$2.72/month instead of $16.68/month.
That is below Cloudflare's current 10,000-neuron daily free allocation when
Belki is the account's only Workers AI workload, so the expected billed amount
is near $0/month. Shared-account usage can consume that allocation first.

## Verification queries

After migrations `0033_workers_ai_cost_controls.sql` and
`0034_entity_auto_track_reviews.sql` are deployed, daily operation usage and
cache effectiveness can be inspected with:

```sql
SELECT
  substr(created_at, 1, 10) AS day,
  feature,
  operation,
  model,
  SUM(CASE WHEN status = 'success' AND cache_status = 'miss' THEN 1 ELSE 0 END)
    AS inference_calls,
  SUM(CASE WHEN status = 'success' AND cache_status = 'hit' THEN 1 ELSE 0 END)
    AS cache_hits,
  SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  ROUND(AVG(duration_ms), 1) AS average_duration_ms
FROM ai_usage_events
GROUP BY day, feature, operation, model
ORDER BY day DESC, feature, operation;
```

Retry and unusually expensive job trends can be checked with:

```sql
SELECT
  substr(created_at, 1, 10) AS day,
  COUNT(*) AS jobs,
  SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried_jobs,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  ROUND(SUM(estimated_cost_usd), 4) AS estimated_cost_usd
FROM entity_extraction_jobs
WHERE extractor_version = 'entities-v2'
GROUP BY day
ORDER BY day DESC;
```

Compare these daily application totals with Cloudflare Workers AI RTNs after at
least one complete billing day. The first full day should show Qwen for routine
span and relationship operations and 70B only for `auto_track_confirmation`.
