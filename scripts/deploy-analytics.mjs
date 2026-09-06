import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonConfig, analyticsWorkerConfig, analyticsUrls, analyticsDatabase, analyticsDeployEnvironment } from "./analytics-deployment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const args = process.argv.slice(2).filter((v) => v !== "--");
const profileIndex = args.indexOf("--profile");
if (args.includes("--help")) {
  console.log("Deploy the separate analytics service: pnpm deploy:analytics -- [--profile deployment/getbelki.json] [--dry-run]");
  process.exit(0);
}
const base = readJsonConfig(resolve(root, "wrangler.jsonc"));
const profile = profileIndex < 0 ? {} : readJsonConfig(resolve(root, args[profileIndex + 1]));
const vars = { ...base.vars, ...profile.vars };
const { origin } = analyticsUrls(vars);
// Safe no-op lets the normal deploy command support both installation modes.
if (!origin || origin === vars.PUBLIC_APP_ORIGIN) {
  console.log("Analytics uses the integrated application deployment.");
  process.exit(0);
}
function run(argv, capture = false) {
  const result = spawnSync(wrangler, argv, { cwd: root, env: analyticsDeployEnvironment(process.env, `${base.name}-analytics`), encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`Wrangler failed (${result.status ?? result.error}). ${capture ? result.stderr : ""}`);
  return result.stdout;
}
let database = analyticsDatabase(base, profile);
if (!database.database_id) {
  if (args.includes("--dry-run")) database = { ...database, database_id: "00000000-0000-0000-0000-000000000001" };
  else {
    const databases = JSON.parse(run(["d1", "list", "--json"], true));
    const match = databases.find((db) => db.name === database.database_name);
    if (!match) throw new Error("Deploy/migrate the application's CONTROL_DB before deploying analytics.");
    database = { ...database, database_id: match.uuid };
  }
}
await import("./build-analytics.mjs");
const config = analyticsWorkerConfig(base, vars, root, database);
const directory = resolve(root, ".wrangler/analytics");
mkdirSync(directory, { recursive: true });
const path = resolve(directory, "wrangler.json");
writeFileSync(path, JSON.stringify(config, null, 2));
run(["deploy", "--config", path, ...(args.includes("--dry-run") ? ["--dry-run"] : [])]);
