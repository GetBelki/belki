export interface GoogleProductIdentifiers {
  productId: string | null;
  dataDocid: string | null;
  gid: string | null;
}

function identifier(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function googleProductIdentifiers(value: unknown): GoogleProductIdentifiers | null {
  if (!Array.isArray(value)) return null;
  const candidates = value
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
    )
    .map((item, ordinal) => ({
      ordinal,
      productId: identifier(item, "catalog_id"),
      dataDocid:
        identifier(item, "headline_offer_docid") ?? identifier(item, "product_id"),
      gid: identifier(item, "gpcid"),
    }))
    .filter((candidate) => candidate.productId || candidate.dataDocid || candidate.gid)
    .sort((left, right) => {
      const leftScore = Number(Boolean(left.productId)) + Number(Boolean(left.dataDocid)) + Number(Boolean(left.gid));
      const rightScore = Number(Boolean(right.productId)) + Number(Boolean(right.dataDocid)) + Number(Boolean(right.gid));
      return rightScore - leftScore || left.ordinal - right.ordinal;
    });
  const selected = candidates[0];
  return selected
    ? {
        productId: selected.productId,
        dataDocid: selected.dataDocid,
        gid: selected.gid,
      }
    : null;
}

export function productEnrichmentDue(
  lastSuccessAt: string | null,
  now = new Date(),
): boolean {
  if (!lastSuccessAt) return true;
  const lastSuccess = Date.parse(lastSuccessAt);
  return !Number.isFinite(lastSuccess) || now.getTime() - lastSuccess >= 7 * 86_400_000;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function finiteInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export interface MarketPricePoint {
  currency: string | null;
  minimum: number;
  median: number;
  maximum: number;
}

export function summarizeMarketPrices(
  offers: Array<{ price: number | null; currency: string | null }>,
): MarketPricePoint[] {
  const grouped = new Map<string, number[]>();
  for (const offer of offers) {
    if (offer.price === null) continue;
    const key = offer.currency ?? "";
    grouped.set(key, [...(grouped.get(key) ?? []), offer.price]);
  }
  return [...grouped.entries()].map(([currency, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return {
      currency: currency || null,
      minimum: sorted[0]!,
      median,
      maximum: sorted.at(-1)!,
    };
  });
}
