import { describe, expect, it } from "vitest";
import {
  aggregateBrandMentionDays,
  billingDateRange,
  buildBillingReport,
  buildBrandComparison,
  buildPromptSetEvents,
  mergeBillingReports,
  productAnalyticsDateRange,
  productIdentity,
  productIdentityFromKey,
  productKey,
  normalizeRelatedQuery,
  relatedQueryFromKey,
  relatedQueryKey,
  relatedQueryLabel,
  summarizeProductPrices,
} from "../src/worker/lib/reporting";
import {
  alignPromptSetEvents,
  clusterPromptSetEvents,
  hasOverviewProducts,
  promptSetEventDescription,
  promptSetEventLabel,
} from "../src/app/lib/overview";

const base = {
  provider_product_id: null,
  canonical_url: null,
  raw_url: null,
  title: " Camera  Pro ",
  merchants: "Example Shop",
  registrable_domain: "example.com",
};

describe("related query reporting", () => {
  it("extracts provider fan-out labels from supported payload shapes", () => {
    expect(relatedQueryLabel("  Best CRM  ")).toBe("Best CRM");
    expect(relatedQueryLabel({ query: "CRM for startups" })).toBe(
      "CRM for startups",
    );
    expect(relatedQueryLabel({ keyword: "CRM pricing" })).toBe("CRM pricing");
    expect(relatedQueryLabel({ unknown: "ignored" })).toBeNull();
  });

  it("normalizes Unicode, case, and whitespace for exact identity", () => {
    expect(normalizeRelatedQuery("  ＢＥＳＴ\n  CRM  ")).toBe("best crm");
  });

  it("round-trips Unicode identities through URL-safe keys", () => {
    const normalized = normalizeRelatedQuery("Beste CRM für Händler");
    const key = relatedQueryKey(normalized);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(relatedQueryFromKey(key)).toBe(normalized);
    expect(relatedQueryFromKey("not/a/key")).toBeNull();
  });
});

describe("shopping report product identity", () => {
  it("prefers the provider product id", () => {
    expect(
      productIdentity({
        ...base,
        provider_product_id: "sku-1",
        canonical_url: "https://example.com/other",
      }),
    ).toBe("id:sku-1");
  });

  it("uses the canonical URL before the raw URL", () => {
    expect(
      productIdentity({
        ...base,
        canonical_url: "https://example.com/canonical",
        raw_url: "https://example.com/raw",
      }),
    ).toBe("url:https://example.com/canonical");
  });

  it("normalizes title and merchant as the final fallback", () => {
    expect(productIdentity(base)).toBe(
      "fallback:camera pro|example shop",
    );
  });

  it("round-trips URL-safe product keys with Unicode fallback values", () => {
    const product = {
      ...base,
      title: "Katzen-Menü für Wählerische",
      merchants: "Händler & Söhne",
    };
    const key = productKey(product);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(productIdentityFromKey(key)).toBe(productIdentity(product));
  });

  it("rejects malformed product keys", () => {
    expect(productIdentityFromKey("not/a/key")).toBeNull();
  });
});

describe("product analytics reporting", () => {
  it.each([
    ["7d", "2026-07-23"],
    ["30d", "2026-06-30"],
    ["90d", "2026-05-01"],
    ["365d", "2025-07-30"],
  ] as const)("builds an inclusive %s range", (period, expectedFrom) => {
    expect(
      productAnalyticsDateRange(
        period,
        new Date("2026-07-29T18:00:00.000Z"),
      ),
    ).toEqual({
      from: expectedFrom,
      to: "2026-07-29",
      startTimestamp: `${expectedFrom}T00:00:00.000Z`,
      endExclusiveTimestamp: "2026-07-30T00:00:00.000Z",
    });
  });

  it("keeps price changes within the latest observed currency", () => {
    expect(
      summarizeProductPrices([
        {
          captured_at: "2026-07-29T10:00:00.000Z",
          price: 12,
          currency: "EUR",
        },
        {
          captured_at: "2026-07-28T10:00:00.000Z",
          price: 100,
          currency: "USD",
        },
        {
          captured_at: "2026-07-27T10:00:00.000Z",
          price: 10,
          currency: "EUR",
        },
      ]),
    ).toEqual({
      currency: "EUR",
      latest: 12,
      minimum: 10,
      maximum: 12,
      change: 2,
      changePercent: 20,
    });
  });

  it("does not invent a price change without an earlier comparable price", () => {
    expect(
      summarizeProductPrices([
        {
          captured_at: "2026-07-29T10:00:00.000Z",
          price: 12,
          currency: "EUR",
        },
      ]),
    ).toMatchObject({
      latest: 12,
      change: null,
      changePercent: null,
    });
  });
});

describe("billing reporting", () => {
  it("builds an inclusive rolling 30-day range", () => {
    const dates = billingDateRange("30d", new Date("2026-07-29T18:00:00.000Z"));
    expect(dates).toEqual({
      from: "2026-06-30",
      to: "2026-07-29",
      startTimestamp: "2026-06-30T00:00:00.000Z",
      endExclusiveTimestamp: "2026-07-30T00:00:00.000Z",
    });
  });

  it("starts the current-month range on the first day", () => {
    const dates = billingDateRange("month", new Date("2026-07-29T18:00:00.000Z"));
    expect(dates.from).toBe("2026-07-01");
    expect(dates.to).toBe("2026-07-29");
  });

  it("fills missing dates and summarizes charged provider tasks", () => {
    const report = buildBillingReport(
      [
        {
          metric_date: "2026-07-27",
          charged_runs: 2,
          provider_cost_usd: 0.0048,
        },
        {
          metric_date: "2026-07-29",
          charged_runs: 1,
          provider_cost_usd: 0.0024,
        },
      ],
      {
        from: "2026-07-27",
        to: "2026-07-29",
        startTimestamp: "2026-07-27T00:00:00.000Z",
        endExclusiveTimestamp: "2026-07-30T00:00:00.000Z",
      },
    );
    expect(report.series).toEqual([
      { date: "2026-07-27", runs: 2, cost: 0.0048 },
      { date: "2026-07-28", runs: 0, cost: 0 },
      { date: "2026-07-29", runs: 1, cost: 0.0024 },
    ]);
    expect(report.summary).toEqual({
      totalCost: 0.0072,
      chargedRuns: 3,
      highestDailyCost: 0.0048,
      averageCost: 0.0024,
    });
  });

  it("keeps aggregate billing totals and category costs aligned", () => {
    const dates = {
      from: "2026-08-09",
      to: "2026-08-10",
      startTimestamp: "2026-08-09T00:00:00.000Z",
      endExclusiveTimestamp: "2026-08-11T00:00:00.000Z",
    };
    const prompt = buildBillingReport(
      [{ metric_date: "2026-08-09", charged_runs: 2, provider_cost_usd: 0.2 }],
      dates,
    );
    const enrichment = buildBillingReport(
      [{ metric_date: "2026-08-10", charged_runs: 1, provider_cost_usd: 0.1 }],
      dates,
    );
    const entities = buildBillingReport(
      [{ metric_date: "2026-08-10", charged_runs: 2, provider_cost_usd: 0.05 }],
      dates,
    );

    expect(mergeBillingReports(prompt, enrichment, entities)).toMatchObject({
      summary: {
        totalCost: 0.35,
        chargedTasks: 5,
        averageCost: 0.07,
        highestDailyCost: 0.2,
        byCategory: {
          promptTracking: { totalCost: 0.2, chargedTasks: 2 },
          productEnrichment: { totalCost: 0.1, chargedTasks: 1 },
          entityExtraction: { totalCost: 0.05, chargedTasks: 2 },
        },
      },
      series: [
        {
          date: "2026-08-09",
          totalCost: 0.2,
          promptTrackingCost: 0.2,
          productEnrichmentCost: 0,
          entityExtractionCost: 0,
        },
        {
          date: "2026-08-10",
          totalCost: 0.15,
          promptTrackingCost: 0,
          productEnrichmentCost: 0.1,
          entityExtractionCost: 0.05,
        },
      ],
    });
  });

  it("attributes prompt costs by delivery tier without changing prompt totals", () => {
    const dates = {
      from: "2026-08-16",
      to: "2026-08-17",
      startTimestamp: "2026-08-16T00:00:00.000Z",
      endExclusiveTimestamp: "2026-08-18T00:00:00.000Z",
    };
    const prompts = buildBillingReport([
      { metric_date: "2026-08-16", charged_runs: 115, provider_cost_usd: 0.276 },
      { metric_date: "2026-08-17", charged_runs: 115, provider_cost_usd: 0.138 },
    ], dates);
    const highPriority = buildBillingReport([
      { metric_date: "2026-08-16", charged_runs: 115, provider_cost_usd: 0.276 },
    ], dates);
    const retainedPages = buildBillingReport([
      { metric_date: "2026-08-16", charged_runs: 115, provider_cost_usd: 0.276 },
      { metric_date: "2026-08-17", charged_runs: 115, provider_cost_usd: 0.138 },
    ], dates);
    const empty = buildBillingReport([], dates);

    expect(mergeBillingReports(prompts, empty, empty, {
      highPriority,
      retainedPages,
    })).toMatchObject({
      summary: {
        totalCost: 0.414,
        chargedTasks: 230,
        byCategory: {
          promptTracking: { totalCost: 0.414, chargedTasks: 230 },
        },
        promptTrackingBreakdown: {
          standard: { totalCost: 0.138, chargedTasks: 115 },
          highPriority: { totalCost: 0.276, chargedTasks: 115 },
          live: { totalCost: 0, chargedTasks: 0 },
          retainedPages: { totalCost: 0.414, chargedTasks: 230 },
        },
      },
      series: [
        {
          date: "2026-08-16",
          promptTrackingCost: 0.276,
          promptTrackingStandardCost: 0,
          promptTrackingHighPriorityCost: 0.276,
          promptTrackingLiveCost: 0,
        },
        {
          date: "2026-08-17",
          promptTrackingCost: 0.138,
          promptTrackingStandardCost: 0.138,
          promptTrackingHighPriorityCost: 0,
          promptTrackingLiveCost: 0,
        },
      ],
    });
  });

  it("sums multiple billing detail rows for the same day", () => {
    const dates = {
      from: "2026-08-17",
      to: "2026-08-17",
      startTimestamp: "2026-08-17T00:00:00.000Z",
      endExclusiveTimestamp: "2026-08-18T00:00:00.000Z",
    };

    expect(buildBillingReport([
      { metric_date: "2026-08-17", charged_runs: 100, provider_cost_usd: 0.12 },
      { metric_date: "2026-08-17", charged_runs: 15, provider_cost_usd: 0.018 },
    ], dates).summary).toMatchObject({
      totalCost: 0.138,
      chargedRuns: 115,
    });
  });
});

describe("competitive brand reporting", () => {
  const owned = { id: "owned", name: "Acme", kind: "owned" as const };
  const competitor = {
    id: "competitor",
    name: "Rival",
    kind: "competitor" as const,
  };
  const day = [{ metric_date: "2026-08-10", completed_runs: 10 }];

  it("sums platform counts while counting each platform's owned response union once", () => {
    const rows = aggregateBrandMentionDays([
      {
        tracking_source: "chatgpt",
        metric_date: "2026-08-10",
        brand_id: owned.id,
        deterministic_responses: 3,
        extracted_responses: 1,
        overlap_responses: 1,
        owned_mentioned_responses: 3,
      },
      {
        tracking_source: "chatgpt",
        metric_date: "2026-08-10",
        brand_id: competitor.id,
        deterministic_responses: 2,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 3,
      },
      {
        tracking_source: "gemini",
        metric_date: "2026-08-10",
        brand_id: owned.id,
        deterministic_responses: 2,
        extracted_responses: 1,
        overlap_responses: 0,
        owned_mentioned_responses: 3,
      },
    ]);

    expect(rows).toEqual([
      {
        metric_date: "2026-08-10",
        brand_id: competitor.id,
        deterministic_responses: 2,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 6,
      },
      {
        metric_date: "2026-08-10",
        brand_id: owned.id,
        deterministic_responses: 5,
        extracted_responses: 2,
        overlap_responses: 1,
        owned_mentioned_responses: 6,
      },
    ]);
    const report = buildBrandComparison(
      [owned, competitor],
      [{ metric_date: "2026-08-10", completed_runs: 20 }],
      rows,
    );
    expect(report.summary).toMatchObject({
      ownedMentionedResponses: 6,
      ownedVisibility: 30,
      ownedAppearances: 6,
      totalBrandAppearances: 8,
      ownedShareOfVoice: 75,
    });
  });

  it("deduplicates deterministic and extracted mentions of the same brand", () => {
    const report = buildBrandComparison(
      [owned, competitor],
      day,
      [
        {
          metric_date: "2026-08-10",
          brand_id: owned.id,
          deterministic_responses: 3,
          extracted_responses: 2,
          overlap_responses: 1,
          owned_mentioned_responses: 4,
        },
      ],
    );

    expect(report.summary).toMatchObject({
      ownedMentionedResponses: 4,
      ownedAppearances: 4,
      totalBrandAppearances: 4,
    });
  });

  it("uses the owned response union for visibility and appearances for Share of Voice", () => {
    const secondOwned = {
      id: "owned-two",
      name: "Acme Labs",
      kind: "owned" as const,
    };
    const report = buildBrandComparison(
      [owned, secondOwned, competitor],
      day,
      [
        {
          metric_date: "2026-08-10",
          brand_id: owned.id,
          deterministic_responses: 4,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: 5,
        },
        {
          metric_date: "2026-08-10",
          brand_id: secondOwned.id,
          deterministic_responses: 3,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: 5,
        },
        {
          metric_date: "2026-08-10",
          brand_id: competitor.id,
          deterministic_responses: 3,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: 5,
        },
      ],
    );

    expect(report.summary).toMatchObject({
      ownedMentionedResponses: 5,
      ownedAppearances: 7,
      ownedVisibility: 50,
      ownedShareOfVoice: 70,
      totalBrandAppearances: 10,
    });
    expect(report.brands[0]?.name).toBe("Your brands");
  });

  it("ranks only four competitors while retaining every competitor in the denominator", () => {
    const competitors = [
      ["c1", "Able", 9],
      ["c2", "Beta", 8],
      ["c3", "Cyan", 7],
      ["c4", "Delta", 6],
      ["c5", "Echo", 5],
    ] as const;
    const rows = [
      {
        metric_date: "2026-08-10",
        brand_id: owned.id,
        deterministic_responses: 10,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 10,
      },
      ...competitors.map(([id, , mentions]) => ({
        metric_date: "2026-08-10",
        brand_id: id,
        deterministic_responses: mentions,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 10,
      })),
    ];
    const report = buildBrandComparison(
      [
        owned,
        ...competitors.map(([id, name]) => ({
          id,
          name,
          kind: "competitor" as const,
        })),
      ],
      day,
      rows,
    );

    expect(report.summary.totalBrandAppearances).toBe(45);
    expect(report.summary.ownedShareOfVoice).toBeCloseTo((10 / 45) * 100);
    expect(report.brands.map((brand) => brand.id)).toEqual([
      owned.id,
      "c1",
      "c2",
      "c3",
      "c4",
    ]);
  });

  it("uses brand name and id as deterministic ranking tie-breakers", () => {
    const report = buildBrandComparison(
      [
        owned,
        { id: "z", name: "Beta", kind: "competitor" },
        { id: "b", name: "Alpha", kind: "competitor" },
        { id: "a", name: "Alpha", kind: "competitor" },
      ],
      day,
      ["z", "b", "a"].map((brandId) => ({
        metric_date: "2026-08-10",
        brand_id: brandId,
        deterministic_responses: 2,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 0,
      })),
    );

    expect(report.brands.slice(1).map((brand) => brand.id)).toEqual([
      "a",
      "b",
      "z",
    ]);
  });

  it.each([
    [8, 4, 40],
    [4, 8, -40],
    [4, 4, 0],
  ])("calculates ahead, behind, and tied gaps", (ownedCount, competitorCount, gap) => {
    const report = buildBrandComparison(
      [owned, competitor],
      day,
      [
        {
          metric_date: "2026-08-10",
          brand_id: owned.id,
          deterministic_responses: ownedCount,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: ownedCount,
        },
        {
          metric_date: "2026-08-10",
          brand_id: competitor.id,
          deterministic_responses: competitorCount,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: ownedCount,
        },
      ],
    );

    expect(
      report.summary.competitiveGap?.differencePercentagePoints,
    ).toBe(gap);
  });

  it("marks Share of Voice and the gap unavailable without competitors", () => {
    const report = buildBrandComparison([owned], day, [
      {
        metric_date: "2026-08-10",
        brand_id: owned.id,
        deterministic_responses: 3,
        extracted_responses: 0,
        overlap_responses: 0,
        owned_mentioned_responses: 3,
      },
    ]);

    expect(report.summary.ownedShareOfVoice).toBeNull();
    expect(report.summary.competitiveGap).toBeNull();
    expect(report.series[0]?.metrics.owned?.shareOfVoice).toBeNull();
  });

  it("keeps daily Share of Voice null when no tracked brand appears", () => {
    const report = buildBrandComparison([owned, competitor], day, []);

    expect(report.summary.ownedShareOfVoice).toBeNull();
    expect(report.series[0]?.metrics.owned?.shareOfVoice).toBeNull();
    expect(
      report.series[0]?.metrics[`competitor_${competitor.id}`]?.shareOfVoice,
    ).toBeNull();
  });
});

describe("overview product visibility", () => {
  it("hides the product row only when both product collections are empty", () => {
    expect(hasOverviewProducts(undefined)).toBe(false);
    expect(hasOverviewProducts({ topProducts: [], recentProducts: [] })).toBe(
      false,
    );
    expect(hasOverviewProducts({ topProducts: [{}], recentProducts: [] })).toBe(
      true,
    );
    expect(hasOverviewProducts({ topProducts: [], recentProducts: [{}] })).toBe(
      true,
    );
  });
});

describe("prompt-set event reporting", () => {
  it("aggregates prompt additions and removals by project and day", () => {
    const report = buildPromptSetEvents(
      [
        {
          action: "query.created",
          metadata_json: JSON.stringify({ projectId: "project-a" }),
          created_at: "2026-08-08T09:00:00.000Z",
        },
        {
          action: "query.bulk_created",
          metadata_json: JSON.stringify({
            projectId: "project-a",
            createdCount: 99,
          }),
          created_at: "2026-08-08T10:00:00.000Z",
        },
        {
          action: "query.purge_requested",
          metadata_json: JSON.stringify({ projectId: "project-a" }),
          created_at: "2026-08-08T11:00:00.000Z",
        },
        {
          action: "query.created",
          metadata_json: JSON.stringify({ projectId: "project-b" }),
          created_at: "2026-08-08T12:00:00.000Z",
        },
        {
          action: "query.created",
          metadata_json: JSON.stringify({ projectId: "project-a" }),
          created_at: "2026-08-10T09:00:00.000Z",
        },
      ],
      "project-a",
    );

    expect(report).toEqual([
      { metric_date: "2026-08-08", addedCount: 100, removedCount: 1 },
      { metric_date: "2026-08-10", addedCount: 1, removedCount: 0 },
    ]);
  });

  it("ignores malformed, zero, unsupported, and undated audit rows", () => {
    expect(
      buildPromptSetEvents(
        [
          {
            action: "query.bulk_created",
            metadata_json: "not-json",
            created_at: "2026-08-08T09:00:00.000Z",
          },
          {
            action: "query.bulk_created",
            metadata_json: JSON.stringify({
              projectId: "project-a",
              createdCount: 0,
            }),
            created_at: "2026-08-08T09:00:00.000Z",
          },
          {
            action: "query.updated",
            metadata_json: JSON.stringify({ projectId: "project-a" }),
            created_at: "2026-08-08T09:00:00.000Z",
          },
          {
            action: "query.created",
            metadata_json: JSON.stringify({ projectId: "project-a" }),
            created_at: "invalid",
          },
        ],
        "project-a",
      ),
    ).toEqual([]);
  });
});

describe("prompt-set chart annotations", () => {
  it("labels additions, removals, and mixed changes", () => {
    expect(promptSetEventLabel({ addedCount: 1, removedCount: 0 })).toBe(
      "+1 prompt",
    );
    expect(promptSetEventLabel({ addedCount: 0, removedCount: 10 })).toBe(
      "−10 prompts",
    );
    expect(promptSetEventLabel({ addedCount: 100, removedCount: 10 })).toBe(
      "+100 / −10",
    );
  });

  it("anchors missing dates to the next point and combines shared anchors", () => {
    const annotations = alignPromptSetEvents(
      [
        { metric_date: "2026-08-08", addedCount: 1, removedCount: 0 },
        { metric_date: "2026-08-09", addedCount: 2, removedCount: 0 },
        { metric_date: "2026-08-10", addedCount: 0, removedCount: 1 },
        { metric_date: "2026-08-12", addedCount: 20, removedCount: 0 },
      ],
      ["2026-08-08", "2026-08-10", "2026-08-11"],
    );

    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatchObject({
      chartDate: "2026-08-08",
      label: "+1 prompt",
    });
    expect(annotations[1]).toMatchObject({
      chartDate: "2026-08-10",
      addedCount: 2,
      removedCount: 1,
      label: "+2 / −1",
    });
    expect(annotations[1]?.sourceEvents.map((event) => event.metric_date)).toEqual([
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(promptSetEventDescription(annotations[1]!)).toContain(
      "2 prompts added on 2026-08-09",
    );
    expect(promptSetEventDescription(annotations[1]!)).toContain(
      "next available chart point on 2026-08-10",
    );
  });

  it("clusters adjacent markers without combining wider chart changes", () => {
    const chartDates = [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ];
    const aligned = alignPromptSetEvents(
      [
        { metric_date: "2026-07-29", addedCount: 7, removedCount: 0 },
        { metric_date: "2026-07-30", addedCount: 107, removedCount: 0 },
        { metric_date: "2026-08-07", addedCount: 2, removedCount: 1 },
      ],
      chartDates,
    );

    const clustered = clusterPromptSetEvents(aligned, chartDates);

    expect(clustered).toHaveLength(2);
    expect(clustered[0]).toMatchObject({
      chartDate: "2026-07-30",
      addedCount: 114,
      removedCount: 0,
      label: "+114 prompts",
    });
    expect(clustered[0]?.sourceEvents.map((event) => event.metric_date)).toEqual([
      "2026-07-29",
      "2026-07-30",
    ]);
    expect(clustered[1]).toMatchObject({
      chartDate: "2026-08-07",
      label: "+2 / −1",
    });
  });
});
