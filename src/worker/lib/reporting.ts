export function productIdentity(product: {
  provider_product_id: string | null;
  canonical_url: string | null;
  raw_url: string | null;
  title: string | null;
  merchants: string | null;
  registrable_domain: string | null;
}): string {
  if (product.provider_product_id) return `id:${product.provider_product_id}`;
  if (product.canonical_url || product.raw_url) {
    return `url:${product.canonical_url ?? product.raw_url}`;
  }
  const normalized = (value: string | null) =>
    (value ?? "").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  return `fallback:${normalized(product.title)}|${normalized(
    product.merchants ?? product.registrable_domain,
  )}`;
}
