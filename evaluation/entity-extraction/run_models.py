"""Offline candidate-span baselines. This module is never imported by production."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


MODEL_NAMES = {
    "bert": "dslim/bert-base-NER",
    "xlm-roberta": "Davlan/xlm-roberta-base-ner-hrl",
    "gliner": "urchade/gliner_multi-v2.1",
}

TYPE_MAP = {
    "ORG": "organization",
    "PER": "person",
    "LOC": "place",
    "MISC": "other",
}


def transformer_predictor(model_name: str):
    from transformers import pipeline

    extractor = pipeline(
        "token-classification",
        model=model_name,
        aggregation_strategy="simple",
    )

    def predict(text: str) -> list[dict[str, object]]:
        entities = []
        for result in extractor(text):
            label = str(result.get("entity_group", "MISC"))
            entities.append(
                {
                    "surface": str(result["word"]),
                    "entityType": TYPE_MAP.get(label, "other"),
                    "relationship": "unknown",
                    "score": float(result["score"]),
                }
            )
        return entities

    return predict


def gliner_predictor(model_name: str):
    from gliner import GLiNER

    extractor = GLiNER.from_pretrained(model_name)
    labels = ["brand", "company", "organization", "product", "person", "place"]

    def predict(text: str) -> list[dict[str, object]]:
        return [
            {
                "surface": entity["text"],
                "entityType": entity["label"],
                "relationship": "unknown",
                "score": float(entity["score"]),
            }
            for entity in extractor.predict_entities(text, labels)
        ]

    return predict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", choices=MODEL_NAMES, required=True)
    arguments = parser.parse_args()
    model_name = MODEL_NAMES[arguments.model]
    predict = (
        gliner_predictor(model_name)
        if arguments.model == "gliner"
        else transformer_predictor(model_name)
    )
    with arguments.input.open(encoding="utf-8") as source, arguments.output.open(
        "w", encoding="utf-8"
    ) as destination:
        for line in source:
            if not line.strip():
                continue
            record = json.loads(line)
            prediction = {"id": record["id"], "entities": predict(record["answer"])}
            destination.write(json.dumps(prediction, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
