import { readFileSync } from "node:fs";
import ts from "typescript";

export function readJsonConfig(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(`Invalid JSON configuration: ${path}`);
  return parsed.config;
}
export function analyticsUrls(vars) {
  const origin = String(vars.PUBLIC_ANALYTICS_ORIGIN ?? "").trim();
  const script = String(vars.PUBLIC_ANALYTICS_SCRIPT_URL ?? "").trim();
  for (const [value, originOnly] of [[origin, true], [script, false]]) {
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== "/")) {
      throw new Error("Public analytics configuration requires HTTPS URLs without credentials, query or fragment; the origin must not include a path.");
    }
  }
  return { origin: origin ? new URL(origin).origin : "", script };
}
export function analyticsWorkerConfig(base, vars, root, database) {
  const { origin } = analyticsUrls(vars);
  if (!origin) throw new Error("Set PUBLIC_ANALYTICS_ORIGIN before deploying the separate analytics Worker.");
  if (vars.PUBLIC_APP_ORIGIN && new URL(vars.PUBLIC_APP_ORIGIN).origin === origin) throw new Error("A separate Worker must use a different origin from the application.");
  return {
    name: `${base.name}-analytics`, main: `${root}/src/analytics/worker.ts`,
    ...(base.account_id ? { account_id: base.account_id } : {}),
    compatibility_date: base.compatibility_date, compatibility_flags: ["nodejs_compat"],
    workers_dev: false, routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
    assets: { directory: `${root}/dist/analytics-assets`, run_worker_first: ["/v1/*"], not_found_handling: "none" },
    d1_databases: [{ binding: "CONTROL_DB", database_name: database.database_name, database_id: database.database_id }],
    observability: { enabled: true, head_sampling_rate: 0.1 },
  };
}

export function analyticsDeployEnvironment(parent, workerName) {
  const env = { ...parent };
  // Workers Builds pins its primary Worker. This child deployment intentionally
  // targets another service: never inherit a name override for the application.
  if (env.WRANGLER_CI_OVERRIDE_NAME) env.WRANGLER_CI_OVERRIDE_NAME = workerName;
  delete env.WRANGLER_CI_MATCH_TAG;
  return env;
}
export function analyticsDatabase(base, profile = {}) {
  const database = base.d1_databases.find((db) => db.binding === "CONTROL_DB");
  if (!database) throw new Error("The application must define its CONTROL_DB binding.");
  const id = profile.analytics?.controlDatabaseId ?? database.database_id;
  if (id && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
    throw new Error("The analytics control database ID must be a UUID.");
  }
  return { ...database, ...(id ? { database_id: id } : {}) };
}
