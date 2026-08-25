import type {
  EntityExtractionQueueMessage,
  TrackingSource,
} from "../../shared/contracts";
import { sha256 } from "../lib/crypto";
import { brandMentionText, normalizeBrand } from "../lib/domain";
import { writeAudit } from "../lib/audit";
import { ApiError, jsonParse, nowIso } from "../lib/http";
import { commitUsage, releaseUsage, reserveUsage, USAGE_UNITS } from "../lib/usage";
import { getShard } from "../lib/shards";
import { preserveBrandMetricsHistory } from "../lib/brand-metrics-state";
import { syncSnapshotBrandMetrics } from "../ingestion/brand-metrics";
import {
  ENTITY_EXTRACTION_MODEL,
  ENTITY_EXTRACTOR_VERSION,
  ENTITY_INPUT_PRICE_PER_MILLION_USD,
  ENTITY_OUTPUT_PRICE_PER_MILLION_USD,
  ENTITY_PRICING_VERSION,
  ExtractionResponseSchema,
  RELATIONSHIP_JSON_SCHEMA,
  SPAN_EXTRACTION_JSON_SCHEMA,
  applyRelationshipAssessments,
  chunkEntityText,
  countSurface,
  estimatedEntityExtractionCost,
  extractionSystemPrompt,
  parsedRelationshipAiResponse,
  parsedSpanAiResponse,
  relationshipSystemPrompt,
  validateExtractedEntities,
  type EvidenceTier,
  type ExtractedEntity,
  type ProviderEntityRow,
  type TrackedBrandRow,
  type ValidatedEntity,
} from "./entity-extraction-core";

interface EntityJobRow {
  id: string;
  snapshot_id: string;
  workspace_id: string;
  project_id: string;
  tracked_query_id: string;
  shard_id: number;
  status: string;
  attempts: number;
  extractor_version: string;
  run_type: "live" | "backfill" | "evaluation";
  query_text: string;
  language_code: string;
  primary_domain: string | null;
  captured_at: string;
  tracking_source: TrackingSource;
  active_entity_extractor_version: string;
  entity_extraction_enabled: number;
  entity_auto_track_enabled: number;
}

interface ChunkResult {
  entities: ExtractedEntity[];
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface AiCallResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
}

interface CombinedEntity extends ValidatedEntity {
  surfaces: Set<string>;
  evidenceList: Set<string>;
  sourceSet: Set<ExtractedEntity["sources"][number]>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function aiCallResult<T>(
  result: unknown,
  parse: (value: unknown) => T,
): AiCallResult<T> {
  if (typeof result === "string") {
    return { value: parse(result), inputTokens: 0, outputTokens: 0 };
  }
  const envelope = record(result);
  if (!envelope || !("response" in envelope)) {
    throw new Error("Workers AI returned no synchronous response");
  }
  const usage = record(envelope.usage);
  return {
    value: parse(envelope.response),
    inputTokens: Number(usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.completion_tokens ?? 0),
  };
}

function relationshipCandidates(entities: ValidatedEntity[]) {
  return entities
    .filter((entity) =>
      !entity.trackedBrand &&
      ["brand", "company", "organization"].includes(entity.entity_type),
    )
    .map((entity) => ({
      surface: entity.surface,
      entity_type: entity.entity_type,
      evidence: entity.evidence,
      provider_corroborated: entity.providerCorroborated,
      domain_corroborated: entity.domainCorroborated,
    }));
}

async function runChunk(
  env: Env,
  job: EntityJobRow,
  chunk: string,
  chunkIndex: number,
  brands: TrackedBrandRow[],
  providerEntities: ProviderEntityRow[],
  observedDomains: string[],
): Promise<ChunkResult> {
  const inputHash = await sha256(JSON.stringify({
    version: job.extractor_version,
    query: job.query_text,
    language: job.language_code,
    chunk,
    brands: brands.map((brand) => [brand.id, brand.name, brand.aliases_json, brand.domains_json]),
    providerEntities,
    observedDomains,
  }));
  const existing = await env.CONTROL_DB.prepare(
    `SELECT input_hash, result_json, input_tokens, output_tokens, estimated_cost_usd
     FROM entity_extraction_chunks
     WHERE job_id = ? AND chunk_index = ? AND status = 'completed'`,
  )
    .bind(job.id, chunkIndex)
    .first<{
      input_hash: string;
      result_json: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    }>();
  if (existing?.input_hash === inputHash) {
    return {
      entities: ExtractionResponseSchema.parse(
        jsonParse<unknown>(existing.result_json, { entities: [] }),
      ).entities,
      inputTokens: Number(existing.input_tokens),
      outputTokens: Number(existing.output_tokens),
      estimatedCostUsd: Number(existing.estimated_cost_usd),
    };
  }

  const now = nowIso();
  await env.CONTROL_DB.prepare(
    `INSERT INTO entity_extraction_chunks (
      job_id, chunk_index, input_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', ?, ?)
    ON CONFLICT(job_id, chunk_index) DO UPDATE SET
      input_hash = excluded.input_hash, status = 'processing',
      result_json = '{"entities":[]}', input_tokens = 0, output_tokens = 0,
      estimated_cost_usd = 0, completed_at = NULL, updated_at = excluded.updated_at`,
  )
    .bind(job.id, chunkIndex, inputHash, now, now)
    .run();

  const reservation = job.run_type === "live" ? {
    reservationId: `${job.id}:chunk:${chunkIndex}`,
    sku: "entity_extraction" as const,
    units: USAGE_UNITS.entity_extraction,
    resourceType: "entity_extraction_chunk",
    resourceId: `${job.id}:${chunkIndex}`,
  } : null;
  if (reservation) await reserveUsage(env, job.workspace_id, reservation);
  let inferenceCompleted = false;
  let usageFinalized = false;
  try {
    const knownBrands = brands.map((brand) => ({
      name: brand.name,
      kind: brand.kind,
      aliases: jsonParse<string[]>(brand.aliases_json, []),
      domains: jsonParse<string[]>(brand.domains_json, []),
    }));
    const spanRaw = await env.AI.run(ENTITY_EXTRACTION_MODEL, {
      messages: [
        { role: "system", content: extractionSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            language_code: job.language_code,
            answer_chunk: chunk,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: SPAN_EXTRACTION_JSON_SCHEMA,
      },
      temperature: 0,
      seed: 731_991,
      max_tokens: 1_400,
    });
    inferenceCompleted = true;
    const spanResult = aiCallResult(spanRaw, parsedSpanAiResponse);
    let entities = validateExtractedEntities(spanResult.value, chunk, {
      providerEntities,
      observedDomains,
      trackedBrands: brands,
    });
    let inputTokens = spanResult.inputTokens;
    let outputTokens = spanResult.outputTokens;

    const unresolved = relationshipCandidates(entities);
    if (unresolved.length) {
      const relationshipRaw = await env.AI.run(ENTITY_EXTRACTION_MODEL, {
        messages: [
          { role: "system", content: relationshipSystemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              tracked_query: job.query_text,
              owned_domain: job.primary_domain,
              tracked_brands: knownBrands,
              candidates: unresolved,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: RELATIONSHIP_JSON_SCHEMA,
        },
        temperature: 0,
        seed: 731_991,
        max_tokens: 1_000,
      });
      const relationshipResult = aiCallResult(
        relationshipRaw,
        parsedRelationshipAiResponse,
      );
      entities = applyRelationshipAssessments(entities, relationshipResult.value);
      inputTokens += relationshipResult.inputTokens;
      outputTokens += relationshipResult.outputTokens;
    }

    if (reservation) {
      await commitUsage(env, job.workspace_id, reservation);
      usageFinalized = true;
    }
    const estimatedCostUsd = estimatedEntityExtractionCost(inputTokens, outputTokens);
    await env.CONTROL_DB.prepare(
      `UPDATE entity_extraction_chunks SET status = 'completed', result_json = ?,
        input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?,
        completed_at = ?, updated_at = ? WHERE job_id = ? AND chunk_index = ?`,
    )
      .bind(
        JSON.stringify({ entities }),
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        nowIso(),
        nowIso(),
        job.id,
        chunkIndex,
      )
      .run();
    return { entities, inputTokens, outputTokens, estimatedCostUsd };
  } catch (error) {
    if (reservation && !usageFinalized) {
      if (inferenceCompleted) await commitUsage(env, job.workspace_id, reservation);
      else await releaseUsage(env, job.workspace_id, reservation);
    }
    await env.CONTROL_DB.prepare(
      `UPDATE entity_extraction_chunks SET status = 'failed', updated_at = ?
       WHERE job_id = ? AND chunk_index = ?`,
    ).bind(nowIso(), job.id, chunkIndex).run();
    throw error;
  }
}

function relationshipRank(value: ValidatedEntity["relationship"]): number {
  return value === "owned" ? 4 : value === "competitor" ? 3 : value === "mentioned" ? 2 : 1;
}

function evidenceRank(value: EvidenceTier): number {
  return value === "strong" ? 3 : value === "moderate" ? 2 : 1;
}

function compatibilityConfidence(value: EvidenceTier): number {
  return value === "strong" ? 1 : value === "moderate" ? 0.75 : 0.5;
}

async function persistEntities(
  env: Env,
  job: EntityJobRow,
  answer: string,
  entities: ValidatedEntity[],
): Promise<void> {
  const combined = new Map<string, CombinedEntity>();
  for (const entity of entities) {
    const existing = combined.get(entity.normalizedName);
    if (!existing) {
      combined.set(entity.normalizedName, {
        ...entity,
        surfaces: new Set([entity.surface]),
        evidenceList: new Set([entity.evidence]),
        sourceSet: new Set(entity.sources),
      });
      continue;
    }
    existing.surfaces.add(entity.surface);
    existing.evidenceList.add(entity.evidence);
    entity.sources.forEach((source) => existing.sourceSet.add(source));
    existing.providerCorroborated ||= entity.providerCorroborated;
    existing.domainCorroborated ||= entity.domainCorroborated;
    existing.domains = [...new Set([...existing.domains, ...entity.domains])];
    if (relationshipRank(entity.relationship) > relationshipRank(existing.relationship)) {
      existing.relationship = entity.relationship;
      existing.relationship_reason = entity.relationship_reason;
    }
    if (evidenceRank(entity.evidence_tier) > evidenceRank(existing.evidence_tier)) {
      existing.evidence_tier = entity.evidence_tier;
    }
    if (entity.trackedBrand || entity.providerCorroborated) {
      existing.canonical_name = entity.canonical_name;
      existing.normalizedName = entity.normalizedName;
    }
  }

  await env.CONTROL_DB.prepare(
    "DELETE FROM entity_mentions WHERE snapshot_id = ? AND extractor_version = ?",
  ).bind(job.snapshot_id, job.extractor_version).run();
  for (const entity of combined.values()) {
    const now = nowIso();
    const storedEntity = await env.CONTROL_DB.prepare(
      `SELECT aliases_json, domains_json FROM project_entities
       WHERE project_id = ? AND normalized_name = ?`,
    ).bind(job.project_id, entity.normalizedName).first<{
      aliases_json: string;
      domains_json: string;
    }>();
    const aliases = [...new Set([
      ...jsonParse<string[]>(storedEntity?.aliases_json, []),
      ...entity.surfaces,
    ])].filter((surface) => normalizeBrand(surface) !== entity.normalizedName);
    const domains = [...new Set([
      ...jsonParse<string[]>(storedEntity?.domains_json, []),
      ...entity.domains,
    ])];
    await env.CONTROL_DB.prepare(
      `INSERT INTO project_entities (
        id, workspace_id, project_id, canonical_name, normalized_name,
        entity_type, relationship, status, aliases_json, domains_json,
        tracked_brand_id, provider_corroborated, domain_corroborated,
        first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, normalized_name) DO UPDATE SET
        canonical_name = CASE
          WHEN project_entities.tracked_brand_id IS NOT NULL THEN project_entities.canonical_name
          WHEN excluded.tracked_brand_id IS NOT NULL OR excluded.provider_corroborated = 1
            THEN excluded.canonical_name
          ELSE project_entities.canonical_name END,
        entity_type = CASE
          WHEN project_entities.entity_type IN ('other', 'organization')
            THEN excluded.entity_type ELSE project_entities.entity_type END,
        relationship = CASE
          WHEN excluded.relationship = 'owned' THEN 'owned'
          WHEN excluded.relationship = 'competitor' AND project_entities.relationship != 'owned'
            THEN 'competitor'
          WHEN project_entities.relationship = 'unknown' THEN excluded.relationship
          ELSE project_entities.relationship END,
        aliases_json = excluded.aliases_json,
        domains_json = excluded.domains_json,
        tracked_brand_id = COALESCE(project_entities.tracked_brand_id, excluded.tracked_brand_id),
        status = CASE
          WHEN excluded.tracked_brand_id IS NOT NULL THEN 'tracked'
          ELSE project_entities.status END,
        provider_corroborated = MAX(project_entities.provider_corroborated, excluded.provider_corroborated),
        domain_corroborated = MAX(project_entities.domain_corroborated, excluded.domain_corroborated),
        last_seen_at = MAX(project_entities.last_seen_at, excluded.last_seen_at),
        updated_at = excluded.updated_at`,
    )
      .bind(
        crypto.randomUUID(),
        job.workspace_id,
        job.project_id,
        entity.canonical_name,
        entity.normalizedName,
        entity.entity_type,
        entity.relationship,
        entity.trackedBrand ? "tracked" : "candidate",
        JSON.stringify(aliases),
        JSON.stringify(domains),
        entity.trackedBrand?.id ?? null,
        entity.providerCorroborated ? 1 : 0,
        entity.domainCorroborated ? 1 : 0,
        job.captured_at,
        job.captured_at,
        now,
        now,
      )
      .run();
    const stored = await env.CONTROL_DB.prepare(
      "SELECT id FROM project_entities WHERE project_id = ? AND normalized_name = ?",
    ).bind(job.project_id, entity.normalizedName).first<{ id: string }>();
    if (!stored) continue;
    const occurrenceCount = [...entity.surfaces].reduce(
      (total, surface) => total + countSurface(answer, surface),
      0,
    );
    await env.CONTROL_DB.prepare(
      `INSERT INTO entity_mentions (
        id, snapshot_id, workspace_id, project_id, tracked_query_id, entity_id,
        surface_text, occurrence_count, entity_type, relationship, confidence,
        evidence_json, sources_json, captured_at, created_at, extractor_version,
        evidence_tier, relationship_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id, entity_id, extractor_version) DO UPDATE SET
        surface_text = excluded.surface_text,
        occurrence_count = excluded.occurrence_count,
        entity_type = excluded.entity_type,
        relationship = excluded.relationship,
        confidence = excluded.confidence,
        evidence_json = excluded.evidence_json,
        sources_json = excluded.sources_json,
        evidence_tier = excluded.evidence_tier,
        relationship_reason = excluded.relationship_reason`,
    )
      .bind(
        crypto.randomUUID(),
        job.snapshot_id,
        job.workspace_id,
        job.project_id,
        job.tracked_query_id,
        stored.id,
        entity.surface,
        Math.max(1, occurrenceCount),
        entity.entity_type,
        entity.relationship,
        compatibilityConfidence(entity.evidence_tier),
        JSON.stringify([...entity.evidenceList].slice(0, 5)),
        JSON.stringify([...entity.sourceSet]),
        job.captured_at,
        now,
        job.extractor_version,
        entity.evidence_tier,
        entity.relationship_reason,
      )
      .run();
  }

  await env.CONTROL_DB.prepare(
    `UPDATE project_entities SET
      snapshot_count = (
        SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
        WHERE mention.entity_id = project_entities.id AND mention.extractor_version = ?
      ),
      prompt_count = (
        SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
        WHERE mention.entity_id = project_entities.id AND mention.extractor_version = ?
      ),
      competitor_snapshot_count = (
        SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
        WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
          AND mention.extractor_version = ?
      ),
      competitor_prompt_count = (
        SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
        WHERE mention.entity_id = project_entities.id AND mention.relationship = 'competitor'
          AND mention.extractor_version = ?
      ),
      updated_at = ?
     WHERE project_id = ?
       AND ? = (
         SELECT active_entity_extractor_version FROM projects
         WHERE id = project_entities.project_id
       )`,
  ).bind(
    job.extractor_version,
    job.extractor_version,
    job.extractor_version,
    job.extractor_version,
    nowIso(),
    job.project_id,
    job.extractor_version,
  ).run();
}

type AutoTrackContext = Pick<
  EntityJobRow,
  | "project_id"
  | "workspace_id"
  | "extractor_version"
  | "active_entity_extractor_version"
  | "entity_auto_track_enabled"
>;

async function autoTrackEligibleCompetitors(
  env: Env,
  job: AutoTrackContext,
): Promise<number> {
  if (
    job.entity_auto_track_enabled !== 1 ||
    job.active_entity_extractor_version !== job.extractor_version
  ) return 0;
  const eligible = await env.CONTROL_DB.prepare(
    `SELECT entity.id, entity.canonical_name, entity.aliases_json, entity.domains_json
     FROM project_entities entity
     WHERE entity.project_id = ?
       AND entity.status = 'candidate'
       AND entity.entity_type IN ('brand', 'company', 'organization')
       AND entity.relationship = 'competitor'
       AND (
         (
           (entity.provider_corroborated = 1 OR entity.domain_corroborated = 1)
           AND (SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.extractor_version = ? AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 3
           AND (SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.extractor_version = ? AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 2
           AND (SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.evidence_tier = 'strong' AND mention.extractor_version = ?
               AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 2
         ) OR (
           entity.provider_corroborated = 0 AND entity.domain_corroborated = 0
           AND (SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.extractor_version = ? AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 5
           AND (SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.extractor_version = ? AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 3
           AND (SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = entity.id AND mention.relationship = 'competitor'
               AND mention.evidence_tier = 'strong' AND mention.extractor_version = ?
               AND julianday(mention.captured_at) >= julianday('now', '-30 days')) >= 3
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM tracked_brands brand
         WHERE brand.project_id = entity.project_id
           AND lower(trim(brand.name)) = entity.normalized_name
       )`,
  )
    .bind(
      job.project_id,
      job.extractor_version,
      job.extractor_version,
      job.extractor_version,
      job.extractor_version,
      job.extractor_version,
      job.extractor_version,
    )
    .all<{
      id: string;
      canonical_name: string;
      aliases_json: string;
      domains_json: string;
    }>();
  let tracked = 0;
  for (const entity of eligible.results) {
    const now = nowIso();
    await env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO tracked_brands (
        id, project_id, kind, name, aliases_json, domains_json, created_at, updated_at
      ) VALUES (?, ?, 'competitor', ?, ?, ?, ?, ?)`,
    ).bind(
      entity.id,
      job.project_id,
      entity.canonical_name,
      entity.aliases_json,
      entity.domains_json,
      now,
      now,
    ).run();
    const updated = await env.CONTROL_DB.prepare(
      `UPDATE project_entities SET status = 'auto_tracked', tracked_brand_id = ?, updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    ).bind(entity.id, now, entity.id).run();
    if (updated.meta.changes === 0) continue;
    tracked += 1;
    await writeAudit(env.CONTROL_DB, {
      workspaceId: job.workspace_id,
      action: "entity.auto_tracked",
      resourceType: "project_entity",
      resourceId: entity.id,
      metadata: {
        projectId: job.project_id,
        name: entity.canonical_name,
        extractorVersion: job.extractor_version,
      },
    });
  }
  if (tracked > 0) {
    await preserveBrandMetricsHistory(env.CONTROL_DB, job.project_id);
  }
  return tracked;
}

export async function processEntityExtraction(env: Env, jobId: string): Promise<void> {
  const job = await env.CONTROL_DB.prepare(
    `SELECT job.*, query.query_text, query.language_code, project.primary_domain,
      snapshot.captured_at, snapshot.tracking_source,
      project.active_entity_extractor_version,
      project.entity_extraction_enabled, project.entity_auto_track_enabled
     FROM entity_extraction_jobs job
     JOIN tracked_queries query ON query.id = job.tracked_query_id
     JOIN projects project ON project.id = job.project_id
     JOIN snapshot_index snapshot ON snapshot.id = job.snapshot_id
     WHERE job.id = ? AND query.deleted_at IS NULL AND project.deleted_at IS NULL`,
  ).bind(jobId).first<EntityJobRow>();
  if (!job || job.status === "completed" || job.status === "cancelled") return;
  if (job.extractor_version !== ENTITY_EXTRACTOR_VERSION) {
    throw new Error(`Unsupported entity extractor version: ${job.extractor_version}`);
  }
  if (job.entity_extraction_enabled !== 1) {
    await env.CONTROL_DB.prepare(
      `UPDATE entity_extraction_jobs SET status = 'cancelled',
        error_message = 'Project entity extraction is paused.', updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), job.id).run();
    return;
  }
  await env.CONTROL_DB.prepare(
    `UPDATE entity_extraction_jobs SET status = 'processing', attempts = attempts + 1,
      started_at = COALESCE(started_at, ?), error_message = NULL, updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), nowIso(), job.id).run();

  const shard = getShard(env, job.shard_id);
  const [snapshot, providerRows, domainRows, trackedRows] = await Promise.all([
    shard.prepare("SELECT answer_markdown FROM snapshots WHERE id = ?")
      .bind(job.snapshot_id).first<{ answer_markdown: string | null }>(),
    shard.prepare(
      `SELECT entity.title,
        COALESCE(GROUP_CONCAT(DISTINCT url.registrable_domain), '') AS domains_csv
       FROM snapshot_brand_entities entity
       LEFT JOIN brand_entity_urls url ON url.brand_entity_id = entity.id
       WHERE entity.snapshot_id = ?
       GROUP BY entity.id, entity.title`,
    ).bind(job.snapshot_id).all<{ title: string; domains_csv: string }>(),
    shard.prepare(
      "SELECT registrable_domain FROM snapshot_domains WHERE snapshot_id = ?",
    ).bind(job.snapshot_id).all<{ registrable_domain: string }>(),
    env.CONTROL_DB.prepare(
      `SELECT id, kind, name, aliases_json, domains_json
       FROM tracked_brands WHERE project_id = ?`,
    ).bind(job.project_id).all<TrackedBrandRow>(),
  ]);
  if (!snapshot) throw new Error("Snapshot not found for entity extraction");
  const answer = snapshot.answer_markdown ?? "";
  const providerEntities = providerRows.results.map((row) => ({
    title: row.title,
    domains: row.domains_csv.split(",").filter(Boolean),
  }));
  const observedDomains = domainRows.results.map((row) => row.registrable_domain);
  const chunks = chunkEntityText(answer);
  const validated: ValidatedEntity[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = await runChunk(
      env,
      job,
      chunk,
      index,
      trackedRows.results,
      providerEntities,
      observedDomains,
    );
    await env.CONTROL_DB.prepare(
      "UPDATE entity_extraction_jobs SET updated_at = ? WHERE id = ?",
    ).bind(nowIso(), job.id).run();
    validated.push(...validateExtractedEntities(
      { entities: result.entities.map((entity) => ({
        surface: entity.surface,
        entity_type: entity.entity_type,
      })) },
      chunk,
      { providerEntities, observedDomains, trackedBrands: trackedRows.results },
    ).map((entity) => {
      const stored = result.entities.find(
        (candidate) => normalizeBrand(candidate.surface) === normalizeBrand(entity.surface),
      );
      return stored ? {
        ...entity,
        relationship: stored.relationship,
        relationship_reason: stored.relationship_reason,
        evidence_tier: stored.evidence_tier,
        domains: stored.domains,
        sources: stored.sources,
      } : entity;
    }));
  }
  await persistEntities(env, job, brandMentionText(answer), validated);
  const totals = await env.CONTROL_DB.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
     FROM entity_extraction_chunks WHERE job_id = ? AND status = 'completed'`,
  ).bind(job.id).first<{
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>();
  const autoTracked = await autoTrackEligibleCompetitors(env, job);
  // A live extraction is still part of the capture pipeline, so include newly
  // auto-tracked competitors in that capture. Historical extraction backfills
  // must not rewrite an isolated old date with today's tracking configuration.
  if (autoTracked > 0 && job.run_type === "live") {
    const [currentBrands, project] = await Promise.all([
      env.CONTROL_DB.prepare(
        `SELECT id, kind, name, aliases_json, domains_json
         FROM tracked_brands WHERE project_id = ?`,
      ).bind(job.project_id).all<TrackedBrandRow>(),
      env.CONTROL_DB.prepare(
        "SELECT brand_metrics_revision FROM projects WHERE id = ?",
      ).bind(job.project_id).first<{ brand_metrics_revision: number }>(),
    ]);
    await syncSnapshotBrandMetrics(env.CONTROL_DB, {
      snapshotId: job.snapshot_id,
      projectId: job.project_id,
      trackingSource: job.tracking_source,
      metricDate: job.captured_at.slice(0, 10),
      answer,
      revision: Number(project?.brand_metrics_revision ?? 1),
      brands: currentBrands.results.map((brand) => ({
        id: brand.id,
        kind: brand.kind,
        name: brand.name,
        aliases: jsonParse<string[]>(brand.aliases_json, []),
      })),
    });
  }
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE entity_extraction_jobs SET status = 'completed', input_tokens = ?,
        output_tokens = ?, estimated_cost_usd = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      Number(totals?.input_tokens ?? 0),
      Number(totals?.output_tokens ?? 0),
      Number(totals?.estimated_cost_usd ?? 0),
      nowIso(),
      nowIso(),
      job.id,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE snapshot_index SET detected_entities_count = (
        SELECT COUNT(*) FROM entity_mentions
        WHERE snapshot_id = ? AND extractor_version = ?
      ) WHERE id = ? AND ? = (
        SELECT active_entity_extractor_version FROM projects
        WHERE id = snapshot_index.project_id
      )`,
    ).bind(
      job.snapshot_id,
      job.extractor_version,
      job.snapshot_id,
      job.extractor_version,
    ),
  ]);
  console.log(JSON.stringify({
    level: "info",
    message: "entity_extraction_completed",
    jobId: job.id,
    extractorVersion: job.extractor_version,
    runType: job.run_type,
    chunks: chunks.length,
    entities: validated.length,
    autoTracked,
    estimatedCostUsd: Number(totals?.estimated_cost_usd ?? 0),
  }));
}

export async function enqueueEntityExtractionForSnapshot(
  env: Env,
  snapshot: {
    id: string;
    workspaceId: string;
    projectId: string;
    trackedQueryId: string;
    shardId: number;
  },
  runType: "live" | "backfill" = "live",
): Promise<string | null> {
  const project = await env.CONTROL_DB.prepare(
    `SELECT entity_extraction_enabled FROM projects
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
  ).bind(snapshot.projectId, snapshot.workspaceId).first<{ entity_extraction_enabled: number }>();
  if (project?.entity_extraction_enabled !== 1) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO entity_extraction_jobs (
      id, snapshot_id, workspace_id, project_id, tracked_query_id, shard_id,
      status, model, extractor_version, run_type, input_price_per_million_usd,
      output_price_per_million_usd, pricing_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    snapshot.id,
    snapshot.workspaceId,
    snapshot.projectId,
    snapshot.trackedQueryId,
    snapshot.shardId,
    ENTITY_EXTRACTION_MODEL,
    ENTITY_EXTRACTOR_VERSION,
    runType,
    ENTITY_INPUT_PRICE_PER_MILLION_USD,
    ENTITY_OUTPUT_PRICE_PER_MILLION_USD,
    ENTITY_PRICING_VERSION,
    now,
    now,
  ).run();
  if (inserted.meta.changes === 0) return null;
  try {
    await env.ENTITY_EXTRACTION_QUEUE.send(
      { jobId: id } satisfies EntityExtractionQueueMessage,
      { contentType: "json" },
    );
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "entity_extraction_enqueue_failed",
      jobId: id,
      extractorVersion: ENTITY_EXTRACTOR_VERSION,
      error: String(error),
    }));
  }
  return id;
}

export async function reconcileEntityExtractionJobs(env: Env): Promise<number> {
  const missing = await env.CONTROL_DB.prepare(
    `SELECT snapshot.id, snapshot.workspace_id, snapshot.project_id,
      snapshot.tracked_query_id, snapshot.shard_id
     FROM snapshot_index snapshot
     JOIN projects project ON project.id = snapshot.project_id
     JOIN tracked_queries query ON query.id = snapshot.tracked_query_id
     LEFT JOIN entity_extraction_jobs job
       ON job.snapshot_id = snapshot.id AND job.extractor_version = ?
     WHERE job.id IS NULL AND project.entity_extraction_enabled = 1
       AND project.deleted_at IS NULL AND query.deleted_at IS NULL
     ORDER BY snapshot.captured_at DESC LIMIT 100`,
  ).bind(ENTITY_EXTRACTOR_VERSION).all<{
    id: string;
    workspace_id: string;
    project_id: string;
    tracked_query_id: string;
    shard_id: number;
  }>();
  let enqueued = 0;
  for (const snapshot of missing.results) {
    const id = await enqueueEntityExtractionForSnapshot(env, {
      id: snapshot.id,
      workspaceId: snapshot.workspace_id,
      projectId: snapshot.project_id,
      trackedQueryId: snapshot.tracked_query_id,
      shardId: snapshot.shard_id,
    }, "backfill");
    if (id) enqueued += 1;
  }

  const stale = await env.CONTROL_DB.prepare(
    `SELECT job.id FROM entity_extraction_jobs job
     JOIN projects project ON project.id = job.project_id
     WHERE project.entity_extraction_enabled = 1 AND project.deleted_at IS NULL
       AND job.extractor_version = ? AND job.attempts < 5 AND (
       (job.status = 'queued' AND julianday(job.updated_at) < julianday('now', '-2 minutes')) OR
       (job.status = 'processing' AND julianday(job.updated_at) < julianday('now', '-20 minutes')) OR
       (job.status = 'failed' AND julianday(job.updated_at) < julianday('now', '-5 minutes')) OR
       (job.status = 'cancelled' AND job.error_message = 'Project entity extraction is paused.')
     ) ORDER BY job.updated_at LIMIT 100`,
  ).bind(ENTITY_EXTRACTOR_VERSION).all<{ id: string }>();
  if (stale.results.length) {
    await env.CONTROL_DB.batch(stale.results.map((row) =>
      env.CONTROL_DB.prepare(
        "UPDATE entity_extraction_jobs SET status = 'queued', updated_at = ? WHERE id = ?",
      ).bind(nowIso(), row.id),
    ));
    await env.ENTITY_EXTRACTION_QUEUE.sendBatch(stale.results.map((row) => ({
      body: { jobId: row.id } satisfies EntityExtractionQueueMessage,
      options: { contentType: "json" as const },
    })));
    enqueued += stale.results.length;
  }
  await activateCompletedEntityBackfills(env);
  return enqueued;
}

async function activateCompletedEntityBackfills(env: Env): Promise<number> {
  const ready = await env.CONTROL_DB.prepare(
    `SELECT project.id, project.workspace_id, project.entity_auto_track_enabled
     FROM projects project
     WHERE project.active_entity_extractor_version != ?
       AND project.entity_extraction_enabled = 1
       AND project.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_index snapshot
         JOIN tracked_queries query ON query.id = snapshot.tracked_query_id
         LEFT JOIN entity_extraction_jobs job
           ON job.snapshot_id = snapshot.id AND job.extractor_version = ?
         WHERE snapshot.project_id = project.id
           AND query.deleted_at IS NULL
           AND (job.id IS NULL OR job.status != 'completed')
       )
     ORDER BY project.created_at LIMIT 25`,
  ).bind(ENTITY_EXTRACTOR_VERSION, ENTITY_EXTRACTOR_VERSION).all<{
    id: string;
    workspace_id: string;
    entity_auto_track_enabled: number;
  }>();

  for (const project of ready.results) {
    const now = nowIso();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE projects SET active_entity_extractor_version = ?, updated_at = ?
         WHERE id = ? AND active_entity_extractor_version != ?`,
      ).bind(
        ENTITY_EXTRACTOR_VERSION,
        now,
        project.id,
        ENTITY_EXTRACTOR_VERSION,
      ),
      env.CONTROL_DB.prepare(
        `UPDATE snapshot_index SET detected_entities_count = (
           SELECT COUNT(*) FROM entity_mentions mention
           WHERE mention.snapshot_id = snapshot_index.id
             AND mention.extractor_version = ?
         ) WHERE project_id = ?`,
      ).bind(ENTITY_EXTRACTOR_VERSION, project.id),
      env.CONTROL_DB.prepare(
        `UPDATE project_entities SET
           snapshot_count = (
             SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = project_entities.id
               AND mention.extractor_version = ?
           ),
           prompt_count = (
             SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
             WHERE mention.entity_id = project_entities.id
               AND mention.extractor_version = ?
           ),
           competitor_snapshot_count = (
             SELECT COUNT(DISTINCT mention.snapshot_id) FROM entity_mentions mention
             WHERE mention.entity_id = project_entities.id
               AND mention.relationship = 'competitor'
               AND mention.extractor_version = ?
           ),
           competitor_prompt_count = (
             SELECT COUNT(DISTINCT mention.tracked_query_id) FROM entity_mentions mention
             WHERE mention.entity_id = project_entities.id
               AND mention.relationship = 'competitor'
               AND mention.extractor_version = ?
           ),
           relationship = CASE
             WHEN tracked_brand_id IS NOT NULL THEN relationship
             WHEN EXISTS (
               SELECT 1 FROM entity_mentions mention
               WHERE mention.entity_id = project_entities.id
                 AND mention.extractor_version = ?
                 AND mention.relationship = 'competitor'
             ) THEN 'competitor'
             WHEN EXISTS (
               SELECT 1 FROM entity_mentions mention
               WHERE mention.entity_id = project_entities.id
                 AND mention.extractor_version = ?
                 AND mention.relationship = 'mentioned'
             ) THEN 'mentioned'
             ELSE 'unknown'
           END,
           updated_at = ?
         WHERE project_id = ?`,
      ).bind(
        ENTITY_EXTRACTOR_VERSION,
        ENTITY_EXTRACTOR_VERSION,
        ENTITY_EXTRACTOR_VERSION,
        ENTITY_EXTRACTOR_VERSION,
        ENTITY_EXTRACTOR_VERSION,
        ENTITY_EXTRACTOR_VERSION,
        now,
        project.id,
      ),
    ]);
    await autoTrackEligibleCompetitors(env, {
      project_id: project.id,
      workspace_id: project.workspace_id,
      extractor_version: ENTITY_EXTRACTOR_VERSION,
      active_entity_extractor_version: ENTITY_EXTRACTOR_VERSION,
      entity_auto_track_enabled: project.entity_auto_track_enabled,
    });
    console.log(JSON.stringify({
      level: "info",
      message: "entity_extractor_version_activated",
      projectId: project.id,
      extractorVersion: ENTITY_EXTRACTOR_VERSION,
    }));
  }
  return ready.results.length;
}

export async function entityExtractionBatch(
  env: Env,
  batch: MessageBatch<EntityExtractionQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processEntityExtraction(env, message.body.jobId);
      message.ack();
    } catch (error) {
      const errorMessage = String(error).slice(0, 1_000);
      await env.CONTROL_DB.prepare(
        `UPDATE entity_extraction_jobs SET status = 'failed', error_message = ?, updated_at = ?
         WHERE id = ? AND status != 'completed'`,
      ).bind(errorMessage, nowIso(), message.body.jobId).run();
      console.error(JSON.stringify({
        level: "error",
        message: "entity_extraction_failed",
        jobId: message.body.jobId,
        extractorVersion: ENTITY_EXTRACTOR_VERSION,
        error: errorMessage,
      }));
      if (
        error instanceof ApiError &&
        ["usage_limit", "payment_required", "read_only"].includes(error.code)
      ) {
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(1_800, 30 * 2 ** message.attempts) });
      }
    }
  }
}
