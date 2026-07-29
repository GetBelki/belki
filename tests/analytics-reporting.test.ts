import { describe, expect, it } from "vitest";
import {
  billingDateRange,
  buildBillingReport,
  productAnalyticsDateRange,
  productIdentity,
  productIdentityFromKey,
  productKey,
  summarizeProductPrices,
} from "../src/worker/lib/reporting";

const base = {
  provider_product_id: null,
  canonical_url: null,
  raw_url: null,
  title: " Camera  Pro ",
  merchants: "Example Shop",
  registrable_domain: "example.com",
};

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
});
