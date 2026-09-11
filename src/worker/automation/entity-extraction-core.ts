import { z } from "zod";
import {
  brandMentionSpans,
  brandMentionText,
  containsBrandMention,
  normalizeBrand,
  normalizeUrl,
  stripMarkdownEntityDecoration,
} from "../lib/domain";
import { jsonParse } from "../lib/http";

export const ENTITY_EXTRACTION_MODEL =
  "@cf/qwen/qwen3-30b-a3b-fp8" as const;
export const ENTITY_AUTO_TRACK_CONFIRMATION_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
export const ENTITY_EXTRACTOR_VERSION = "entities-v2";
export const ENTITY_SPAN_PROMPT_VERSION = "entity-span-v3-qwen-2026-08-31";
export const ENTITY_RELATIONSHIP_PROMPT_VERSION =
  "entity-relationship-v3-qwen-2026-08-31";
export const ENTITY_AUTO_TRACK_PROMPT_VERSION =
  "entity-auto-track-confirmation-v1-2026-08-31";
export const LEGACY_ENTITY_EXTRACTOR_VERSION = "entities-v1";
export const ENTITY_INPUT_PRICE_PER_MILLION_USD = 0.051;
export const ENTITY_OUTPUT_PRICE_PER_MILLION_USD = 0.335;
export const ENTITY_PRICING_VERSION = "2026-08-28";

const MAX_CHUNK_CHARACTERS = 12_000;
const DEFAULT_CHUNK_OVERLAP = 240;
const MAX_ENTITY_NAME_CHARACTERS = 120;

export const EntityTypeSchema = z.enum([
  "brand",
  "company",
  "organization",
  "product",
  "person",
  "place",
  "other",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const EntityRelationshipSchema = z.enum([
  "owned",
  "competitor",
  "mentioned",
  "unknown",
]);
export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>;

export const EvidenceTierSchema = z.enum(["strong", "moderate", "weak"]);
export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

export const RelationshipReasonSchema = z.enum([
  "owned_brand",
  "tracked_competitor",
  "explicit_comparison",
  "alternative_or_substitute",
  "explicit_rival",
  "same_recommendation_set",
  "incidental_mention",
  "insufficient_context",
  "legacy_classifier",
]);
export type RelationshipReason = z.infer<typeof RelationshipReasonSchema>;

export const SpanEntitySchema = z.object({
  surface: z.string().trim().min(2).max(160),
  entity_type: EntityTypeSchema,
});
export type SpanEntity = z.infer<typeof SpanEntitySchema>;

export const SpanExtractionResponseSchema = z.object({
  entities: z.array(SpanEntitySchema).max(100).default([]),
});

const SpanExtractionEnvelopeSchema = z.object({
  entities: z.array(z.unknown()).default([]),
});

export const SPAN_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          surface: { type: "string" },
          entity_type: {
            type: "string",
            enum: ["brand", "company", "organization", "product", "person", "place", "other"],
          },
        },
        required: ["surface", "entity_type"],
      },
    },
  },
  required: ["entities"],
} as const;

export const RelationshipAssessmentSchema = z.object({
  surface: z.string().trim().min(2).max(160),
  relationship: z.enum(["competitor", "mentioned", "unknown"]),
  reason: z.enum([
    "explicit_comparison",
    "alternative_or_substitute",
    "explicit_rival",
    "same_recommendation_set",
    "incidental_mention",
    "insufficient_context",
  ]),
});
export type RelationshipAssessment = z.infer<typeof RelationshipAssessmentSchema>;

export const RelationshipResponseSchema = z.object({
  assessments: z.array(RelationshipAssessmentSchema).max(100).default([]),
});

const RelationshipEnvelopeSchema = z.object({
  assessments: z.array(z.unknown()).default([]),
});

export const RELATIONSHIP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assessments: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          surface: { type: "string" },
          relationship: {
            type: "string",
            enum: ["competitor", "mentioned", "unknown"],
          },
          reason: {
            type: "string",
            enum: [
              "explicit_comparison",
              "alternative_or_substitute",
              "explicit_rival",
              "same_recommendation_set",
              "incidental_mention",
              "insufficient_context",
            ],
          },
        },
        required: ["surface", "relationship", "reason"],
      },
    },
  },
  required: ["assessments"],
} as const;

export const ExtractedEntitySchema = z.object({
  surface: z.string().trim().min(2).max(160),
  canonical_name: z.string().trim().min(2).max(MAX_ENTITY_NAME_CHARACTERS),
  entity_type: EntityTypeSchema,
  relationship: EntityRelationshipSchema,
  relationship_reason: RelationshipReasonSchema,
  evidence_tier: EvidenceTierSchema,
  domains: z.array(z.string().trim().min(1).max(253)).max(10).default([]),
  sources: z.array(z.enum([
    "workers_ai",
    "dataforseo_entity",
    "observed_domain",
    "tracked_brand",
  ])).max(4).default([]),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractionResponseSchema = z.object({
  entities: z.array(ExtractedEntitySchema).max(100).default([]),
});

export interface TrackedBrandRow {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases_json: string;
  domains_json: string;
}

export interface ProviderEntityRow {
  title: string;
  domains: string[];
}

export interface ValidatedEntity extends ExtractedEntity {
  normalizedName: string;
  evidence: string;
  providerCorroborated: boolean;
  domainCorroborated: boolean;
  trackedBrand: TrackedBrandRow | null;
}

function roundCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export function estimatedEntityExtractionCost(
  inputTokens: number,
  outputTokens: number,
): number {
  return roundCost(
    (inputTokens / 1_000_000) * ENTITY_INPUT_PRICE_PER_MILLION_USD +
      (outputTokens / 1_000_000) * ENTITY_OUTPUT_PRICE_PER_MILLION_USD,
  );
}

function bestChunkBoundary(text: string, start: number, maximum: number): number {
  const hardEnd = Math.min(text.length, start + maximum);
  if (hardEnd === text.length) return hardEnd;
  const candidate = text.slice(start, hardEnd);
  const minimum = Math.floor(maximum * 0.7);
  const sentenceMatches = [...candidate.matchAll(/[.!?](?:\s+|$)|\n+/gu)];
  const sentenceBoundary = sentenceMatches
    .map((match) => (match.index ?? 0) + match[0].length)
    .filter((index) => index >= minimum)
    .at(-1);
  if (sentenceBoundary) return start + sentenceBoundary;
  const whitespace = candidate.lastIndexOf(" ");
  return whitespace >= minimum ? start + whitespace : hardEnd;
}

export function chunkEntityText(
  rawText: string,
  maximum = MAX_CHUNK_CHARACTERS,
  overlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const text = brandMentionText(rawText).trim();
  if (!text) return [];
  if (text.length <= maximum) return [text];
  const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(maximum * 0.2));
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = bestChunkBoundary(text, start, maximum);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const nextStart = Math.max(start + 1, end - safeOverlap);
    const whitespace = text.indexOf(" ", nextStart);
    start = whitespace >= 0 && whitespace < end ? whitespace + 1 : nextStart;
  }
  return chunks;
}

function exactSurface(text: string, term: string): string | null {
  return brandMentionSpans(text, term)[0]?.surface ?? null;
}

function contextForSurface(text: string, surface: string): string {
  const index = text.toLocaleLowerCase().indexOf(surface.toLocaleLowerCase());
  if (index < 0) return surface;
  const start = Math.max(0, index - 180);
  const end = Math.min(text.length, index + surface.length + 180);
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

export function countSurface(text: string, surface: string): number {
  return brandMentionSpans(text, surface).length;
}

function structuredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch (originalError) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "")
      .trim();
    const firstBrace = withoutFence.indexOf("{");
    const lastBrace = withoutFence.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) throw originalError;
    const repairedPrefix = withoutFence
      .slice(firstBrace, lastBrace + 1)
      .replace(/\}\s*\{/gu, "},{");
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (const character of repairedPrefix) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) throw originalError;
        stack.pop();
      }
    }
    if (quoted) throw originalError;
    const closing = stack.reverse().map((character) => character === "{" ? "}" : "]").join("");
    const objectText = `${repairedPrefix}${closing}`
      .replace(/,\s*([}\]])/gu, "$1");
    return JSON.parse(objectText);
  }
}

export function parsedSpanAiResponse(
  value: unknown,
): z.infer<typeof SpanExtractionResponseSchema> {
  const envelope = SpanExtractionEnvelopeSchema.parse(structuredJson(value));
  return {
    entities: envelope.entities.slice(0, 100).flatMap((entity) => {
      const parsed = SpanEntitySchema.safeParse(entity);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export function parsedRelationshipAiResponse(
  value: unknown,
): z.infer<typeof RelationshipResponseSchema> {
  const envelope = RelationshipEnvelopeSchema.parse(structuredJson(value));
  return {
    assessments: envelope.assessments.slice(0, 100).flatMap((assessment) => {
      const parsed = RelationshipAssessmentSchema.safeParse(assessment);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

function knownBrandForSurface(
  surface: string,
  brands: TrackedBrandRow[],
): TrackedBrandRow | null {
  const normalizedSurface = normalizeBrand(surface);
  return brands.find((brand) =>
    [brand.name, ...jsonParse<string[]>(brand.aliases_json, [])].some(
      (term) => normalizeBrand(term) === normalizedSurface,
    ),
  ) ?? null;
}

function providerForSurface(
  surface: string,
  providers: ProviderEntityRow[],
): ProviderEntityRow | null {
  const normalizedSurface = normalizeBrand(surface);
  return providers.find((provider) => normalizeBrand(provider.title) === normalizedSurface) ?? null;
}

function normalizedDomains(domains: string[]): string[] {
  return [...new Set(domains
    .map((domain) => normalizeUrl(domain).registrableDomain)
    .filter((domain): domain is string => Boolean(domain)))];
}

function candidate(
  span: SpanEntity,
  chunk: string,
  options: {
    observedDomains: Set<string>;
    providerEntities: ProviderEntityRow[];
    trackedBrands: TrackedBrandRow[];
    source: "workers_ai" | "dataforseo_entity" | "tracked_brand";
  },
): ValidatedEntity | null {
  const entitySurface = stripMarkdownEntityDecoration(span.surface);
  const visibleSurface = exactSurface(chunk, entitySurface);
  if (!visibleSurface || !containsBrandMention(chunk, visibleSurface)) return null;
  const trackedBrand = knownBrandForSurface(visibleSurface, options.trackedBrands);
  const provider = providerForSurface(visibleSurface, options.providerEntities);
  const canonicalName = trackedBrand?.name ?? provider?.title ?? visibleSurface;
  const normalizedName = normalizeBrand(canonicalName);
  if (!normalizedName) return null;
  const domains = normalizedDomains([
    ...jsonParse<string[]>(trackedBrand?.domains_json, []),
    ...(provider?.domains ?? []),
  ]);
  const domainCorroborated = domains.some((domain) => options.observedDomains.has(domain));
  const sources = new Set<ExtractedEntity["sources"][number]>([options.source]);
  if (trackedBrand) sources.add("tracked_brand");
  if (provider) sources.add("dataforseo_entity");
  if (domainCorroborated) sources.add("observed_domain");
  return {
    surface: visibleSurface,
    canonical_name: canonicalName,
    entity_type: trackedBrand ? "brand" : span.entity_type,
    relationship: trackedBrand?.kind ?? "unknown",
    relationship_reason: trackedBrand?.kind === "owned"
      ? "owned_brand"
      : trackedBrand
        ? "tracked_competitor"
        : "insufficient_context",
    evidence_tier: trackedBrand ? "strong" : provider ? "moderate" : "weak",
    domains,
    sources: [...sources],
    normalizedName,
    evidence: contextForSurface(chunk, visibleSurface),
    providerCorroborated: Boolean(provider),
    domainCorroborated,
    trackedBrand,
  };
}

export function validateExtractedEntities(
  raw: unknown,
  chunk: string,
  options: {
    providerNames?: string[];
    providerEntities?: ProviderEntityRow[];
    observedDomains?: string[];
    trackedBrands?: TrackedBrandRow[];
  } = {},
): ValidatedEntity[] {
  const parsed = SpanExtractionResponseSchema.parse(raw);
  const trackedBrands = options.trackedBrands ?? [];
  const providerEntities = options.providerEntities ?? (options.providerNames ?? []).map(
    (title) => ({ title, domains: [] }),
  );
  const observedDomains = new Set(normalizedDomains(options.observedDomains ?? []));
  const spans = new Map<string, { span: SpanEntity; source: "workers_ai" | "dataforseo_entity" | "tracked_brand" }>();

  for (const span of parsed.entities) {
    const surface = stripMarkdownEntityDecoration(span.surface);
    if (!surface || !containsBrandMention(chunk, surface)) continue;
    spans.set(normalizeBrand(surface), {
      span: { ...span, surface },
      source: "workers_ai",
    });
  }
  for (const provider of providerEntities) {
    const surface = exactSurface(chunk, provider.title);
    if (!surface) continue;
    const key = normalizeBrand(surface);
    const existing = spans.get(key);
    spans.set(key, {
      span: existing?.span ?? { surface, entity_type: "brand" },
      source: existing?.source ?? "dataforseo_entity",
    });
  }
  for (const brand of trackedBrands) {
    const terms = [brand.name, ...jsonParse<string[]>(brand.aliases_json, [])]
      .sort((left, right) => right.length - left.length);
    const surface = terms.map((term) => exactSurface(chunk, term)).find(Boolean);
    if (!surface) continue;
    spans.set(normalizeBrand(surface), {
      span: { surface, entity_type: "brand" },
      source: "tracked_brand",
    });
  }

  return [...spans.values()].flatMap(({ span, source }) => {
    const validated = candidate(span, chunk, {
      observedDomains,
      providerEntities,
      trackedBrands,
      source,
    });
    return validated ? [validated] : [];
  });
}

function evidenceTierForAssessment(
  entity: ValidatedEntity,
  assessment: RelationshipAssessment,
): EvidenceTier {
  if ([
    "explicit_comparison",
    "alternative_or_substitute",
    "explicit_rival",
  ].includes(assessment.reason)) return "strong";
  if (
    assessment.reason === "same_recommendation_set" &&
    (entity.providerCorroborated || entity.domainCorroborated)
  ) return "moderate";
  return entity.evidence_tier;
}

export function applyRelationshipAssessments(
  entities: ValidatedEntity[],
  raw: unknown,
): ValidatedEntity[] {
  const assessments = RelationshipResponseSchema.parse(raw).assessments;
  const bySurface = new Map(
    assessments.map((assessment) => [
      normalizeBrand(stripMarkdownEntityDecoration(assessment.surface)),
      assessment,
    ]),
  );
  return entities.map((entity) => {
    if (entity.trackedBrand) return entity;
    const assessment = bySurface.get(normalizeBrand(entity.surface));
    if (!assessment) return entity;
    return {
      ...entity,
      relationship: assessment.relationship,
      relationship_reason: assessment.reason,
      evidence_tier: evidenceTierForAssessment(entity, assessment),
    };
  });
}

export function extractionSystemPrompt(): string {
  return [
    "Extract only named-entity spans explicitly present in the supplied AI answer chunk.",
    "Return the exact visible substring and one type: brand, company, organization, product, person, place, or other.",
    "Include commercial brands and products even when capitalization is unusual.",
    "Do not canonicalize names, infer domains, classify relationships, or assign confidence.",
    "Publishers, research bodies, people, and places are still entities, but generic category phrases are not.",
    "Never invent a span. Return an empty entities array when no named entity is explicit.",
  ].join(" ");
}

export function relationshipSystemPrompt(): string {
  return [
    "Classify the supplied brand, company, and organization candidates using only the tracked query and answer evidence.",
    "competitor means an explicit comparison, rival, alternative, substitute, or a provider in the same recommendation set as the owned brand.",
    "A source, publisher, regulator, research organization, customer, integration partner, or incidental citation is mentioned, not a competitor.",
    "Use unknown when the evidence is insufficient. Return exactly one assessment for every candidate surface.",
  ].join(" ");
}

export function autoTrackConfirmationSystemPrompt(): string {
  return [
    "Act as a high-precision final reviewer for automatic competitor tracking.",
    "Use all supplied query/evidence observations, but classify the single candidate as competitor only when it is clearly a commercial alternative, substitute, rival, or member of the same recommendation set as the owned brand.",
    "Publishers, sources, regulators, research bodies, customers, integrations, generic categories, and incidental citations are not competitors.",
    "When evidence is mixed or insufficient, return unknown. Return exactly one assessment for the candidate surface.",
  ].join(" ");
}

export function entityModelSystemPrompt(model: string, prompt: string): string {
  return model.includes("/qwen/qwen3") ? `${prompt} /no_think` : prompt;
}

export function entityModelSampling(model: string): Record<string, number> {
  return model.includes("/qwen/qwen3")
    ? { temperature: 0.2, top_p: 0.8, top_k: 20 }
    : { temperature: 0 };
}
