import { describe, expect, it } from "vitest";
import {
  fanOutLabel,
  googleShoppingUrl,
  productImage,
  safeExternalUrl,
  type ProductEvidence,
} from "../src/app/lib/snapshot-evidence";

const product: ProductEvidence = {
  id: "product-1",
  title: "Sensitive dog food",
  merchants: "example.test",
  price: 24.9,
  currency: "EUR",
  tag: null,
  canonical_url: null,
  raw_url: null,
  registrable_domain: null,
  rating_value: 4.8,
  rating_votes_count: 12,
  rating_max: 5,
  images: ["https://images.example.test/product.jpg"],
  product_ids: [
    {
      type: "chat_gpt_google_shopping_product",
      query: "sensitive+dog+food",
      gl: "de",
      hl: "de",
    },
  ],
};

describe("snapshot evidence helpers", () => {
  it("builds a localized Google Shopping search from provider product metadata", () => {
    const url = new URL(googleShoppingUrl(product));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("udm")).toBe("28");
    expect(url.searchParams.get("q")).toBe("sensitive dog food");
    expect(url.searchParams.get("gl")).toBe("de");
    expect(url.searchParams.get("hl")).toBe("de");
  });

  it("falls back to the product title when provider metadata is absent", () => {
    const url = new URL(googleShoppingUrl({ ...product, product_ids: [] }));
    expect(url.searchParams.get("q")).toBe("Sensitive dog food");
  });

  it("extracts fan-out query labels from supported provider shapes", () => {
    expect(fanOutLabel("related query")).toBe("related query");
    expect(fanOutLabel({ keyword: "provider keyword" })).toBe("provider keyword");
    expect(fanOutLabel({ unexpected: "value" })).toBeNull();
  });

  it("allows only HTTP image and destination URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("https://example.test/path")).toBe(
      "https://example.test/path",
    );
    expect(productImage(product)).toBe("https://images.example.test/product.jpg");
  });
});
