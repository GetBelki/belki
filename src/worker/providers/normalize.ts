import type { CaptureProvider, TrackingSource } from "../../shared/contracts";
import {
  parseAdvancedPayload,
  parseTrackingPayload,
} from "../ingestion/dataforseo-schema";
import { validateOlostepPayload } from "./olostep";
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
        title: text(item.title, item.label, item.name, item.text),
        snippet: text(item.snippet, item.description, item.text),
        source_name: text(item.source_name, item.publisher, item.label),
        domain,
        url,
        thumbnail: text(item.thumbnail, item.image_url),
        publication_date: text(item.publication_date, item.date_published, item.date),
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
      title: text(item.title, item.label, item.name),
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

// Olostep's documented ChatGPT commercial modules use brand/cards and vendors.
// Keep original fields alongside the canonical fields for evidence and replay.
function olostepItems(result: Record<string, unknown>) {
  const items: Array<Record<string, unknown> & { type: string }> = [];
  for (const value of array(result.ads)) {
    const ad = record(value);
    if (!ad) continue;
    const brand = record(ad.brand);
    for (const cardValue of array(ad.cards)) {
      const card = record(cardValue);
      if (!card) continue;
      items.push({
        ...card,
        type: "chat_gpt_ad",
        title: text(card.title),
        snippet: text(card.body, card.snippet),
        url: text(card.url),
        image_url: text(card.image, card.image_url),
        advertiser: { name: text(brand?.name), url: text(brand?.url) },
        is_rendered: true,
      });
    }
  }
  const products = array(result.products).flatMap((value) => {
    const product = record(value);
    if (!product) return [];
    const vendors = array(product.vendors).map(record).filter((value) => value !== null);
    return [{
      ...product,
      title: text(product.title),
      url: text(product.url, vendors[0]?.link),
      merchants: vendors.map((vendor) => text(vendor.website)).filter(Boolean).join(", ") || null,
    }];
  });
  if (products.length) items.push({ type: "chat_gpt_products", items: products });
  return items;
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
    result.answer_markdown,
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
    result.inline_references,
    provider === "olostep"
      ? array(result.sources).filter((value) => record(value)?.cited !== false)
      : result.sources,
    result.citations,
    result.citation_pills,
    result.links,
    result.search_sources,
  );
  const searchResults = searchRows(
    provider === "olostep"
      ? array(result.sources).filter((value) => record(value)?.cited === false)
      : [],
    result.organicResults,
    result.organic_results,
    result.search_results,
  );
  const fanOut = fanOutRows(
    record(result.network_search_calls)?.search_queries,
    result.search_model_queries,
    result.searchQueries,
    result.search_queries,
    result.queryFanOut,
    result.query_fan_out,
    result.relatedSearches,
  );
  // The tracking surface (for example, `chatgpt`) is not a model identity.
  // Leave the model unknown when a capture provider does not report it.
  const model = provider === "olostep"
    ? null // Parser surface names and ChatGPT "auto" are not model identities.
    : text(result.model, result.llm_model);
  const datetime = text(
    root.prompt_sent_at,
    firstResult?.created_at,
    root.created_at,
  );
  const items = provider === "olostep" ? olostepItems(result) : [];
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
        item_types: [...new Set(items.map((item) => item.type))],
        items_count: items.length,
        items,
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
  if (provider === "olostep") validateOlostepPayload(payload, source);
  if (provider === "oxylabs") validateOxylabsPayload(payload, source);
  return provider === "dataforseo"
    ? parseTrackingPayload(payload, source)
    : canonicalPayload(provider, payload, source, context);
}
