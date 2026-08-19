import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const profileArgument = process.argv.indexOf("--profile");
const profilePath = profileArgument >= 0 ? process.argv[profileArgument + 1] : undefined;
const dryRun = process.argv.includes("--dry-run");
const maxDeployAttempts = dryRun ? 1 : 3;

if (!profilePath) throw new Error("Pass --profile with a managed deployment profile.");

const resolvedProfilePath = resolve(root, profilePath);
const deployPointerPath = resolve(root, ".wrangler", "deploy", "config.json");
let deployPointer;
try {
  deployPointer = JSON.parse(readFileSync(deployPointerPath, "utf8"));
} catch {
  throw new Error("The Cloudflare Vite deployment config is missing. Run pnpm build first.");
}
const basePath = resolve(dirname(deployPointerPath), deployPointer.configPath);
const generatedPath = resolve(dirname(basePath), "wrangler.getbelki.generated.json");
const base = JSON.parse(readFileSync(basePath, "utf8"));
const profile = JSON.parse(readFileSync(resolvedProfilePath, "utf8"));

const allowedVars = new Set([
  "DEPLOYMENT_MODE",
  "PAYMENT_MODE",
  "BILLING_PLAN_CHANGES_ENABLED",
  "TRACKING_SOURCE_GEMINI_ENABLED",
  "TRACKING_SOURCE_GOOGLE_AI_MODE_ENABLED",
  "TRACKING_SOURCE_GOOGLE_AI_OVERVIEW_ENABLED",
  "STRIPE_ENVIRONMENT",
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_STUDIO_PRICE_ID",
  "STRIPE_AGENCY_PRICE_ID",
  "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID",
]);
const forbiddenSecretNames = /(?:PASSWORD|SECRET|TOKEN|LOGIN|CRYPTO_KEY)$/u;
const credentialValue = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}/u;

if (profile.profileVersion !== 1) throw new Error("Unsupported deployment profile version.");
if (typeof profile.workers_dev !== "boolean" || !Array.isArray(profile.routes) || !profile.vars) {
  throw new Error("Deployment profile must define workers_dev, routes, and vars.");
}
for (const [name, value] of Object.entries(profile.vars)) {
  if (!allowedVars.has(name)) throw new Error(`Deployment profile cannot override ${name}.`);
  if (forbiddenSecretNames.test(name) || credentialValue.test(String(value))) {
    throw new Error(`Deployment profile contains a secret-shaped value in ${name}.`);
  }
}
if (!profile.routes.every((route) => typeof route?.pattern === "string" && route.custom_domain === true)) {
  throw new Error("Managed deployment routes must be explicit custom domains.");
}
if (profile.vars.STRIPE_ENVIRONMENT !== "test" && profile.vars.STRIPE_ENVIRONMENT !== "live") {
  throw new Error("STRIPE_ENVIRONMENT must be test or live.");
}
if (profile.vars.PAYMENT_MODE !== "disabled") {
  for (const name of [
    "STRIPE_STARTER_PRICE_ID",
    "STRIPE_STUDIO_PRICE_ID",
    "STRIPE_AGENCY_PRICE_ID",
    "STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID",
  ]) {
    if (!String(profile.vars[name] ?? "").match(name.endsWith("PORTAL_CONFIGURATION_ID") ? /^bpc_/u : /^price_/u)) {
      throw new Error(`${name} is required when managed payments are enabled.`);
    }
  }
}

const generated = {
  ...base,
  workers_dev: profile.workers_dev,
  routes: profile.routes,
  vars: { ...base.vars, ...profile.vars },
};

try {
  writeFileSync(generatedPath, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
  const args = ["deploy", "--config", generatedPath];
  if (dryRun) args.push("--dry-run");
  for (let attempt = 1; attempt <= maxDeployAttempts; attempt += 1) {
    const result = spawnSync(wrangler, args, {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status === 0) {
      process.exitCode = 0;
      break;
    }
    process.exitCode = result.status ?? 1;
    if (attempt === maxDeployAttempts) break;
    const delaySeconds = attempt * 10;
    console.warn(
      `Cloudflare deployment failed; retrying in ${delaySeconds} seconds (${attempt}/${maxDeployAttempts}).`,
    );
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, delaySeconds * 1_000);
    });
  }
} finally {
  try {
    unlinkSync(generatedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
