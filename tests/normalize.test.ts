import { describe, expect, it } from "vitest";
import { parseAdvancedPayload } from "../src/worker/ingestion/dataforseo-schema";

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
