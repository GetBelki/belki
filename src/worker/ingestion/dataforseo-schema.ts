import { z } from "zod";
import type { TrackingSource } from "../../shared/contracts";

const SourceSchema = z
  .object({
    title: z.string().nullable().optional(),
    snippet: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    thumbnail: z.string().nullable().optional(),
    publication_date: z.string().nullable().optional(),
    markdown: z.string().nullable().optional(),
  })
  .passthrough();

const SearchResultSchema = z
  .object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    breadcrumb: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

const BrandEntityUrlSchema = z
  .object({
    url: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
  })
  .passthrough();

const BrandEntitySchema = z
  .object({
    title: z.string(),
    category: z.string().nullable().optional(),
    markdown: z.string().nullable().optional(),
    urls: z
      .array(BrandEntityUrlSchema)
      .nullish()
      .transform((urls) => urls ?? []),
  })
  .passthrough();

const AdvertiserSchema = z
  .object({
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    favicon_url: z.string().nullable().optional(),
  })
  .passthrough();

const ItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    is_rendered: z.boolean().nullable().optional(),
    markdown: z.string().nullable().optional(),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
    title: z.string().nullable().optional(),
    snippet: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    advertiser: AdvertiserSchema.nullable().optional(),
  })
  .passthrough();

const AdvancedResultSchema = z
  .object({
    keyword: z.string(),
    location_code: z.number(),
    language_code: z.string(),
    model: z.string().nullable().optional(),
    check_url: z.string().nullable().optional(),
    datetime: z.string().nullable().optional(),
    markdown: z.string().nullable().optional(),
    search_results: z.array(SearchResultSchema).default([]),
    sources: z.array(SourceSchema).default([]),
    fan_out_queries: z.array(z.unknown()).default([]),
    brand_entities: z
      .array(BrandEntitySchema)
      .nullish()
      .transform((entities) => entities ?? []),
    se_results_count: z.number().nullable().optional(),
    item_types: z.array(z.string()).default([]),
    items_count: z.number().nullable().optional(),
    items: z.array(ItemSchema).default([]),
    surface_present: z.boolean().default(true),
  })
  .passthrough();

const AdvancedPayloadSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          id: z.string().optional(),
          status_code: z.number().optional(),
          status_message: z.string().optional(),
          cost: z.number().nullable().optional(),
          result: z.array(AdvancedResultSchema).nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function parseAdvancedPayload(payload: unknown) {
  return AdvancedPayloadSchema.parse(payload);
}

type AdvancedPayload = z.infer<typeof AdvancedPayloadSchema>;
type AdvancedResult = z.infer<typeof AdvancedResultSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function walk(value: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const item = record(value);
  if (!item) return;
  visit(item);
  for (const child of Object.values(item)) walk(child, visit);
}

function normalizeTopLevelItems(items: unknown[]): Array<Record<string, unknown>> {
  return items.flatMap((value) => {
    const item = record(value);
    if (!item || typeof item.type !== "string") return [];

    // Google SERP surfaces can mix text fragments and structured objects in a
    // top-level item's `items` array. Belki only persists structured children;
    // the recursive extractor above still reads every nested value from the raw
    // provider payload, which remains available in R2 for future replay.
    const nestedItems = Array.isArray(item.items)
      ? item.items.filter((child): child is Record<string, unknown> => record(child) !== null)
      : undefined;
    const normalized = { ...item };
    if (nestedItems) normalized.items = nestedItems;
    else delete normalized.items;
    return [normalized];
  });
}

function normalizeSerpResult(
  rawResult: Record<string, unknown>,
  source: "google_ai_mode" | "google_ai_overview",
): AdvancedResult {
  const rawItems = Array.isArray(rawResult.items) ? rawResult.items : [];
  const overview = rawItems
    .map(record)
    .find((item) => item?.type === "ai_overview") ?? null;
  const surfacePresent = overview !== null;
  const answerParts: string[] = [];
  const sources: Array<Record<string, unknown>> = [];
  const searchResults: Array<Record<string, unknown>> = [];
  const seenSources = new Set<string>();

  if (overview) {
    const rootMarkdown = text(overview.markdown);
    if (rootMarkdown) answerParts.push(rootMarkdown);
    walk(overview.items, (item) => {
      const kind = text(item.type) ?? "";
      const markdown = text(item.markdown) ?? text(item.text);
      if (markdown && !answerParts.includes(markdown)) answerParts.push(markdown);
      const url = text(item.url);
      const domain = text(item.domain);
      if (!url && !domain) return;
      if (!kind.includes("reference") && !kind.includes("link")) return;
      const key = url ?? domain ?? "";
      if (seenSources.has(key)) return;
      seenSources.add(key);
      sources.push({
        title: text(item.title) ?? text(item.source),
        snippet: text(item.text) ?? text(item.description),
        source_name: text(item.source),
        domain,
        url,
      });
    });
  }

  for (const rawItem of rawItems) {
    const item = record(rawItem);
    if (!item || item.type !== "organic") continue;
    searchResults.push({
      title: text(item.title),
      description: text(item.description) ?? text(item.snippet),
      breadcrumb: text(item.breadcrumb),
      domain: text(item.domain),
      url: text(item.url),
    });
  }

  return AdvancedResultSchema.parse({
    keyword: text(rawResult.keyword) ?? "",
    location_code: number(rawResult.location_code),
    language_code: text(rawResult.language_code) ?? "",
    model: source,
    check_url: text(rawResult.check_url),
    datetime: text(rawResult.datetime),
    markdown: surfacePresent ? answerParts.join("\n\n") || null : null,
    search_results: searchResults,
    sources,
    fan_out_queries: [],
    brand_entities: [],
    se_results_count: number(rawResult.se_results_count),
    item_types: Array.isArray(rawResult.item_types) ? rawResult.item_types : [],
    items_count: number(rawResult.items_count, rawItems.length),
    items: normalizeTopLevelItems(rawItems),
    surface_present: surfacePresent,
  });
}

/**
 * Converts every supported DataForSEO result into Belki's stable snapshot shape.
 * The original payload remains in R2, so this adapter can be replayed if a
 * provider adds fields or changes a nested SERP item.
 */
export function parseTrackingPayload(
  payload: unknown,
  source: TrackingSource,
): AdvancedPayload {
  if (source === "chatgpt" || source === "gemini") {
    return parseAdvancedPayload(payload);
  }
  const rawPayload = record(payload);
  const rawTasks = Array.isArray(rawPayload?.tasks) ? rawPayload.tasks : [];
  return AdvancedPayloadSchema.parse({
    ...rawPayload,
    tasks: rawTasks.map((rawTask) => {
      const task = record(rawTask) ?? {};
      const rawResults = Array.isArray(task.result) ? task.result : [];
      return {
        ...task,
        result: rawResults
          .map(record)
          .filter((result): result is Record<string, unknown> => result !== null)
          .map((result) => normalizeSerpResult(result, source)),
      };
    }),
  });
}
