import { z } from "zod";

export const TRAFFIC_SOURCES = ["chatgpt", "claude", "gemini", "perplexity", "copilot", "grok"] as const;
export const TRAFFIC_LABELS: Record<TrafficSource, string> = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity", copilot: "Copilot", grok: "Grok",
};
export type TrafficSource = typeof TRAFFIC_SOURCES[number];
export const TRAFFIC_ALIASES: Record<string, TrafficSource> = {
  chatgpt: "chatgpt", "chatgpt.com": "chatgpt", "chat.openai.com": "chatgpt",
  claude: "claude", "claude.ai": "claude", gemini: "gemini", "gemini.google.com": "gemini",
  perplexity: "perplexity", "perplexity.ai": "perplexity", copilot: "copilot",
  "copilot.microsoft.com": "copilot", grok: "grok", "grok.com": "grok",
};
export const trafficPath = z.string().max(1024).regex(/^\/(?!\/)[^?#\s]*$/);
const hostname = z.string().trim().toLowerCase().max(253).regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
export const TrafficGoalSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  type: z.enum(["path", "event"]), value: z.string().trim().min(1).max(1024),
}).strict().superRefine((goal, ctx) => {
  if (goal.type === "path" ? !trafficPath.safeParse(goal.value).success : !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(goal.value)) {
    ctx.addIssue({ code: "custom", message: "Use an exact pathname or a simple event name.", path: ["value"] });
  }
});
export const TrafficSettingsSchema = z.object({
  enabled: z.boolean(), domains: z.array(hostname).min(1).max(20),
  aliases: z.array(z.object({ alias: z.string().trim().toLowerCase().min(1).max(100), source: z.enum(TRAFFIC_SOURCES) }).strict()).max(50),
  goals: z.array(TrafficGoalSchema).max(30),
}).strict().superRefine((settings, ctx) => {
  const seen = new Set<string>();
  for (const { alias, source } of settings.aliases) {
    if (seen.has(alias) || (TRAFFIC_ALIASES[alias] && TRAFFIC_ALIASES[alias] !== source)) {
      ctx.addIssue({ code: "custom", message: "Aliases must be unique and cannot override built-in sources.", path: ["aliases"] });
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
export function trafficAliases(aliases: TrafficSettings["aliases"]): Record<string, TrafficSource> {
  return Object.assign(Object.create(null) as Record<string, TrafficSource>, TRAFFIC_ALIASES,
    Object.fromEntries(aliases.map(({ alias, source }) => [alias, source])));
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
