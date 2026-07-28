export interface SnapshotIndex {
  id: string;
  tracked_query_id: string;
  query_text: string;
  captured_at: string;
  model: string | null;
  cited_domains_count: number;
  retrieved_domains_count: number;
  brand_entities_count: number;
  products_count: number;
  check_url: string | null;
}

export interface SnapshotRecord {
  id: string;
  tracked_query_id: string;
  keyword: string;
  location_code: number;
  language_code: string;
  model: string | null;
  check_url: string | null;
  captured_at: string;
  answer_markdown: string | null;
  fan_out_queries: unknown[];
  item_types: unknown[];
  se_results_count: number | null;
  provider_cost_usd: number | null;
  provider_status_code: number | null;
  provider_status_message: string | null;
  has_html_evidence: boolean;
}

export type EvidenceRow = Record<string, unknown>;

export interface StructuredEvidenceItem extends EvidenceRow {
  id: string;
  ordinal: number;
  type: string;
  rank_group: number | null;
  rank_absolute: number | null;
  markdown: string | null;
  payload: unknown;
}

export interface ProductEvidence extends EvidenceRow {
  id: string;
  snapshot_item_id: string;
  provider_product_id: string | null;
  title: string | null;
  merchants: string | null;
  price: number | null;
  currency: string | null;
  tag: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  registrable_domain: string | null;
  rating_value: number | null;
  rating_votes_count: number | null;
  rating_max: number | null;
  images: unknown[];
  product_ids: unknown[];
}

export interface SnapshotDetail {
  snapshot: SnapshotRecord;
  sources: EvidenceRow[];
  searchResults: EvidenceRow[];
  brands: EvidenceRow[];
  products: ProductEvidence[];
  domains: EvidenceRow[];
  items: StructuredEvidenceItem[];
  brandMentions: Array<{
    id: string;
    kind: "owned" | "competitor";
    name: string;
    matchedTerms: string[];
  }>;
}

export interface SnapshotDiff {
  previous: { id: string; capturedAt: string } | null;
  domains?: { added: string[]; removed: string[] };
  brands?: { added: string[]; removed: string[] };
  answerChanged?: boolean;
  modelChanged?: boolean;
  productBlockChanged?: boolean;
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function fanOutLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["query", "keyword", "text", "title"]) {
    const label = record[key];
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  return null;
}

export function productImage(product: ProductEvidence): string | null {
  for (const image of product.images) {
    if (typeof image === "string") {
      const url = safeExternalUrl(image);
      if (url) return url;
    }
    if (image && typeof image === "object" && !Array.isArray(image)) {
      const record = image as Record<string, unknown>;
      const url = safeExternalUrl(record.url ?? record.src);
      if (url) return url;
    }
  }
  return null;
}

type ProductDestinationData = Pick<
  ProductEvidence,
  "canonical_url" | "raw_url" | "title" | "merchants" | "product_ids"
>;

export function googleShoppingUrl(
  product: Pick<ProductDestinationData, "title" | "merchants" | "product_ids">,
): string {
  const productId = product.product_ids.find(
    (value): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  const providerQuery =
    typeof productId?.query === "string"
      ? productId.query.replaceAll("+", " ").trim()
      : null;
  const query = providerQuery || product.title || product.merchants || "product";
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("udm", "28");
  url.searchParams.set("q", query);
  if (typeof productId?.gl === "string") url.searchParams.set("gl", productId.gl);
  if (typeof productId?.hl === "string") url.searchParams.set("hl", productId.hl);
  return url.href;
}

export function productDestination(product: ProductDestinationData): string {
  return (
    safeExternalUrl(product.canonical_url) ??
    safeExternalUrl(product.raw_url) ??
    googleShoppingUrl(product)
  );
}

export function formatPrice(
  price: number | null,
  currency: string | null,
): string | null {
  if (price === null) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(price);
  } catch {
    return `${price}${currency ? ` ${currency}` : ""}`;
  }
}
