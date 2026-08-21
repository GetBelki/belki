import { readFileSync } from "node:fs";

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${String(error)}`);
      }
    });
}

function entityKey(entity, competitorsOnly) {
  const relationship = entity.relationship ?? "unknown";
  if (competitorsOnly && relationship !== "competitor") return null;
  const identity = normalize(
    entity.canonicalName ?? entity.canonical_name ?? entity.surface,
  );
  if (!identity) return null;
  return competitorsOnly
    ? identity
    : `${normalize(entity.entityType ?? entity.entity_type ?? "other")}:${identity}`;
}

function keys(record, competitorsOnly) {
  return new Set((record.entities ?? [])
    .map((entity) => entityKey(entity, competitorsOnly))
    .filter(Boolean));
}

function spanKeys(record) {
  return new Set((record.entities ?? [])
    .map((entity) => normalize(
      entity.canonicalName ?? entity.canonical_name ?? entity.surface,
    ))
    .filter(Boolean));
}

function emptyCounts() {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0 };
}

function addCounts(target, expected, actual) {
  for (const value of actual) {
    if (expected.has(value)) target.truePositive += 1;
    else target.falsePositive += 1;
  }
  for (const value of expected) {
    if (!actual.has(value)) target.falseNegative += 1;
  }
}

function scoreCounts(counts) {
  const precisionDenominator = counts.truePositive + counts.falsePositive;
  const recallDenominator = counts.truePositive + counts.falseNegative;
  const precision = precisionDenominator ? counts.truePositive / precisionDenominator : 1;
  const recall = recallDenominator ? counts.truePositive / recallDenominator : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { ...counts, precision, recall, f1 };
}

export function scoreEntityPredictions(goldRecords, predictionRecords) {
  const predictions = new Map(predictionRecords.map((record) => [record.id, record]));
  const spanCounts = emptyCounts();
  const entityCounts = emptyCounts();
  const competitorCounts = emptyCounts();
  const autoTrackCounts = emptyCounts();
  const languages = new Map();
  for (const gold of goldRecords) {
    const prediction = predictions.get(gold.id) ?? { entities: [] };
    addCounts(spanCounts, spanKeys(gold), spanKeys(prediction));
    addCounts(entityCounts, keys(gold, false), keys(prediction, false));
    addCounts(competitorCounts, keys(gold, true), keys(prediction, true));
    const goldCompetitors = keys(gold, true);
    const expectedAuto = gold.autoTrackEntities
      ? new Set([...goldCompetitors].filter(
        (key) => gold.autoTrackEntities.map(normalize).includes(key),
      ))
      : goldCompetitors;
    const actualAuto = new Set((prediction.entities ?? [])
      .filter((entity) => entity.autoTrackEligible === true)
      .map((entity) => entityKey(entity, true))
      .filter(Boolean));
    addCounts(autoTrackCounts, expectedAuto, actualAuto);
    const language = gold.languageCode ?? "unknown";
    const languageCounts = languages.get(language) ?? emptyCounts();
    addCounts(languageCounts, keys(gold, true), keys(prediction, true));
    languages.set(language, languageCounts);
  }
  return {
    answers: goldRecords.length,
    spans: scoreCounts(spanCounts),
    entities: scoreCounts(entityCounts),
    competitors: scoreCounts(competitorCounts),
    autoTrack: scoreCounts(autoTrackCounts),
    languages: Object.fromEntries(
      [...languages.entries()].map(([language, counts]) => [language, scoreCounts(counts)]),
    ),
  };
}

export function v2Gate(report, baseline) {
  const failures = [];
  if (report.competitors.precision < 0.9) failures.push("competitor precision is below 90%");
  if (report.competitors.recall < 0.9) failures.push("competitor recall is below 90%");
  if (report.competitors.f1 < baseline.competitors.f1 + 0.05) {
    failures.push("competitor F1 did not improve by five percentage points");
  }
  if (report.autoTrack.precision < 0.98) failures.push("auto-track precision is below 98%");
  for (const [language, languageReport] of Object.entries(report.languages)) {
    const baselineLanguage = baseline.languages[language];
    if (baselineLanguage && languageReport.f1 < baselineLanguage.f1 - 0.05) {
      failures.push(`${language} competitor F1 regressed by more than five points`);
    }
  }
  return failures;
}

function argumentsFrom(argv) {
  const options = { predictions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--gold") options.gold = argv[++index];
    else if (value === "--prediction") options.predictions.push(argv[++index]);
    else if (value === "--gate") options.gate = argv[++index];
    else if (value === "--baseline") options.baseline = argv[++index];
  }
  return options;
}

if (process.argv[1]?.endsWith("entity-extraction-benchmark.mjs")) {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options.gold || options.predictions.length === 0) {
    console.error("Usage: pnpm benchmark:entities -- --gold GOLD.jsonl --prediction NAME=PREDICTIONS.jsonl [--gate NAME --baseline NAME]");
    process.exitCode = 2;
  } else {
    const gold = readJsonLines(options.gold);
    const reports = Object.fromEntries(options.predictions.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error(`Invalid prediction argument: ${entry}`);
      const name = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      return [name, scoreEntityPredictions(gold, readJsonLines(path))];
    }));
    console.log(JSON.stringify(reports, null, 2));
    if (options.gate || options.baseline) {
      if (!options.gate || !options.baseline || !reports[options.gate] || !reports[options.baseline]) {
        throw new Error("--gate and --baseline must name supplied prediction files.");
      }
      const failures = v2Gate(reports[options.gate], reports[options.baseline]);
      if (failures.length) {
        console.error(`Entity extraction gate failed:\n- ${failures.join("\n- ")}`);
        process.exitCode = 1;
      }
    }
  }
}
