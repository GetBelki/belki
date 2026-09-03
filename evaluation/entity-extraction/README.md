# Entity extraction evaluation

This directory contains the reproducible harness for comparing the production
extractor with encoder-based NER candidates. Retained answers and annotations
belong in `private/`, which is gitignored. Never commit answer text, project or
workspace identifiers, prompts, or model outputs derived from private data.

## Private review workflow

Run one command from the repository root:

```sh
pnpm evaluate:entities
```

It performs a read-only, stratified sample of 300 retained production answers,
hashes database identifiers before saving anything, loads the existing v1
results, and runs v2 through a localhost-only Worker using the remote Workers AI
binding. It never deploys a Worker or applies a migration. Workers AI calls are
billable even though the Worker code runs locally.

Generated files live only in `evaluation/entity-extraction/private/`. Open
`review.html`, correct the suggested entities, and click **Mark reviewed &
next** for every answer. Progress stays in browser local storage; **Export
backup** saves an extra copy. When all answers are reviewed, **Download
gold.jsonl** becomes available. Move that download into the private directory,
then run the benchmark command below.

Use `pnpm evaluate:entities -- run` to resume an interrupted v2 run. Completed
answers are checkpointed every ten records. Use `--refresh` only with the
`prepare` or default command when you intentionally want a different sample.
Use `pnpm evaluate:entities -- run --restart` only when extractor code changed
and every v2 prediction must be regenerated against the same sample.

To compare Workers AI models without overwriting the reference prediction, pass
an output path and the two model IDs. The output records include per-operation
token usage:

```sh
pnpm evaluate:entities -- run \
  --output evaluation/entity-extraction/private/qwen3-30b.jsonl \
  --span-model @cf/qwen/qwen3-30b-a3b-fp8 \
  --relationship-model @cf/qwen/qwen3-30b-a3b-fp8
```

`--limit` can be used for a small smoke test and the same output can later be
resumed with a larger limit. Qwen3 requests automatically disable thinking mode
and use non-greedy sampling to avoid consuming the structured-output budget on
reasoning or repetition.

## Gold record

Store one JSON object per line:

```json
{"id":"opaque-snapshot-hash","languageCode":"en","answer":"Visible answer text","entities":[{"surface":"Contoso","canonicalName":"Contoso","entityType":"brand","relationship":"competitor"}]}
```

Build a 300-answer set stratified across observed languages, tracking sources,
projects, prompt intents, and known false-positive/false-negative patterns. Cap
the contribution of any single project and sanitize direct personal data.
Every answer requires human review. If `autoTrackEntities` is omitted, every
human-labelled competitor is treated as valid for the auto-track precision
check; the evaluator still applies the production repetition and corroboration
thresholds to predictions.

Prediction files use the same `id` and `entities` shape. Candidate-only models
should set `relationship` to `unknown`; this keeps span quality separate from
the contextual competitor classification score. The report includes a
type-agnostic `spans` score for fair BERT/XLM-R/GLiNER candidate comparison,
plus type-aware entity and competitor scores for the complete production path.

## Model baselines

`run_models.py` supports the common English BERT NER baseline, multilingual
XLM-RoBERTa, and multilingual GLiNER. These dependencies are evaluation-only
and must not be added to the production Worker bundle.

```sh
python -m venv evaluation/entity-extraction/.venv
evaluation/entity-extraction/.venv/bin/pip install transformers torch gliner
evaluation/entity-extraction/.venv/bin/python evaluation/entity-extraction/run_models.py \
  --input evaluation/entity-extraction/private/gold.jsonl \
  --output evaluation/entity-extraction/private/gliner.jsonl \
  --model gliner

pnpm benchmark:entities -- \
  --gold evaluation/entity-extraction/private/gold.jsonl \
  --prediction v1=evaluation/entity-extraction/private/v1.jsonl \
  --prediction v2=evaluation/entity-extraction/private/v2.jsonl \
  --gate v2 --baseline v1
```

The gate requires at least 90% competitor precision and recall, a five-point
F1 improvement over v1, 98% auto-track precision, and no represented language
regression greater than five F1 points.
