export const TRACKING_SOURCES = [
  "chatgpt",
  "gemini",
  "google_ai_mode",
  "google_ai_overview",
] as const;

export type TrackingSource = (typeof TRACKING_SOURCES)[number];

export const TRACKING_SOURCE_LABELS: Record<TrackingSource, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  google_ai_mode: "Google AI Mode",
  google_ai_overview: "Google AI Overviews",
};

export const TRACKING_SOURCE_DESCRIPTIONS: Record<TrackingSource, string> = {
  chatgpt: "Track answers and citations from ChatGPT Search.",
  gemini: "Track answers and citations from Gemini.",
  google_ai_mode: "Track answers and sources from Google AI Mode.",
  google_ai_overview: "Track when Google shows an AI Overview and which sources it cites.",
};

export const DEFAULT_TRACKING_SOURCES: TrackingSource[] = ["chatgpt"];
