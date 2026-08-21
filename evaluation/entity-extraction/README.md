# Entity extraction evaluation

This directory contains the reproducible harness for comparing the production
extractor with encoder-based NER candidates. Retained answers and annotations
belong in `private/`, which is gitignored. Never commit answer text, project or
workspace identifiers, prompts, or model outputs derived from private data.

## Gold record

Store one JSON object per line:

```json
{"id":"opaque-snapshot-hash","languageCode":"en","answer":"Visible answer text","entities":[{"surface":"Contoso","canonicalName":"Contoso","entityType":"brand","relationship":"competitor"}],"autoTrackEntities":["Contoso"]}
```

Build a 300-answer set stratified across observed languages, tracking sources,
projects, prompt intents, and known false-positive/false-negative patterns. Cap
the contribution of any single project and sanitize direct personal data.
Every competitor label and every model disagreement requires human review.

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
