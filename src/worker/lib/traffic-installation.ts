import type { TrafficInstallation } from "../../shared/traffic";

// Deployment configuration, never project/user supplied endpoint URLs.
export function analyticsInstallation(env: {
  PUBLIC_APP_ORIGIN?: string; PUBLIC_ANALYTICS_ORIGIN?: string; PUBLIC_ANALYTICS_SCRIPT_URL?: string;
}, requestUrl: string): TrafficInstallation {
  const appOrigin = publicUrl(env.PUBLIC_APP_ORIGIN || new URL(requestUrl).origin, true).origin;
  const origin = publicUrl(env.PUBLIC_ANALYTICS_ORIGIN || appOrigin, true).origin;
  const scriptUrl = publicUrl(env.PUBLIC_ANALYTICS_SCRIPT_URL || `${origin}/belki-analytics.js`, false).href;
  return { origin, scriptUrl, mode: origin === appOrigin ? "integrated" : "separate", customScript: new URL(scriptUrl).origin !== origin };
}
function publicUrl(value: string, originOnly: boolean): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password ||
      url.hash || url.search || (originOnly && url.pathname !== "/")) {
    throw new Error("Analytics public URLs must use HTTPS (HTTP is allowed for localhost), without credentials, query or fragment. Origins cannot include a path.");
  }
  return url;
}
