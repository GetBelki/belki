import type { TrackingSource } from "./tracking-sources";

export const CAPTURE_PROVIDERS = [
  "dataforseo",
  "brightdata",
  "cloro",
  "oxylabs",
] as const;

export type CaptureProvider = (typeof CAPTURE_PROVIDERS)[number];

export const CAPTURE_PROVIDER_LABELS: Record<CaptureProvider, string> = {
  dataforseo: "DataForSEO",
  brightdata: "Bright Data",
  cloro: "Cloro",
  oxylabs: "Oxylabs",
};

export const CAPTURE_PROVIDER_DOMAINS: Record<CaptureProvider, string> = {
  dataforseo: "dataforseo.com",
  brightdata: "brightdata.com",
  cloro: "cloro.dev",
  oxylabs: "oxylabs.io",
};

export const CAPTURE_PROVIDER_DASHBOARD_URLS: Record<CaptureProvider, string> = {
  dataforseo: "https://app.dataforseo.com/",
  brightdata: "https://brightdata.com/cp/",
  cloro: "https://dashboard.cloro.dev/",
  oxylabs: "https://dashboard.oxylabs.io/",
};

export const CAPTURE_PROVIDER_PRIORITY: Record<CaptureProvider, number> = {
  dataforseo: 10,
  brightdata: 20,
  cloro: 30,
  oxylabs: 40,
};

export const CAPTURE_PROVIDER_SOURCES: Record<
  CaptureProvider,
  readonly TrackingSource[]
> = {
  dataforseo: ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"],
  brightdata: ["chatgpt"],
  cloro: ["chatgpt", "gemini", "google_ai_mode", "google_ai_overview"],
  oxylabs: ["chatgpt", "google_ai_mode", "google_ai_overview"],
};

export function captureProviderSupportsSource(
  provider: CaptureProvider,
  source: TrackingSource,
): boolean {
  return CAPTURE_PROVIDER_SOURCES[provider].includes(source);
}
