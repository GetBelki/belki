import { describe, expect, it } from "vitest";
import {
  fanOutLabel,
  googleShoppingUrl,
  productDestination,
  productImage,
  safeExternalUrl,
  type ProductEvidence,
} from "../src/app/lib/snapshot-evidence";

const product: ProductEvidence = {
  id: "product-1",
  snapshot_item_id: "item-1",
  provider_product_id: "provider-product-1",
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
  it("prefers a direct product listing URL", () => {
    expect(productDestination({
      ...product,
      canonical_url: "https://merchant.example/product",
    })).toBe("https://merchant.example/product");
  });

  it("uses a valid raw listing when the canonical URL is unavailable", () => {
    expect(productDestination({
      ...product,
      canonical_url: "javascript:alert(1)",
      raw_url: "https://merchant.example/raw-product",
    })).toBe("https://merchant.example/raw-product");
  });

  it("falls back to the provider's localized Google Shopping query", () => {
    const url = new URL(productDestination(product));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("udm")).toBe("28");
    expect(url.searchParams.get("q")).toBe("sensitive dog food");
    expect(url.searchParams.get("gl")).toBe("de");
    expect(url.searchParams.get("hl")).toBe("de");
    expect(googleShoppingUrl(product)).toBe(url.href);
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
