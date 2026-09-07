import { z } from "zod";

export const TRAFFIC_SOURCES = ["chatgpt", "claude", "gemini", "perplexity", "copilot", "grok"] as const;
export const TRAFFIC_LABELS: Record<TrafficSource, string> = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity", copilot: "Copilot", grok: "Grok",
};
export type TrafficSource = typeof TRAFFIC_SOURCES[number];
export const TRAFFIC_SOURCE_ALIASES: Record<TrafficSource, readonly string[]> = {
  chatgpt: ["chatgpt", "chatgpt.com", "chat.openai.com", "openai.com"],
  claude: ["claude", "claude.ai", "claude.anthropic.com"],
  gemini: ["gemini", "gemini.google.com", "bard", "bard.google.com"],
  perplexity: ["perplexity", "perplexity.ai"],
  copilot: ["copilot", "copilot.com", "copilot.microsoft.com", "edgepilot", "edgeservices"],
  grok: ["grok", "grok.com"],
};
export type TrafficSourceId = string;
export const TRAFFIC_ALIASES: Record<string, TrafficSourceId> = Object.fromEntries(
  TRAFFIC_SOURCES.flatMap((source) => TRAFFIC_SOURCE_ALIASES[source].map((alias) => [alias, source])),
);
export const TrafficSourceIdSchema = z.string().trim().toLowerCase().min(1).max(50).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/);
export const TrafficAliasValueSchema = z.string().trim().toLowerCase().min(1).max(100).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
export const TrafficCustomSourceSchema = z.object({
  id: TrafficSourceIdSchema,
  label: z.string().trim().min(1).max(50),
}).strict();
export const TrafficAliasSchema = z.object({ alias: TrafficAliasValueSchema, source: TrafficSourceIdSchema }).strict();
export type TrafficCustomSource = z.infer<typeof TrafficCustomSourceSchema>;
export type TrafficAlias = z.infer<typeof TrafficAliasSchema>;
export const trafficPath = z.string().max(1024).regex(/^\/(?!\/)[^?#\s]*$/);
export const TrafficHostnameSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
export const TrafficGoalSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  type: z.enum(["path", "event"]), value: z.string().trim().min(1).max(1024),
}).strict().superRefine((goal, ctx) => {
  if (goal.type === "path" ? !trafficPath.safeParse(goal.value).success : !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(goal.value)) {
    ctx.addIssue({ code: "custom", message: "Use an exact pathname or a simple event name.", path: ["value"] });
  }
});
export const TrafficSettingsSchema = z.object({
  enabled: z.boolean(), domains: z.array(TrafficHostnameSchema).min(1).max(20),
  customSources: z.array(TrafficCustomSourceSchema).max(20).default([]),
  aliases: z.array(TrafficAliasSchema).max(100),
  goals: z.array(TrafficGoalSchema).max(30),
}).strict().superRefine((settings, ctx) => {
  const sourceIds = new Set<string>(TRAFFIC_SOURCES);
  const sourceLabels = new Set(Object.values(TRAFFIC_LABELS).map((label) => label.toLowerCase()));
  for (const source of settings.customSources) {
    if (sourceIds.has(source.id) || sourceLabels.has(source.label.toLowerCase())) {
      ctx.addIssue({ code: "custom", message: "Source names and identifiers must be unique.", path: ["customSources"] });
    }
    sourceIds.add(source.id);
    sourceLabels.add(source.label.toLowerCase());
  }
  const seen = new Set<string>();
  for (const { alias, source } of settings.aliases) {
    if (!sourceIds.has(source)) {
      ctx.addIssue({ code: "custom", message: "Every alias must refer to an existing source.", path: ["aliases"] });
    }
    if (seen.has(alias) || (TRAFFIC_ALIASES[alias] && TRAFFIC_ALIASES[alias] !== source) || (sourceIds.has(alias) && alias !== source)) {
      ctx.addIssue({ code: "custom", message: "Aliases must be unique and cannot override recognized source values.", path: ["aliases"] });
    }
    seen.add(alias);
  }
  if (new Set(settings.goals.map((goal) => goal.id)).size !== settings.goals.length) {
    ctx.addIssue({ code: "custom", message: "Goal identifiers must be unique.", path: ["goals"] });
  }
});
export type TrafficSettings = z.infer<typeof TrafficSettingsSchema>;
export interface TrafficInstallation {
  origin: string;
  scriptUrl: string;
  mode: "integrated" | "separate";
  customScript: boolean;
}
export interface TrafficTestResult {
  expiresAt: number;
  result: { receivedAt: number; path: string; event: string | null; goals: string[] } | null;
}
export type TrafficConfig = TrafficSettings & { key: string | null; lastEvent: number | null; installation: TrafficInstallation };

export function trafficSnippet(installation: TrafficInstallation, key: string): string {
  const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<script>
  window.belki = window.belki || { q: [], track: function (name) {
    if (this.q.length < 30) this.q.push({ name: name, at: Date.now(), url: location.href });
  }};
</script>
<script async src="${attr(installation.scriptUrl)}" data-site="${attr(key)}" data-api="${attr(installation.origin)}"></script>`;
}
export function trafficAliases(settings: Pick<TrafficSettings, "customSources" | "aliases">): Record<string, TrafficSourceId> {
  return Object.assign(Object.create(null) as Record<string, TrafficSourceId>, TRAFFIC_ALIASES,
    Object.fromEntries(settings.customSources.map(({ id }) => [id, id])),
    Object.fromEntries(settings.aliases.map(({ alias, source }) => [alias, source])));
}
export function trafficSourceLabel(source: string, customSources: TrafficCustomSource[]): string {
  return TRAFFIC_LABELS[source as TrafficSource] ?? customSources.find(({ id }) => id === source)?.label ?? source;
}
export function trafficDevice(ua: string): string {
  if (!ua) return "unknown";
  if (/ipad|tablet|android(?!.*mobile)/i.test(ua)) return "tablet";
  if (/mobile|iphone|ipod/i.test(ua)) return "mobile";
  return /windows|macintosh|linux|cros/i.test(ua) ? "desktop" : "unknown";
}
export interface TrafficReport {
  summary: { sessions: number; views: number; visibleMs: number; converted: number };
  daily: { label: string; sessions: number; views: number }[];
  sources: TrafficBreakdown[]; entries: TrafficBreakdown[]; pages: TrafficBreakdown[];
  countries: TrafficBreakdown[]; devices: TrafficBreakdown[];
  goals: { label: string; sessions: number }[];
}
export interface TrafficBreakdown { label: string; sessions: number; views: number; converted: number }
