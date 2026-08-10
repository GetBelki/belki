import { describe, expect, it } from "vitest";
import {
  createScopedSignedJobTag,
  verifyScopedSignedJobTag,
} from "../src/worker/lib/crypto";
import {
  finiteInteger,
  finiteNumber,
  googleProductIdentifiers,
  productEnrichmentDue,
  summarizeMarketPrices,
} from "../src/worker/lib/product-enrichment";

describe("Google Shopping product enrichment", () => {
  it("selects the most complete provider identifier set", () => {
    expect(
      googleProductIdentifiers([
        { catalog_id: "catalog-only" },
        {
          catalog_id: 753232,
          headline_offer_docid: "5398337953081206135",
          gpcid: "3310192661423604640",
        },
      ]),
    ).toEqual({
      productId: "753232",
      dataDocid: "5398337953081206135",
      gid: "3310192661423604640",
    });
  });

  it("returns no identifiers for unrelated provider metadata", () => {
    expect(googleProductIdentifiers([{ query: "dog food" }, null])).toBeNull();
  });

  it("only refreshes a successful locale after seven days", () => {
    const now = new Date("2026-08-10T09:00:00.000Z");
    expect(productEnrichmentDue(null, now)).toBe(true);
    expect(productEnrichmentDue("2026-08-03T09:00:00.000Z", now)).toBe(true);
    expect(productEnrichmentDue("2026-08-03T09:00:01.000Z", now)).toBe(false);
    expect(productEnrichmentDue("invalid", now)).toBe(true);
  });

  it("normalizes numeric provider fields without accepting non-finite values", () => {
    expect(finiteNumber("4.8")).toBe(4.8);
    expect(finiteInteger("136.9")).toBe(136);
    expect(finiteNumber("Infinity")).toBeNull();
    expect(finiteNumber({ value: 4.8 })).toBeNull();
  });

  it("summarizes comparable offers independently by currency", () => {
    expect(
      summarizeMarketPrices([
        { price: 21.99, currency: "EUR" },
        { price: 18, currency: "EUR" },
        { price: 24, currency: "EUR" },
        { price: 30, currency: "USD" },
        { price: null, currency: "EUR" },
      ]),
    ).toEqual([
      { currency: "EUR", minimum: 18, median: 21.99, maximum: 24 },
      { currency: "USD", minimum: 30, median: 30, maximum: 30 },
    ]);
  });

  it("scopes signed callback tags to product enrichment", async () => {
    const jobId = "07151455-1535-4455-8000-4ef29a2e5cad";
    const tag = await createScopedSignedJobTag("product", jobId, "test-secret");

    await expect(
      verifyScopedSignedJobTag(tag, "product", "test-secret"),
    ).resolves.toBe(jobId);
    await expect(
      verifyScopedSignedJobTag(tag, "prompt", "test-secret"),
    ).resolves.toBeNull();
    await expect(
      verifyScopedSignedJobTag(`${tag.slice(0, -1)}x`, "product", "test-secret"),
    ).resolves.toBeNull();
  });
});
