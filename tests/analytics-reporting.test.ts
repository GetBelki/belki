import { describe, expect, it } from "vitest";
import {
  aggregateBrandMentionDays,
  buildBrandComparison,
  buildCitationUtmCoverageTrend,
  buildFanOutActivityTrend,
  buildFanOutSignalTrend,
  buildResponseShareTrend,
  classifyRelatedQueries,
  positionDistribution,
  productAnalyticsComparisonDateRange,
  productAnalyticsDateRange,
  productCapturePositions,
  productIdentity,
  productIdentityFromKey,
  productKey,
  normalizeRelatedQuery,
  relatedQueryFromKey,
  relatedQueryKey,
  relatedQueryLabel,
  summarizeProductPrices,
  summarizeProductPerformance,
} from "../src/worker/lib/reporting";
import {
  alignChartAnnotations,
  chartAnnotationDescription,
  chartAnnotationMarkerLabel,
  clusterChartAnnotations,
  hasOverviewProducts,
  promptSetEventLabel,
} from "../src/app/lib/overview";
import {
  buildChartAnnotations,
  normalizeProviderModel,
  promptChangeFromAudit,
  trackingSourceDelta,
} from "../src/shared/project-event-helpers";

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

  it("classifies response-level site and review fan-out queries", () => {
    expect(classifyRelatedQueries([
      "Canon USA customer reviews",
      "best offers SITE:usa.canon.com",
      "website:canon.com preview cameras",
    ])).toMatchObject({ reviewPresent: true, sitePresent: true });
    expect(classifyRelatedQueries(["website:canon.com preview cameras"]))
      .toMatchObject({ reviewPresent: false, sitePresent: false });
  });

  it("classifies official, government-domain, and education-domain fan-out queries", () => {
    expect(classifyRelatedQueries([
      "Canon USA warranty return policy official",
      "Canon sostenibilidad informe oficial",
      "site:bcb.gov.br pagamentos internacionais",
      "site:hacienda.gob.mx impuestos",
      "site:mit.edu admissions",
      "site:monash.edu.au scholarships",
    ])).toMatchObject({
      signalCounts: { education: 2 },
      governmentPresent: true,
      officialPresent: true,
    });
    expect(classifyRelatedQueries([
      "unofficial Canon community",
      "government camera procurement",
      "gobstopper reviews",
      "education camera programs",
      "site:example.education photography",
    ])).toMatchObject({
      signalCounts: { education: 0 },
      governmentPresent: false,
      officialPresent: false,
    });
  });

  it("deduplicates standalone years from 2025 through the current year", () => {
    expect(classifyRelatedQueries([
      "reviews 2024 2025 2026",
      "best cameras ２０２６/2027",
      "future cameras 2030 2050 6700",
      "model 20250",
    ], 2026).years).toEqual([2025, 2026]);
  });

  it("counts normalized fan-out signals with standalone boundaries", () => {
    const classification = classifyRelatedQueries([
      "Best CRM pricing reviews 2026",
      "best crm pricing reviews 2026",
      "Top CRM comparison: Acme vs. Beta",
      "SITE:example.com official pricing",
      "site:agency.gov/reviews",
      "topical unofficial gobstopper comparisonist vss",
    ], 2026);

    expect(classification.signalCounts).toEqual({
      site: 2,
      official: 1,
      government: 1,
      education: 0,
      pricing: 2,
      reviews: 2,
      best: 1,
      top: 1,
      comparison: 1,
      vs: 1,
      years: { "2026": 1 },
    });
  });

  it("counts each year once per normalized fan-out query", () => {
    expect(classifyRelatedQueries([
      "2025 pricing 2025",
      "2025 reviews",
      "２０２６ comparison",
    ], 2026).signalCounts.years).toEqual({ "2025": 2, "2026": 1 });
  });

  it("builds activity trends with response and fan-out denominators", () => {
    expect(buildFanOutActivityTrend(
      { from: "2026-08-17", to: "2026-08-18" },
      new Map([["2026-08-17", 10]]),
      new Map([["2026-08-17", 8]]),
      new Map([["2026-08-17", 8]]),
      new Map([["2026-08-17", 25]]),
    )).toEqual([
      {
        date: "2026-08-17",
        completedResponses: 10,
        reportedResponses: 8,
        unavailableResponses: 2,
        responsesWithFanOut: 8,
        totalFanOuts: 25,
        responseShare: 100,
        fanOutsPerResponse: 3.125,
        telemetryCoverage: 80,
      },
      {
        date: "2026-08-18",
        completedResponses: 0,
        reportedResponses: 0,
        unavailableResponses: 0,
        responsesWithFanOut: 0,
        totalFanOuts: 0,
        responseShare: 0,
        fanOutsPerResponse: 0,
        telemetryCoverage: 0,
      },
    ]);
  });

  it("builds signal trends across all three metric definitions", () => {
    expect(buildFanOutSignalTrend(
      { from: "2026-08-17", to: "2026-08-17" },
      new Map([["2026-08-17", 10]]),
      new Map([["2026-08-17", 8]]),
      new Map([["2026-08-17", 20]]),
      new Map([["2026-08-17", 4]]),
      new Map([["2026-08-17", 5]]),
    )).toEqual([{
      date: "2026-08-17",
      matchingFanOuts: 5,
      totalFanOuts: 20,
      matchingResponses: 4,
      completedResponses: 10,
      reportedResponses: 8,
      shareOfFanOuts: 25,
      fanOutsPerResponse: 0.625,
      responseShare: 50,
    }]);
  });

  it("zero-fills response-share trends and uses completed responses as the denominator", () => {
    expect(buildResponseShareTrend(
      { from: "2026-08-17", to: "2026-08-19" },
      new Map([
        ["2026-08-17", 10],
        ["2026-08-19", 4],
      ]),
      new Map([
        ["2026-08-17", 3],
        ["2026-08-19", 2],
      ]),
    )).toEqual([
      {
        date: "2026-08-17",
        matchingResponses: 3,
        completedResponses: 10,
        share: 30,
      },
      {
        date: "2026-08-18",
        matchingResponses: 0,
        completedResponses: 0,
        share: 0,
      },
      {
        date: "2026-08-19",
        matchingResponses: 2,
        completedResponses: 4,
        share: 50,
      },
    ]);
  });

  it("reports citation UTM coverage and leaves days without URLs as gaps", () => {
    expect(buildCitationUtmCoverageTrend(
      { from: "2026-10-08", to: "2026-10-10" },
      new Map([
        ["2026-10-08", 10],
        ["2026-10-09", 8],
      ]),
      new Map([
        ["2026-10-08", 8],
        ["2026-10-09", 8],
      ]),
      new Map([
        ["2026-10-08", 6],
        ["2026-10-09", 2],
      ]),
    )).toEqual([
      {
        date: "2026-10-08",
        citations: 10,
        citationUrls: 8,
        utmSourceCitations: 6,
        coverage: 75,
      },
      {
        date: "2026-10-09",
        citations: 8,
        citationUrls: 8,
        utmSourceCitations: 2,
        coverage: 25,
      },
      {
        date: "2026-10-10",
        citations: 0,
        citationUrls: 0,
        utmSourceCitations: 0,
        coverage: null,
      },
    ]);
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

  it("builds the immediately preceding equivalent comparison range", () => {
    expect(
      productAnalyticsComparisonDateRange(
        "7d",
        new Date("2026-07-29T18:00:00.000Z"),
      ),
    ).toEqual({
      from: "2026-07-16",
      to: "2026-07-22",
      startTimestamp: "2026-07-16T00:00:00.000Z",
      endExclusiveTimestamp: "2026-07-23T00:00:00.000Z",
    });
  });

  it("deduplicates captures and keeps the product's best position", () => {
    const occurrences = [
      { snapshot_id: "a", ordinal: 2 },
      { snapshot_id: "a", ordinal: 0 },
      { snapshot_id: "b", ordinal: 1 },
    ];

    expect([...productCapturePositions(occurrences)]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(summarizeProductPerformance(occurrences, 8)).toEqual({
      appearances: 3,
      appearingCaptures: 2,
      winningCaptures: 1,
      appearanceRate: 25,
      winRate: 50,
      averagePosition: 1.5,
    });
  });

  it("uses interpolated quartiles for position distributions", () => {
    expect(positionDistribution([1, 2, 4, 9])).toEqual({
      count: 4,
      minimum: 1,
      firstQuartile: 1.75,
      median: 3,
      thirdQuartile: 5.25,
      maximum: 9,
    });
    expect(positionDistribution([])).toBeNull();
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

  it("aggregates conditional first-mention position with owned response weighting", () => {
    const report = buildBrandComparison(
      [owned, competitor],
      day,
      [
        {
          metric_date: "2026-08-10",
          brand_id: owned.id,
          deterministic_responses: 3,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: 3,
          position_sum: 5,
          position_sample_count: 3,
          owned_position_sum: 5,
          owned_position_sample_count: 3,
        },
        {
          metric_date: "2026-08-10",
          brand_id: competitor.id,
          deterministic_responses: 2,
          extracted_responses: 0,
          overlap_responses: 0,
          owned_mentioned_responses: 3,
          position_sum: 3,
          position_sample_count: 2,
          owned_position_sum: 5,
          owned_position_sample_count: 3,
        },
      ],
    );

    expect(report.summary).toMatchObject({
      ownedAveragePosition: 5 / 3,
      ownedPositionSamples: 3,
    });
    expect(report.brands[1]).toMatchObject({
      averagePosition: 1.5,
      positionSamples: 2,
    });
    expect(report.series[0]?.metrics.owned).toMatchObject({
      averagePosition: 5 / 3,
      positionSamples: 3,
    });
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

describe("project event reporting", () => {
  it("aggregates prompt events while retaining typed platform and model events", () => {
    expect(buildChartAnnotations([
      {
        id: "prompt-1",
        event_type: "prompt_set_changed",
        tracking_source: null,
        event_date: "2026-08-08",
        occurred_at: "2026-08-08T09:00:00.000Z",
        payload_json: JSON.stringify({ addedCount: 3, removedCount: 0 }),
      },
      {
        id: "prompt-2",
        event_type: "prompt_set_changed",
        tracking_source: null,
        event_date: "2026-08-08",
        occurred_at: "2026-08-08T10:00:00.000Z",
        payload_json: JSON.stringify({ addedCount: 0, removedCount: 1 }),
      },
      {
        id: "source-1",
        event_type: "tracking_sources_changed",
        tracking_source: null,
        event_date: "2026-08-09",
        occurred_at: "2026-08-09T09:00:00.000Z",
        payload_json: JSON.stringify({
          addedSources: ["gemini"],
          removedSources: [],
        }),
      },
      {
        id: "model-1",
        event_type: "model_detected",
        tracking_source: "gemini",
        event_date: "2026-08-10",
        occurred_at: "2026-08-10T09:00:00.000Z",
        payload_json: JSON.stringify({ model: "Gemini 2.5 Pro" }),
      },
      {
        id: "malformed",
        event_type: "prompt_set_changed",
        tracking_source: null,
        event_date: "2026-08-10",
        occurred_at: "2026-08-10T10:00:00.000Z",
        payload_json: "not-json",
      },
      {
        id: "provider-1",
        event_type: "capture_provider_detected",
        tracking_source: "chatgpt",
        event_date: "2026-08-11",
        occurred_at: "2026-08-11T09:00:00.000Z",
        payload_json: JSON.stringify({ captureProvider: "brightdata" }),
      },
    ])).toEqual([
      {
        type: "prompt_set_changed",
        metricDate: "2026-08-08",
        addedCount: 3,
        removedCount: 1,
      },
      {
        type: "tracking_sources_changed",
        id: "source-1",
        metricDate: "2026-08-09",
        occurredAt: "2026-08-09T09:00:00.000Z",
        addedSources: ["gemini"],
        removedSources: [],
      },
      {
        type: "model_detected",
        id: "model-1",
        metricDate: "2026-08-10",
        occurredAt: "2026-08-10T09:00:00.000Z",
        trackingSource: "gemini",
        model: "Gemini 2.5 Pro",
      },
      {
        type: "capture_provider_detected",
        id: "provider-1",
        metricDate: "2026-08-11",
        occurredAt: "2026-08-11T09:00:00.000Z",
        trackingSource: "chatgpt",
        captureProvider: "brightdata",
      },
    ]);
  });

  it("normalizes model identities and calculates ordered source deltas", () => {
    expect(normalizeProviderModel("  GPT-5   Search ")).toEqual({
      display: "GPT-5 Search",
      key: "gpt-5 search",
    });
    expect(normalizeProviderModel("   ")).toBeNull();
    expect(normalizeProviderModel("chatgpt")).toBeNull();
    expect(normalizeProviderModel("Google AI Mode")).toBeNull();
    expect(trackingSourceDelta(
      ["chatgpt", "google_ai_mode"],
      ["chatgpt", "gemini"],
    )).toEqual({
      addedSources: ["gemini"],
      removedSources: ["google_ai_mode"],
    });
    expect(promptChangeFromAudit(
      "query.bulk_created",
      JSON.stringify({ createdCount: 8 }),
    )).toEqual({ addedCount: 8, removedCount: 0 });
    expect(promptChangeFromAudit("query.bulk_created", "not-json")).toBeNull();
    expect(promptChangeFromAudit(
      "query.bulk_created",
      JSON.stringify({ createdCount: 0 }),
    )).toBeNull();
  });
});

describe("project chart annotations", () => {
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
    const annotations = alignChartAnnotations(
      [
        { type: "prompt_set_changed", metricDate: "2026-08-08", addedCount: 1, removedCount: 0 },
        { type: "prompt_set_changed", metricDate: "2026-08-09", addedCount: 2, removedCount: 0 },
        { type: "prompt_set_changed", metricDate: "2026-08-10", addedCount: 0, removedCount: 1 },
        { type: "prompt_set_changed", metricDate: "2026-08-12", addedCount: 20, removedCount: 0 },
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
      label: "+2 / −1",
    });
    expect(annotations[1]?.sourceEvents.map((event) => event.metricDate)).toEqual([
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(chartAnnotationDescription(annotations[1]!)).toContain(
      "2 prompts added on 2026-08-09",
    );
    expect(chartAnnotationDescription(annotations[1]!)).toContain(
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
    const aligned = alignChartAnnotations(
      [
        { type: "prompt_set_changed", metricDate: "2026-07-29", addedCount: 7, removedCount: 0 },
        { type: "prompt_set_changed", metricDate: "2026-07-30", addedCount: 107, removedCount: 0 },
        { type: "prompt_set_changed", metricDate: "2026-08-07", addedCount: 2, removedCount: 1 },
      ],
      chartDates,
    );

    const clustered = clusterChartAnnotations(aligned, chartDates);

    expect(clustered).toHaveLength(2);
    expect(clustered[0]).toMatchObject({
      chartDate: "2026-07-30",
      label: "+114 prompts",
    });
    expect(clustered[0]?.sourceEvents.map((event) => event.metricDate)).toEqual([
      "2026-07-29",
      "2026-07-30",
    ]);
    expect(clustered[1]).toMatchObject({
      chartDate: "2026-08-07",
      label: "+2 / −1",
    });
  });

  it("labels mixed annotations and describes their platform context", () => {
    const aligned = alignChartAnnotations([
      {
        type: "model_detected",
        id: "model",
        metricDate: "2026-08-08",
        occurredAt: "2026-08-08T09:00:00.000Z",
        trackingSource: "chatgpt",
        model: "GPT-5 Search",
      },
      {
        type: "tracking_sources_changed",
        id: "source",
        metricDate: "2026-08-08",
        occurredAt: "2026-08-08T10:00:00.000Z",
        addedSources: ["gemini"],
        removedSources: [],
      },
    ], ["2026-08-08"]);

    expect(aligned[0]?.label).toBe("2 events");
    expect(chartAnnotationMarkerLabel(aligned[0]!)).toBe("2");
    expect(chartAnnotationDescription(aligned[0]!)).toContain(
      "GPT-5 Search first detected on ChatGPT",
    );
    expect(chartAnnotationDescription(aligned[0]!)).toContain("Gemini added");
  });

  it("labels capture providers separately from models", () => {
    const aligned = alignChartAnnotations([{
      type: "capture_provider_detected",
      id: "provider",
      metricDate: "2026-08-30",
      occurredAt: "2026-08-30T09:00:00.000Z",
      trackingSource: "chatgpt",
      captureProvider: "brightdata",
    }], ["2026-08-30"]);

    expect(aligned[0]?.label).toBe("Capture provider detected");
    expect(chartAnnotationMarkerLabel(aligned[0]!)).toBe("Bright Data");
    expect(chartAnnotationDescription(aligned[0]!)).toContain(
      "Bright Data first used for ChatGPT",
    );
  });
});
