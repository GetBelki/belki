import { describe, expect, it } from "vitest";
import {
  parseAdvancedPayload,
  parseTrackingPayload,
} from "../src/worker/ingestion/dataforseo-schema";

function payloadWithBrandEntities(brandEntities: unknown) {
  return {
    tasks: [
      {
        id: "provider-task-id",
        status_code: 20_000,
        status_message: "Ok.",
        result: [
          {
            keyword: "premium dog food",
            location_code: 2276,
            language_code: "de",
            brand_entities: brandEntities,
          },
        ],
      },
    ],
  };
}

describe("DataForSEO Advanced response parsing", () => {
  it("normalizes null brand entities to an empty array", () => {
    const payload = parseAdvancedPayload(payloadWithBrandEntities(null));

    expect(payload.tasks[0]!.result![0]!.brand_entities).toEqual([]);
  });

  it("normalizes null brand entity URLs to an empty array", () => {
    const payload = parseAdvancedPayload(
      payloadWithBrandEntities([
        {
          title: "Example Brand",
          category: "Pet food",
          markdown: "Example Brand",
          urls: null,
        },
      ]),
    );

    expect(payload.tasks[0]!.result![0]!.brand_entities[0]!.urls).toEqual([]);
  });
});

function serpPayload(items: unknown[]) {
  return {
    tasks: [{
      id: "provider-task-id",
      status_code: 20_000,
      status_message: "Ok.",
      result: [{
        keyword: "best dog food",
        location_code: 2_840,
        language_code: "en",
        check_url: "https://www.google.com/search?q=best+dog+food",
        datetime: "2026-08-17 10:00:00 +00:00",
        items,
        item_types: items
          .map((item) => {
            if (typeof item !== "object" || item === null) return "";
            const type = (item as Record<string, unknown>).type;
            return typeof type === "string" ? type : "";
          })
          .filter(Boolean),
        items_count: items.length,
      }],
    }],
  };
}

describe("multi-source response parsing", () => {
  it("keeps Gemini in the stable LLM response shape", () => {
    const payload = parseTrackingPayload({
      tasks: [{
        id: "gemini-task",
        status_code: 20_000,
        result: [{
          keyword: "best dog food",
          location_code: 2_840,
          language_code: "en",
          markdown: "Gemini answer",
          model: "gemini-2.5-pro",
          sources: [],
          search_results: [],
        }],
      }],
    }, "gemini");

    expect(payload.tasks[0]!.result![0]).toMatchObject({
      markdown: "Gemini answer",
      model: "gemini-2.5-pro",
      surface_present: true,
    });
  });

  it("normalizes Google AI Mode answers and nested references", () => {
    const payload = parseTrackingPayload(serpPayload([{
      type: "ai_overview",
      markdown: "AI Mode answer",
      items: [{
        type: "ai_overview_expanded_component",
        markdown: "Additional context",
        references: [{
          type: "ai_overview_reference",
          source: "Example",
          domain: "example.com",
          url: "https://example.com/source",
        }],
      }],
    }]), "google_ai_mode");

    expect(payload.tasks[0]!.result![0]).toMatchObject({
      model: "google_ai_mode",
      surface_present: true,
      markdown: "AI Mode answer\n\nAdditional context",
    });
    expect(payload.tasks[0]!.result![0]!.sources).toEqual([
      expect.objectContaining({
        source_name: "Example",
        domain: "example.com",
        url: "https://example.com/source",
      }),
    ]);
  });

  it("records a successful Google AI Overview absence without inventing an answer", () => {
    const payload = parseTrackingPayload(serpPayload([{
      type: "organic",
      title: "Example result",
      domain: "example.com",
      url: "https://example.com/result",
      description: "Organic result",
    }]), "google_ai_overview");

    expect(payload.tasks[0]!.result![0]).toMatchObject({
      model: "google_ai_overview",
      markdown: null,
      surface_present: false,
    });
    expect(payload.tasks[0]!.result![0]!.search_results).toEqual([
      expect.objectContaining({ title: "Example result", domain: "example.com" }),
    ]);
  });

  it("records a present Google AI Overview separately from organic results", () => {
    const payload = parseTrackingPayload(serpPayload([
      { type: "ai_overview", markdown: "Overview answer", items: [] },
      {
        type: "organic",
        title: "Organic result",
        domain: "example.org",
        url: "https://example.org/result",
      },
    ]), "google_ai_overview");

    expect(payload.tasks[0]!.result![0]).toMatchObject({
      markdown: "Overview answer",
      surface_present: true,
    });
    expect(payload.tasks[0]!.result![0]!.search_results).toHaveLength(1);
  });
});
