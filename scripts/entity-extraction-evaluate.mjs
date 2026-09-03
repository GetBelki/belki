import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const privateDirectory = resolve(root, "evaluation/entity-extraction/private");
const samplePath = resolve(privateDirectory, "sample.jsonl");
const v1Path = resolve(privateDirectory, "v1.jsonl");
const v2Path = resolve(privateDirectory, "v2.jsonl");
const reviewPath = resolve(privateDirectory, "review.html");
const manifestPath = resolve(privateDirectory, "manifest.json");
const reviewTemplatePath = resolve(
  root,
  "evaluation/entity-extraction/review-template.html",
);
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const evaluationConfig = resolve(
  root,
  "evaluation/entity-extraction/wrangler.jsonc",
);
const DEFAULT_LIMIT = 300;
const EVALUATION_PORT = 8791;
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function parseOptions(argv) {
  const options = {
    command: "all",
    limit: DEFAULT_LIMIT,
    concurrency: 4,
    refresh: false,
    restart: false,
    output: v2Path,
    spanModel: DEFAULT_MODEL,
    relationshipModel: DEFAULT_MODEL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["all", "prepare", "run", "review"].includes(value)) options.command = value;
    else if (value === "--limit") options.limit = Number(argv[++index]);
    else if (value === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (value === "--refresh") options.refresh = true;
    else if (value === "--restart") options.restart = true;
    else if (value === "--output") options.output = resolve(root, argv[++index]);
    else if (value === "--span-model") options.spanModel = argv[++index];
    else if (value === "--relationship-model") options.relationshipModel = argv[++index];
  }
  if (!Number.isInteger(options.limit) || options.limit < 10 || options.limit > 500) {
    throw new Error("--limit must be an integer between 10 and 500");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("--concurrency must be an integer between 1 and 8");
  }
  if (!options.spanModel || !options.relationshipModel) {
    throw new Error("--span-model and --relationship-model require a model ID");
  }
  return options;
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJsonLines(path, records) {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rowsFromWranglerJson(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("Wrangler returned no JSON result");
  const payload = JSON.parse(stdout.slice(start));
  return payload.flatMap((statement) => statement.results ?? []);
}

async function runWrangler(argumentsList) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(wrangler, argumentsList, {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: "/tmp/ai-tracker-entity-evaluation.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(
        `Wrangler exited with ${String(code)}: ${stderr.slice(-2_000)}`,
      ));
    });
  });
}

async function d1Rows(binding, sql) {
  const stdout = await runWrangler([
    "d1",
    "execute",
    binding,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  return rowsFromWranglerJson(stdout);
}

function roundRobin(groups, limit) {
  const selected = [];
  const queues = [...groups.values()].map((rows) => [...rows]);
  while (selected.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const row = queue.shift();
      if (row) selected.push(row);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

function stratifiedSample(rows, limit) {
  const languageWeights = new Map([
    ["de", 0.4],
    ["es", 0.3],
    ["en", 0.2],
    ["pt", 0.1],
  ]);
  const byLanguage = new Map();
  for (const row of rows) {
    const language = row.language_code || "unknown";
    const sources = byLanguage.get(language) ?? new Map();
    const sourceRows = sources.get(row.tracking_source) ?? [];
    sourceRows.push(row);
    sources.set(row.tracking_source, sourceRows);
    byLanguage.set(language, sources);
  }
  const selected = [];
  for (const [language, weight] of languageWeights) {
    const groups = byLanguage.get(language);
    if (!groups) continue;
    const target = Math.round(limit * weight);
    selected.push(...roundRobin(groups, target));
  }
  if (selected.length < limit) {
    const used = new Set(selected.map((row) => row.snapshot_id));
    const remainingGroups = new Map();
    for (const row of rows) {
      if (used.has(row.snapshot_id)) continue;
      const key = `${row.language_code}:${row.tracking_source}`;
      const group = remainingGroups.get(key) ?? [];
      group.push(row);
      remainingGroups.set(key, group);
    }
    selected.push(...roundRobin(remainingGroups, limit - selected.length));
  }
  return selected.slice(0, limit);
}

async function mapConcurrent(items, concurrency, callback) {
  let index = 0;
  const results = new Array(items.length);
  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await callback(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  ));
  return results;
}

function chunks(values, size = 70) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function anonymizer(salt) {
  return (kind, value) => createHash("sha256")
    .update(`${salt}:${kind}:${value}`)
    .digest("hex")
    .slice(0, 24);
}

async function prepare(limit, refresh) {
  mkdirSync(privateDirectory, { recursive: true });
  if (!refresh && existsSync(samplePath) && readJsonLines(samplePath).length >= limit) {
    console.log(`Private sample already contains ${readJsonLines(samplePath).length} answers.`);
    return;
  }
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { salt: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const hash = anonymizer(manifest.salt);
  const mentionColumns = await d1Rows("CONTROL_DB", "PRAGMA table_info(entity_mentions)");
  const versioned = mentionColumns.some((column) => column.name === "extractor_version");
  const jobVersionFilter = versioned
    ? "AND job.extractor_version = 'entities-v1'"
    : "";
  const candidates = await d1Rows("CONTROL_DB", `
    WITH ranked AS (
      SELECT snapshot.id AS snapshot_id, snapshot.project_id,
        snapshot.tracked_query_id, snapshot.shard_id, snapshot.tracking_source,
        snapshot.captured_at, query.query_text, query.language_code,
        project.primary_domain,
        ROW_NUMBER() OVER (
          PARTITION BY query.language_code, snapshot.tracking_source
          ORDER BY random()
        ) AS sample_rank
      FROM snapshot_index snapshot
      JOIN tracked_queries query ON query.id = snapshot.tracked_query_id
      JOIN projects project ON project.id = snapshot.project_id
      JOIN entity_extraction_jobs job ON job.snapshot_id = snapshot.id
      WHERE query.deleted_at IS NULL AND project.deleted_at IS NULL
        AND project.entity_extraction_enabled = 1
        AND job.status = 'completed' ${jobVersionFilter}
    )
    SELECT * FROM ranked WHERE sample_rank <= 160
  `);
  const oversample = stratifiedSample(candidates, Math.min(candidates.length, limit + 80));
  const byShard = new Map();
  for (const row of oversample) {
    const group = byShard.get(row.shard_id) ?? [];
    group.push(row);
    byShard.set(row.shard_id, group);
  }
  const snapshotDetails = new Map();
  await mapConcurrent([...byShard.entries()], 4, async ([shardId, rows]) => {
    const binding = `SNAPSHOT_DB_${String(shardId).padStart(2, "0")}`;
    for (const rowChunk of chunks(rows)) {
      const ids = rowChunk.map((row) => sqlString(row.snapshot_id)).join(",");
      const statements = await d1Rows(binding, `
        SELECT id AS snapshot_id, answer_markdown FROM snapshots WHERE id IN (${ids});
        SELECT entity.snapshot_id, entity.title,
          COALESCE(GROUP_CONCAT(DISTINCT url.registrable_domain), '') AS domains_csv
        FROM snapshot_brand_entities entity
        LEFT JOIN brand_entity_urls url ON url.brand_entity_id = entity.id
        WHERE entity.snapshot_id IN (${ids})
        GROUP BY entity.snapshot_id, entity.id, entity.title;
        SELECT snapshot_id, registrable_domain FROM snapshot_domains
        WHERE snapshot_id IN (${ids});
      `);
      for (const detail of statements) {
        const current = snapshotDetails.get(detail.snapshot_id) ?? {
          answer: "",
          providerEntities: [],
          observedDomains: [],
        };
        if ("answer_markdown" in detail) current.answer = detail.answer_markdown ?? "";
        else if ("title" in detail) {
          current.providerEntities.push({
            title: detail.title,
            domains: String(detail.domains_csv ?? "").split(",").filter(Boolean),
          });
        } else if ("registrable_domain" in detail) {
          current.observedDomains.push(detail.registrable_domain);
        }
        snapshotDetails.set(detail.snapshot_id, current);
      }
    }
  });
  const usable = oversample.filter((row) => snapshotDetails.get(row.snapshot_id)?.answer.trim());
  const selected = stratifiedSample(usable, limit);
  if (selected.length < limit) {
    throw new Error(`Only ${selected.length} usable answers were available; requested ${limit}.`);
  }
  const projectIds = [...new Set(selected.map((row) => row.project_id))];
  const brands = await d1Rows("CONTROL_DB", `
    SELECT id, project_id, kind, name, aliases_json, domains_json
    FROM tracked_brands WHERE project_id IN (${projectIds.map(sqlString).join(",")})
  `);
  const brandsByProject = new Map();
  for (const brand of brands) {
    const rows = brandsByProject.get(brand.project_id) ?? [];
    rows.push({
      id: hash("brand", brand.id),
      kind: brand.kind,
      name: brand.name,
      aliases_json: brand.aliases_json,
      domains_json: brand.domains_json,
    });
    brandsByProject.set(brand.project_id, rows);
  }
  const selectedIds = selected.map((row) => row.snapshot_id);
  const mentionVersionFilter = versioned
    ? "AND mention.extractor_version = 'entities-v1'"
    : "";
  const v1Mentions = [];
  for (const idChunk of chunks(selectedIds)) {
    v1Mentions.push(...await d1Rows("CONTROL_DB", `
      SELECT mention.snapshot_id, mention.surface_text, mention.entity_type,
        mention.relationship, mention.confidence, mention.evidence_json,
        mention.sources_json, entity.canonical_name, entity.status
      FROM entity_mentions mention
      JOIN project_entities entity ON entity.id = mention.entity_id
      WHERE mention.snapshot_id IN (${idChunk.map(sqlString).join(",")})
        ${mentionVersionFilter}
    `));
  }
  const mentionsBySnapshot = new Map();
  for (const mention of v1Mentions) {
    const rows = mentionsBySnapshot.get(mention.snapshot_id) ?? [];
    rows.push({
      surface: mention.surface_text,
      canonicalName: mention.canonical_name,
      entityType: mention.entity_type,
      relationship: mention.relationship,
      confidence: Number(mention.confidence),
      evidence: JSON.parse(mention.evidence_json || "[]"),
      sources: JSON.parse(mention.sources_json || "[]"),
      autoTrackEligible: mention.status === "auto_tracked",
    });
    mentionsBySnapshot.set(mention.snapshot_id, rows);
  }
  const samples = selected.map((row) => {
    const detail = snapshotDetails.get(row.snapshot_id);
    return {
      id: hash("snapshot", row.snapshot_id),
      projectKey: hash("project", row.project_id),
      promptKey: hash("query", row.tracked_query_id),
      languageCode: row.language_code,
      trackingSource: row.tracking_source,
      capturedAt: row.captured_at,
      queryText: row.query_text,
      answer: detail.answer,
      primaryDomain: row.primary_domain,
      trackedBrands: brandsByProject.get(row.project_id) ?? [],
      providerEntities: detail.providerEntities,
      observedDomains: detail.observedDomains,
    };
  });
  const v1 = selected.map((row) => ({
    id: hash("snapshot", row.snapshot_id),
    entities: mentionsBySnapshot.get(row.snapshot_id) ?? [],
  }));
  writeJsonLines(samplePath, samples);
  writeJsonLines(v1Path, v1);
  if (refresh && existsSync(v2Path)) writeJsonLines(v2Path, []);
  const distribution = Object.groupBy(
    samples,
    (sample) => `${sample.languageCode}/${sample.trackingSource}`,
  );
  console.log(`Prepared ${samples.length} private answers and v1 predictions.`);
  console.log(Object.fromEntries(
    Object.entries(distribution).map(([key, records]) => [key, records.length]),
  ));
}

async function waitForWorker(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Evaluation Worker stopped before becoming ready.");
    try {
      const response = await fetch(`http://127.0.0.1:${EVALUATION_PORT}/health`);
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Timed out waiting for the local evaluation Worker.");
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function applyAutoTrackEligibility(samples, predictions) {
  const samplesById = new Map(samples.map((sample) => [sample.id, sample]));
  const observations = new Map();
  for (const prediction of predictions) {
    const sample = samplesById.get(prediction.id);
    if (!sample) continue;
    for (const entity of prediction.entities) {
      if (entity.relationship !== "competitor") continue;
      const key = `${sample.projectKey}:${normalize(entity.canonical_name ?? entity.surface)}`;
      const observation = observations.get(key) ?? {
        snapshots: new Set(),
        prompts: new Set(),
        strongSnapshots: new Set(),
        corroborated: false,
      };
      observation.snapshots.add(sample.id);
      observation.prompts.add(sample.promptKey);
      if (entity.evidence_tier === "strong") observation.strongSnapshots.add(sample.id);
      observation.corroborated ||= Boolean(
        entity.providerCorroborated || entity.domainCorroborated,
      );
      observations.set(key, observation);
    }
  }
  for (const prediction of predictions) {
    const sample = samplesById.get(prediction.id);
    if (!sample) continue;
    for (const entity of prediction.entities) {
      const key = `${sample.projectKey}:${normalize(entity.canonical_name ?? entity.surface)}`;
      const observation = observations.get(key);
      if (!observation || entity.relationship !== "competitor") {
        entity.autoTrackEligible = false;
        continue;
      }
      entity.autoTrackEligible = observation.corroborated
        ? observation.snapshots.size >= 3 &&
          observation.prompts.size >= 2 &&
          observation.strongSnapshots.size >= 2
        : observation.snapshots.size >= 5 &&
          observation.prompts.size >= 3 &&
          observation.strongSnapshots.size >= 3;
    }
  }
}

async function runV2({ concurrency, limit, restart, output, spanModel, relationshipModel }) {
  const samples = readJsonLines(samplePath).slice(0, limit);
  if (!samples.length) throw new Error("No private sample exists. Run prepare first.");
  mkdirSync(resolve(output, ".."), { recursive: true });
  if (restart) writeJsonLines(output, []);
  const completed = new Map(readJsonLines(output).map((record) => [record.id, record]));
  const child = spawn(wrangler, [
    "dev",
    "--config",
    evaluationConfig,
    "--ip",
    "127.0.0.1",
    "--port",
    String(EVALUATION_PORT),
    "--log-level",
    "error",
    "--show-interactive-dev-session=false",
  ], {
    cwd: root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: "/tmp/ai-tracker-entity-evaluation-worker.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerErrors = "";
  child.stderr.on("data", (chunk) => {
    workerErrors += chunk.toString();
    workerErrors = workerErrors.slice(-4_000);
  });
  try {
    await waitForWorker(child);
    let processed = completed.size;
    const pending = samples.filter((sample) => !completed.has(sample.id));
    await mapConcurrent(pending, concurrency, async (sample) => {
      let result;
      let lastError = "unknown extraction error";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${EVALUATION_PORT}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...sample,
            evaluationModels: { spanModel, relationshipModel },
          }),
        });
        if (response.ok) {
          result = await response.json();
          break;
        }
        const error = await response.json();
        lastError = String(error.error);
        if (attempt < 3) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
        }
      }
      if (!result) throw new Error(`v2 extraction failed for ${sample.id}: ${lastError}`);
      completed.set(sample.id, {
        id: sample.id,
        entities: result.entities,
        usage: result.usage,
        models: { spanModel, relationshipModel },
      });
      processed += 1;
      if (processed % 10 === 0 || processed === samples.length) {
        writeJsonLines(output, [...completed.values()]);
        console.log(`Evaluated ${processed}/${samples.length} answers with ${spanModel}.`);
      }
    });
    const predictions = samples.map((sample) => completed.get(sample.id));
    applyAutoTrackEligibility(samples, predictions);
    writeJsonLines(output, predictions);
  } catch (error) {
    if (completed.size) writeJsonLines(output, [...completed.values()]);
    throw new Error(`${String(error)}${workerErrors ? `\n${workerErrors}` : ""}`);
  } finally {
    child.kill("SIGTERM");
  }
}

function buildReview() {
  const samples = readJsonLines(samplePath);
  const v1 = new Map(readJsonLines(v1Path).map((record) => [record.id, record]));
  const v2 = new Map(readJsonLines(v2Path).map((record) => [record.id, record]));
  if (!samples.length || v2.size !== samples.length) {
    throw new Error("The sample and completed v2 predictions are required before review generation.");
  }
  const data = samples.map((sample) => ({
    id: sample.id,
    languageCode: sample.languageCode,
    trackingSource: sample.trackingSource,
    queryText: sample.queryText,
    answer: sample.answer,
    v1: (v1.get(sample.id)?.entities ?? []).map((entity) => ({
      surface: entity.surface,
      canonicalName: entity.canonicalName ?? entity.canonical_name,
      entityType: entity.entityType ?? entity.entity_type,
      relationship: entity.relationship,
    })),
    v2: (v2.get(sample.id)?.entities ?? []).map((entity) => ({
      surface: entity.surface,
      canonicalName: entity.canonicalName ?? entity.canonical_name,
      entityType: entity.entityType ?? entity.entity_type,
      relationship: entity.relationship,
    })),
  }));
  const serialized = JSON.stringify(data).replaceAll("</script", "<\\/script");
  const template = readFileSync(reviewTemplatePath, "utf8");
  writeFileSync(reviewPath, template.replace("__EVALUATION_DATA__", serialized));
  console.log(`Private review page: ${reviewPath}`);
}

const options = parseOptions(process.argv.slice(2));
if (["all", "prepare"].includes(options.command)) {
  await prepare(options.limit, options.refresh);
}
if (["all", "run"].includes(options.command)) {
  await runV2(options);
}
if (["all", "review"].includes(options.command)) buildReview();
