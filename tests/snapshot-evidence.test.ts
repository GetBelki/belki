import { describe, expect, it } from "vitest";
import {
  adVisibilityCounts,
  fanOutLabel,
  formatProviderCost,
  googleShoppingUrl,
  productAnalyticsKey,
  productDestination,
  productImage,
  safeExternalUrl,
  type ProductEvidence,
} from "../src/app/lib/snapshot-evidence";
import {
  productIdentity,
  productIdentityFromKey,
} from "../src/worker/lib/reporting";

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
      catalog_id: "7532324203553513537",
      headline_offer_docid: "5398337953081206135",
      image_docid: "1297225385981891981",
      rds: "PC_3310192661423604640|PROD_PC_3310192661423604640",
      gpcid: "3310192661423604640",
      mid: "576462853665945217",
      pvt: "hg",
      uule: "w+CAIQICITG93ZXIgL2F4b255LEdlcm1hbnk",
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
    expect(url.searchParams.get("ibp")).toBe("oshop");
    expect(url.searchParams.get("udm")).toBe("28");
    expect(url.searchParams.get("q")).toBe("sensitive dog food");
    expect(url.searchParams.get("gl")).toBe("de");
    expect(url.searchParams.get("hl")).toBe("de");
    expect(url.searchParams.get("uule")).toBe(
      "w+CAIQICITG93ZXIgL2F4b255LEdlcm1hbnk",
    );
    expect(url.searchParams.get("prds")).toBe(
      [
        "catalogid:7532324203553513537",
        "headlineOfferDocid:5398337953081206135",
        "imageDocid:1297225385981891981",
        "rds:PC_3310192661423604640|PROD_PC_3310192661423604640",
        "gpcid:3310192661423604640",
        "mid:576462853665945217",
        "pvt:hg",
      ].join(","),
    );
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

  it("shows small provider costs without rounding them to zero", () => {
    expect(formatProviderCost(0.0024)).toBe("$0.002400");
    expect(formatProviderCost(0.00004)).toBe("$0.000040");
    expect(formatProviderCost(null)).toBe("—");
  });

  it("builds product report keys that match backend product identities", () => {
    expect(productIdentityFromKey(productAnalyticsKey(product))).toBe(
      productIdentity(product),
    );
  });

  it("separates rendered and hidden ads while treating legacy ads as rendered", () => {
    const item = (id: string, isRendered?: boolean) => ({
      id,
      ordinal: 0,
      type: "chat_gpt_ad",
      rank_group: 1,
      rank_absolute: 1,
      markdown: null,
      payload: isRendered === undefined ? {} : { is_rendered: isRendered },
    });
    expect(adVisibilityCounts([], [
      item("hidden-1", false),
      item("hidden-2", false),
      item("rendered", true),
      item("legacy"),
    ])).toEqual({ rendered: 2, served: 4, hidden: 2 });
  });
});
