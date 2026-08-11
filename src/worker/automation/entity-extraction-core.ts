import { z } from "zod";
import {
  brandMentionText,
  containsBrandMention,
  normalizeBrand,
  normalizeUrl,
} from "../lib/domain";
import { jsonParse } from "../lib/http";

export const ENTITY_EXTRACTION_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
export const ENTITY_EXTRACTOR_VERSION = "entities-v1";
export const ENTITY_INPUT_PRICE_PER_MILLION_USD = 0.293;
export const ENTITY_OUTPUT_PRICE_PER_MILLION_USD = 2.253;
export const ENTITY_PRICING_VERSION = "2026-08-11";

const MAX_CHUNK_CHARACTERS = 12_000;
const MAX_ENTITY_NAME_CHARACTERS = 120;

export const ExtractedEntitySchema = z.object({
  surface: z.string().trim().min(2).max(160),
  canonical_name: z.string().trim().min(2).max(MAX_ENTITY_NAME_CHARACTERS),
  entity_type: z.enum([
    "brand",
    "company",
    "organization",
    "product",
    "person",
    "place",
    "other",
  ]),
  relationship: z.enum(["owned", "competitor", "mentioned", "unknown"]),
  confidence: z.number().min(0).max(1),
  domains: z.array(z.string().trim().min(1).max(253)).max(10).default([]),
});

export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractionResponseSchema = z.object({
  entities: z.array(ExtractedEntitySchema).max(100).default([]),
});

export const EXTRACTION_JSON_SCHEMA = {
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
          canonical_name: { type: "string" },
          entity_type: {
            type: "string",
            enum: ["brand", "company", "organization", "product", "person", "place", "other"],
          },
          relationship: {
            type: "string",
            enum: ["owned", "competitor", "mentioned", "unknown"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          domains: { type: "array", maxItems: 10, items: { type: "string" } },
        },
        required: [
          "surface",
          "canonical_name",
          "entity_type",
          "relationship",
          "confidence",
          "domains",
        ],
      },
    },
  },
  required: ["entities"],
} as const;

export interface TrackedBrandRow {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases_json: string;
  domains_json: string;
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

export function chunkEntityText(
  rawText: string,
  maximum = MAX_CHUNK_CHARACTERS,
): string[] {
  const text = brandMentionText(rawText).trim();
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maximum);
    if (end < text.length) {
      const candidate = text.slice(start, end);
      const newline = candidate.lastIndexOf("\n");
      const whitespace = candidate.lastIndexOf(" ");
      const boundary = Math.max(newline, whitespace);
      if (boundary >= Math.floor(maximum * 0.7)) end = start + boundary;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (/\s/u.test(text[start] ?? "")) start += 1;
  }
  return chunks;
}

function contextForSurface(text: string, surface: string): string {
  const index = text.toLocaleLowerCase().indexOf(surface.toLocaleLowerCase());
  if (index < 0) return surface;
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + surface.length + 120);
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

export function countSurface(text: string, surface: string): number {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedSurface = surface.toLocaleLowerCase();
  if (!normalizedSurface) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = normalizedText.indexOf(normalizedSurface, offset)) >= 0) {
    count += 1;
    offset += normalizedSurface.length;
  }
  return count;
}

export function parsedAiResponse(
  value: unknown,
): z.infer<typeof ExtractionResponseSchema> {
  if (typeof value === "string") {
    return ExtractionResponseSchema.parse(JSON.parse(value));
  }
  return ExtractionResponseSchema.parse(value);
}

function knownBrandForEntity(
  entity: ExtractedEntity,
  brands: TrackedBrandRow[],
): TrackedBrandRow | null {
  return brands.find((brand) =>
    [brand.name, ...jsonParse<string[]>(brand.aliases_json, [])].some(
      (term) =>
        normalizeBrand(term) === normalizeBrand(entity.canonical_name) ||
        normalizeBrand(term) === normalizeBrand(entity.surface),
    ),
  ) ?? null;
}

export function validateExtractedEntities(
  raw: unknown,
  chunk: string,
  options: {
    providerNames?: string[];
    observedDomains?: string[];
    trackedBrands?: TrackedBrandRow[];
  } = {},
): ValidatedEntity[] {
  const parsed = ExtractionResponseSchema.parse(raw);
  const providerNames = new Set(
    (options.providerNames ?? []).map(normalizeBrand).filter(Boolean),
  );
  const observedDomains = new Set(
    (options.observedDomains ?? [])
      .map((domain) => normalizeUrl(domain).registrableDomain)
      .filter((domain): domain is string => Boolean(domain)),
  );
  const trackedBrands = options.trackedBrands ?? [];
  return parsed.entities.flatMap((entity) => {
    if (!containsBrandMention(chunk, entity.surface)) return [];
    const trackedBrand = knownBrandForEntity(entity, trackedBrands);
    const canonicalName = trackedBrand?.name ?? entity.canonical_name;
    const normalizedName = normalizeBrand(canonicalName);
    if (!normalizedName) return [];
    const domains = entity.domains
      .map((domain) => normalizeUrl(domain).registrableDomain)
      .filter((domain): domain is string => Boolean(domain));
    const relationship = trackedBrand?.kind ?? entity.relationship;
    return [{
      ...entity,
      canonical_name: canonicalName,
      relationship,
      domains: [...new Set(domains)],
      normalizedName,
      evidence: contextForSurface(chunk, entity.surface),
      providerCorroborated:
        providerNames.has(normalizeBrand(entity.surface)) ||
        providerNames.has(normalizeBrand(entity.canonical_name)),
      domainCorroborated: domains.some((domain) => observedDomains.has(domain)),
      trackedBrand,
    }];
  });
}

export function extractionSystemPrompt(): string {
  return [
    "Extract named entities explicitly present in the supplied AI answer.",
    "Focus on brands, companies, organizations, products, people, and places across any industry.",
    "A competitor is a brand or company presented as an alternative, rival, substitute, comparison, or competing provider to the owned brand.",
    "Do not infer entities that are absent. surface must be an exact substring of the answer chunk.",
    "Use owned only for a supplied owned brand. Use competitor only when the answer context supports that relationship.",
    "Use mentioned when the entity is present but no competitive relationship is established.",
    "Return an empty entities array when no named entity is explicit.",
  ].join(" ");
}
