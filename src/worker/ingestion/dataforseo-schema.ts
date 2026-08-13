import { z } from "zod";

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
