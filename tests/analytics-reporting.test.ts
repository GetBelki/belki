import { describe, expect, it } from "vitest";
import { productIdentity } from "../src/worker/lib/reporting";

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
});
