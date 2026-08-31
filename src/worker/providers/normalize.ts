import type { CaptureProvider, TrackingSource } from "../../shared/contracts";
import {
  parseAdvancedPayload,
  parseTrackingPayload,
} from "../ingestion/dataforseo-schema";
import { validateOxylabsPayload } from "./oxylabs";

export interface CaptureNormalizationContext {
  taskId: string;
  query: string;
  locationCode: number;
  languageCode: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

function sourceRows(...values: unknown[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const itemValue of array(value)) {
      const item = record(itemValue);
      if (!item) continue;
      const url = text(item.url, item.link, item.href, item.source_url);
      const domain = text(item.domain);
      if (!url && !domain) continue;
      const key = url ?? domain ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        title: text(item.title, item.label, item.name),
        snippet: text(item.snippet, item.description, item.text),
        source_name: text(item.source_name, item.publisher, item.label),
        domain,
        url,
        thumbnail: text(item.thumbnail, item.image_url),
        publication_date: text(item.publication_date, item.date),
      });
    }
  }
  return rows;
}

function searchRows(...values: unknown[]): Array<Record<string, unknown>> {
  return values.flatMap((value) => array(value).flatMap((itemValue) => {
    const item = record(itemValue);
    if (!item) return [];
    const url = text(item.url, item.link, item.href);
    if (!url) return [];
    return [{
      title: text(item.title, item.name),
      description: text(item.description, item.snippet, item.text),
      breadcrumb: text(item.breadcrumb),
      domain: text(item.domain),
      url,
    }];
  }));
}

function fanOutRows(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value.map<unknown>((item: unknown) => item);
  }
  return null;
}

function canonicalPayload(
  provider: Exclude<CaptureProvider, "dataforseo">,
  payload: unknown,
  source: TrackingSource,
  context: CaptureNormalizationContext,
) {
  const rootArray = array(payload);
  const root = record(rootArray[0]) ?? record(payload) ?? {};
  const firstResult = record(array(root.results)[0]);
  const oxylabsContent = record(firstResult?.content);
  const cloroResult = record(root.result);
  const result = provider === "brightdata"
    ? root
    : provider === "oxylabs"
      ? oxylabsContent ?? firstResult ?? root
      : cloroResult ?? root;
  const overview = record(result.aiOverview) ?? record(result.ai_overview);
  const answer = text(
    overview?.markdown,
    overview?.text,
    result.markdown,
    result.markdown_text,
    result.answer_text_markdown,
    result.answer_text_raw,
    result.answer_text,
    result.response_text,
    result.text,
  );
  const sources = sourceRows(
    overview?.sources,
    overview?.citations,
    result.sources,
    result.citations,
    result.citation_pills,
    result.links,
    result.search_sources,
  );
  const searchResults = searchRows(
    result.organicResults,
    result.organic_results,
    result.search_results,
  );
  const fanOut = fanOutRows(
    result.searchQueries,
    result.search_queries,
    result.queryFanOut,
    result.query_fan_out,
    result.relatedSearches,
  );
  // The tracking surface (for example, `chatgpt`) is not a model identity.
  // Leave the model unknown when a capture provider does not report it.
  const model = text(result.model, result.llm_model);
  const datetime = text(
    root.prompt_sent_at,
    firstResult?.created_at,
    root.created_at,
  );
  const surfacePresent = source === "google_ai_overview"
    ? Boolean(overview || answer)
    : Boolean(answer);
  return parseAdvancedPayload({
    tasks: [{
      id: context.taskId,
      status_code: 20000,
      status_message: "Ok",
      cost: null,
      result: [{
        keyword: context.query,
        location_code: context.locationCode,
        language_code: context.languageCode,
        model,
        check_url: text(result.url, firstResult?.url),
        datetime,
        markdown: answer,
        search_results: searchResults,
        sources,
        fan_out_queries: fanOut,
        brand_entities: [],
        se_results_count: searchResults.length,
        item_types: [],
        items_count: 0,
        items: [],
        surface_present: surfacePresent,
      }],
    }],
  });
}

export function parseCapturePayload(
  provider: CaptureProvider,
  payload: unknown,
  source: TrackingSource,
  context: CaptureNormalizationContext,
) {
  if (provider === "oxylabs") validateOxylabsPayload(payload, source);
  return provider === "dataforseo"
    ? parseTrackingPayload(payload, source)
    : canonicalPayload(provider, payload, source, context);
}
