import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readJsonConfig, analyticsUrls } from "./analytics-deployment.mjs";

const args = process.argv.slice(2).filter((v) => v !== "--");
if (args.includes("--help")) {
  console.log("Configure analytics: pnpm configure:analytics -- [--profile deployment/getbelki.json] [--integrated | --origin https://analytics.example.com] [--script-url https://cdn.example.com/belki-analytics.js]");
  process.exit(0);
}
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value.`);
  return args[index + 1];
};
const path = resolve(value("--profile") || "wrangler.jsonc");
const config = readJsonConfig(path);
let origin = args.includes("--integrated") ? "" : value("--origin");
let script = value("--script-url") ?? "";
if (origin === undefined) {
  if (!process.stdin.isTTY) throw new Error("Pass --integrated or --origin in non-interactive use.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = await input.question("Analytics: [1] same application (default), [2] separate service: ");
    if (!["", "1", "2"].includes(choice.trim())) throw new Error("Choose 1 or 2.");
    origin = choice.trim() === "2" ? (await input.question("Public analytics origin (https://analytics.example.com): ")).trim() : "";
    if (choice.trim() === "2" && !origin) throw new Error("A separate service requires a public origin.");
    script = (await input.question("Optional script URL on your CDN (Enter for the default): ")).trim();
  } finally { input.close(); }
}
const vars = { ...config.vars, PUBLIC_ANALYTICS_ORIGIN: origin, PUBLIC_ANALYTICS_SCRIPT_URL: script };
const normalized = analyticsUrls(vars);
config.vars = { ...vars, PUBLIC_ANALYTICS_ORIGIN: normalized.origin };
writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
console.log(`Analytics configuration saved to ${path}. Deploy to apply it. ${origin ? "The deployment also publishes a separate Worker; its hostname must belong to your Cloudflare account." : "The application will serve the script and events."}`);
