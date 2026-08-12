import { normalizeBrand, normalizeUrl } from "./domain";

type UnknownRecord = Record<string, unknown>;

const AD_TRACKING_PARAMETERS = new Set([
  "adgroup",
  "adgroupid",
  "campaign",
  "campaignid",
  "creative",
  "creativeid",
  "keyword",
  "matchtype",
  "network",
  "device",
]);

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown, maximum = 20_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeAdKey(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export function normalizeAdDestination(value: string | null | undefined) {
  const normalized = normalizeUrl(value);
  if (!normalized.canonicalUrl) return normalized;
  const url = new URL(normalized.canonicalUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (AD_TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return { ...normalized, canonicalUrl: url.toString() };
}

export interface NormalizedAd {
  rankGroup: number | null;
  rankAbsolute: number | null;
  advertiserIdentity: string;
  advertiserKey: string;
  advertiserName: string | null;
  advertiserRawUrl: string | null;
  advertiserCanonicalUrl: string | null;
  advertiserHostname: string | null;
  advertiserDomain: string | null;
  title: string | null;
  snippet: string | null;
  rawUrl: string | null;
  canonicalUrl: string | null;
  destinationHostname: string | null;
  destinationDomain: string | null;
  imageSourceUrl: string | null;
  faviconSourceUrl: string | null;
  creativeIdentity: string;
  creativeKey: string;
}

export function normalizeAdItem(value: unknown): NormalizedAd | null {
  const item = record(value);
  if (!item || item.type !== "chat_gpt_ad") return null;
  const advertiser = record(item.advertiser);
  const advertiserName = text(advertiser?.name, 2_000);
  const advertiserUrl = normalizeAdDestination(text(advertiser?.url, 10_000));
  const destination = normalizeAdDestination(text(item.url, 10_000));
  const title = text(item.title, 10_000);
  const snippet = text(item.snippet, 50_000);
  const advertiserDomain =
    advertiserUrl.registrableDomain ?? destination.registrableDomain;
  const advertiserIdentity = advertiserDomain
    ? `domain:${advertiserDomain}`
    : `name:${normalizeBrand(
        advertiserName ?? text(item.domain, 2_000) ?? title ?? "unknown advertiser",
      )}`;
  const imageSourceUrl = normalizeUrl(text(item.image_url, 10_000)).canonicalUrl;
  const faviconSourceUrl = normalizeUrl(text(advertiser?.favicon_url, 10_000)).canonicalUrl;
  const creativeIdentity = [
    advertiserIdentity,
    destination.canonicalUrl ?? destination.rawUrl ?? "",
    normalizeBrand(title ?? ""),
    normalizeBrand(snippet ?? ""),
    imageSourceUrl ?? "",
  ].join("|");
  return {
    rankGroup: number(item.rank_group),
    rankAbsolute: number(item.rank_absolute),
    advertiserIdentity,
    advertiserKey: base64Url(advertiserIdentity),
    advertiserName,
    advertiserRawUrl: advertiserUrl.rawUrl,
    advertiserCanonicalUrl: advertiserUrl.canonicalUrl,
    advertiserHostname: advertiserUrl.hostname,
    advertiserDomain,
    title,
    snippet,
    rawUrl: destination.rawUrl,
    canonicalUrl: destination.canonicalUrl,
    destinationHostname: destination.hostname,
    destinationDomain: destination.registrableDomain,
    imageSourceUrl,
    faviconSourceUrl,
    creativeIdentity,
    creativeKey: base64Url(creativeIdentity),
  };
}

export async function adAssetKey(sourceUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sourceUrl),
  );
  return `ads/assets/${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function allowedAdAssetUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return ["bzrcdn.openai.com", "api.dataforseo.com"].includes(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}
