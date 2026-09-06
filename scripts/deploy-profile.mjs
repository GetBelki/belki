import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { analyticsUrls } from "./analytics-deployment.mjs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const profileArgument = process.argv.indexOf("--profile");
const profilePath = profileArgument >= 0 ? process.argv[profileArgument + 1] : undefined;
const dryRun = process.argv.includes("--dry-run");
const resolveD1Catalog = process.argv.includes("--resolve-d1-catalog");
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
  "PUBLIC_APP_ORIGIN",
  "PUBLIC_ANALYTICS_ORIGIN",
  "PUBLIC_ANALYTICS_SCRIPT_URL",
  "EMAIL_FROM_ADDRESS",
  // Migration-only compatibility: a temporary profile can expose the previous
  // non-secret Stripe catalogue long enough for Operator → Payments to import it.
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
const generated = {
  ...base,
  workers_dev: profile.workers_dev,
  routes: profile.routes,
  vars: { ...base.vars, ...profile.vars },
};

analyticsUrls(generated.vars);

const publicAppOrigin = String(generated.vars.PUBLIC_APP_ORIGIN ?? "").trim();
if (publicAppOrigin) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicAppOrigin);
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN must be a valid HTTPS origin.");
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new Error("PUBLIC_APP_ORIGIN must be an HTTPS origin without credentials, a path, query, or fragment.");
  }
  generated.vars.PUBLIC_APP_ORIGIN = parsedOrigin.origin;
}

const emailFromAddress = String(generated.vars.EMAIL_FROM_ADDRESS ?? "").trim();
if (emailFromAddress) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(emailFromAddress)) {
    throw new Error("EMAIL_FROM_ADDRESS must be a valid email address.");
  }
  generated.send_email = [{
    name: "EMAIL",
    allowed_sender_addresses: [emailFromAddress],
  }];
}

if (resolveD1Catalog) {
  const catalogResult = spawnSync(wrangler, ["d1", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (catalogResult.status !== 0) {
    process.stderr.write(catalogResult.stderr);
    throw new Error("Could not resolve the production D1 catalog.");
  }
  const catalog = JSON.parse(catalogResult.stdout);
  const databaseIds = new Map(catalog.map((database) => [database.name, database.uuid]));
  generated.d1_databases = generated.d1_databases.map((database) => {
    const databaseId = databaseIds.get(database.database_name);
    if (!databaseId) {
      throw new Error(`Production D1 database not found: ${database.database_name}`);
    }
    return { ...database, database_id: databaseId };
  });
}

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
