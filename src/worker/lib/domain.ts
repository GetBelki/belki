import { getDomain } from "tldts";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "ref_src",
  "source",
]);

export interface NormalizedUrl {
  rawUrl: string | null;
  canonicalUrl: string | null;
  hostname: string | null;
  registrableDomain: string | null;
}

export function normalizeHostname(value: string | null | undefined): {
  hostname: string | null;
  registrableDomain: string | null;
} {
  if (!value) return { hostname: null, registrableDomain: null };
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!hostname) return { hostname: null, registrableDomain: null };
  return {
    hostname,
    registrableDomain: getDomain(hostname, { allowPrivateDomains: true }) ?? hostname,
  };
}

export function normalizeUrl(value: string | null | undefined): NormalizedUrl {
  if (!value) {
    return { rawUrl: null, canonicalUrl: null, hostname: null, registrableDomain: null };
  }
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    const normalized = normalizeHostname(url.hostname);
    return {
      rawUrl: value,
      canonicalUrl: url.toString(),
      hostname: normalized.hostname,
      registrableDomain: normalized.registrableDomain,
    };
  } catch {
    const normalized = normalizeHostname(value);
    return {
      rawUrl: value,
      canonicalUrl: null,
      hostname: normalized.hostname,
      registrableDomain: normalized.registrableDomain,
    };
  }
}

export function normalizeBrand(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}
