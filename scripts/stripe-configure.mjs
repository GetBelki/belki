import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const checkOnly = process.argv.includes("--check");
const bootstrapCatalogue = process.argv.includes("--bootstrap-catalogue");
const live = process.argv.includes("--live") || argument("--mode") === "live";
const mode = live ? "live" : "test";
const stripeApiVersion = "2025-03-31.basil";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help() {
  console.log(`Configure and validate Belki's Stripe catalogue and action portal.

Usage:
  pnpm stripe:configure -- --origin https://app.example.com --bootstrap-catalogue
  pnpm stripe:check -- --origin https://app.example.com
  pnpm stripe:configure -- --live --confirm-live app.example.com --origin https://app.example.com --bootstrap-catalogue

Authentication comes from \`stripe login\`. Test mode is the default. The helper
never accepts or prints a Stripe secret key.

Options:
  --origin <https-origin>       Required portal return origin
  --mode test|live             Stripe environment (test is the default)
  --live                       Alias for --mode live
  --confirm-live <hostname>    Required for live writes; must match --origin
  --bootstrap-catalogue        Create missing Products/Prices idempotently
  --starter-price <price_id>   Validate an explicit Starter Price
  --studio-price <price_id>    Validate an explicit Studio Price
  --agency-price <price_id>    Validate an explicit Agency Price
  --portal-id <bpc_id>         Validate/update an explicit action portal
  --check                      Read-only validation`);
}

if (process.argv.includes("--help")) {
  help();
  process.exit(0);
}

if (argument("--mode") && !["test", "live"].includes(argument("--mode"))) {
  throw new Error("--mode must be test or live.");
}

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const origin = (argument("--origin") ?? config.vars.APP_ORIGIN ?? "").replace(/\/$/u, "");
if (!origin.startsWith("https://")) {
  throw new Error("Pass an HTTPS origin with --origin https://app.example.com.");
}
const hostname = new URL(origin).hostname;
if (live && !checkOnly && argument("--confirm-live") !== hostname) {
  throw new Error(`Live Stripe changes require --confirm-live ${hostname}.`);
}

function stripeCommand(args, params = [], { write = false, idempotencyKey } = {}) {
  const commandArgs = [...args, "--color", "off", "--log-level", "error", "--stripe-version", stripeApiVersion];
  if (live) commandArgs.push("--live");
  if (write) commandArgs.push("--confirm");
  if (idempotencyKey) commandArgs.push("--idempotency", idempotencyKey);
  for (const [name, value] of params) commandArgs.push("-d", `${name}=${value}`);
  const result = spawnSync(process.platform === "win32" ? "stripe.exe" : "stripe", commandArgs, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Stripe CLI is not installed. Install it and run stripe login.");
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown Stripe CLI error").trim().slice(0, 2_000);
    throw new Error(`Stripe CLI ${args.join(" ")} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Stripe CLI ${args.join(" ")} did not return JSON.`);
  }
}

function stripe(method, path, params = [], options = {}) {
  const args = [method, path];
  return stripeCommand(args, params, { ...options, write: method === "post" });
}

const plans = [
  { key: "starter", name: "Belki Starter", amount: 1_000, configuredId: argument("--starter-price") ?? config.vars.STRIPE_STARTER_PRICE_ID },
  { key: "studio", name: "Belki Studio", amount: 2_900, configuredId: argument("--studio-price") ?? config.vars.STRIPE_STUDIO_PRICE_ID },
  { key: "agency", name: "Belki Agency", amount: 14_900, configuredId: argument("--agency-price") ?? config.vars.STRIPE_AGENCY_PRICE_ID },
];

function validatePrice(plan, price) {
  const failures = [];
  if (!price?.id?.startsWith("price_")) failures.push("missing ID");
  if (!price.active) failures.push("inactive");
  if (price.livemode !== live) failures.push(`livemode=${price.livemode}`);
  if (price.currency !== "eur") failures.push(`currency=${price.currency}`);
  if (price.type !== "recurring" || price.recurring?.interval !== "month" || price.recurring?.interval_count !== 1) failures.push("not monthly");
  if (price.unit_amount !== plan.amount) failures.push(`amount=${price.unit_amount}`);
  if (price.tax_behavior !== "exclusive") failures.push(`tax_behavior=${price.tax_behavior}`);
  const productId = typeof price.product === "string" ? price.product : price.product?.id;
  if (!productId?.startsWith("prod_")) failures.push("missing Product");
  if (failures.length) throw new Error(`${plan.name} Price ${price?.id ?? "unknown"} is invalid: ${failures.join(", ")}.`);
  return { key: plan.key, priceId: price.id, productId };
}

function uniqueMatch(items, description) {
  if (items.length > 1) throw new Error(`Stripe has multiple ${description}; pass explicit Price IDs or resolve the duplicate objects.`);
  return items[0] ?? null;
}

const productList = stripe("get", "/v1/products", [["active", "true"], ["limit", "100"]]).data ?? [];
const prices = [];
for (const plan of plans) {
  if (plan.configuredId?.startsWith("price_")) {
    prices.push(validatePrice(plan, stripe("get", `/v1/prices/${encodeURIComponent(plan.configuredId)}`)));
    continue;
  }

  const metadataMatches = productList.filter((product) => product.metadata?.belki_plan_key === plan.key);
  const nameMatches = productList.filter((product) => product.name === plan.name);
  let product = uniqueMatch(metadataMatches, `Products marked belki_plan_key=${plan.key}`)
    ?? uniqueMatch(nameMatches, `active Products named ${plan.name}`);

  if (!product) {
    if (checkOnly || !bootstrapCatalogue) {
      throw new Error(`${plan.name} is missing. Run with --bootstrap-catalogue or pass --${plan.key}-price.`);
    }
    product = stripe("post", "/v1/products", [
      ["name", plan.name],
      ["metadata[belki_managed]", "true"],
      ["metadata[belki_plan_key]", plan.key],
    ]);
    productList.push(product);
  } else if (bootstrapCatalogue && product.metadata?.belki_plan_key !== plan.key) {
    product = stripe("post", `/v1/products/${encodeURIComponent(product.id)}`, [
      ["metadata[belki_managed]", "true"],
      ["metadata[belki_plan_key]", plan.key],
    ]);
  }

  const productPrices = stripe("get", "/v1/prices", [
    ["active", "true"],
    ["product", product.id],
    ["type", "recurring"],
    ["limit", "100"],
  ]).data ?? [];
  const exactPrices = productPrices.filter((price) =>
    price.currency === "eur" &&
    price.unit_amount === plan.amount &&
    price.tax_behavior === "exclusive" &&
    price.recurring?.interval === "month" &&
    price.recurring?.interval_count === 1
  );
  let price = uniqueMatch(exactPrices, `valid monthly Prices for ${plan.name}`);
  if (!price) {
    if (checkOnly || !bootstrapCatalogue) {
      throw new Error(`${plan.name} has no valid EUR monthly tax-exclusive Price. Run with --bootstrap-catalogue.`);
    }
    price = stripe("post", "/v1/prices", [
      ["product", product.id],
      ["currency", "eur"],
      ["unit_amount", String(plan.amount)],
      ["tax_behavior", "exclusive"],
      ["recurring[interval]", "month"],
      ["recurring[interval_count]", "1"],
      ["lookup_key", `belki_${plan.key}_monthly_eur_v1`],
      ["metadata[belki_plan_key]", plan.key],
    ]);
  }
  prices.push(validatePrice(plan, price));
}

if (new Set(prices.map((price) => price.productId)).size !== prices.length) {
  throw new Error("Starter, Studio, and Agency must use three distinct Stripe Products.");
}

const configurations = stripe("get", "/v1/billing_portal/configurations", [["limit", "100"]]);
const defaultPortal = configurations.data?.find((item) => item.is_default);
if (!defaultPortal?.active) throw new Error("Activate Stripe's default customer portal in this Stripe environment first.");
const defaultPortalFailures = [];
if (defaultPortal.features?.subscription_update?.enabled) defaultPortalFailures.push("plan switching is enabled");
if (defaultPortal.features?.subscription_cancel?.enabled) defaultPortalFailures.push("cancellation is enabled");
if (!defaultPortal.features?.payment_method_update?.enabled) defaultPortalFailures.push("payment-method updates are disabled");
if (!defaultPortal.features?.invoice_history?.enabled) defaultPortalFailures.push("invoice history is disabled");
if (defaultPortalFailures.length) {
  throw new Error(`Stripe's default portal is unsafe: ${defaultPortalFailures.join(", ")}.`);
}
if (live) {
  const privacyUrl = defaultPortal.business_profile?.privacy_policy_url;
  const termsUrl = defaultPortal.business_profile?.terms_of_service_url;
  if (!String(privacyUrl ?? "").startsWith("https://") || !String(termsUrl ?? "").startsWith("https://")) {
    throw new Error("Live Stripe activation requires HTTPS privacy-policy and terms-of-service URLs in the default portal.");
  }
}

const explicitPortalId = argument("--portal-id") ?? config.vars.STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID;
let action = explicitPortalId?.startsWith("bpc_")
  ? stripe("get", `/v1/billing_portal/configurations/${encodeURIComponent(explicitPortalId)}`)
  : configurations.data?.find((item) => item.metadata?.belki_purpose === "subscription_actions");

function actionParams() {
  const params = [
    ["active", "true"],
    ["name", "Belki subscription actions"],
    ["default_return_url", `${origin}/billing`],
    ["metadata[belki_purpose]", "subscription_actions"],
    ["features[subscription_update][enabled]", "true"],
    ["features[subscription_update][default_allowed_updates][0]", "price"],
    ["features[subscription_update][proration_behavior]", "always_invoice"],
    ["features[subscription_update][billing_cycle_anchor]", "unchanged"],
    ["features[subscription_cancel][enabled]", "true"],
    ["features[subscription_cancel][mode]", "at_period_end"],
    ["features[subscription_cancel][proration_behavior]", "none"],
    ["features[customer_update][enabled]", "true"],
    ["features[customer_update][allowed_updates][0]", "address"],
    ["features[customer_update][allowed_updates][1]", "tax_id"],
    ["features[payment_method_update][enabled]", "true"],
    ["features[invoice_history][enabled]", "true"],
  ];
  prices.forEach((price, index) => {
    params.push(
      [`features[subscription_update][products][${index}][product]`, price.productId],
      [`features[subscription_update][products][${index}][prices][0]`, price.priceId],
      [`features[subscription_update][products][${index}][adjustable_quantity][enabled]`, "false"],
    );
  });
  return params;
}

if (!checkOnly) {
  action = action
    ? stripeCommand(
      ["billing_portal", "configurations", "update", action.id],
      actionParams(),
      { write: true },
    )
    : stripeCommand(
      ["billing_portal", "configurations", "create"],
      actionParams(),
      { write: true, idempotencyKey: `belki-subscription-actions-${mode}-v1` },
    );
}
if (!action) throw new Error("Belki action portal configuration is missing. Run stripe:configure first.");
// Portal configurations are already scoped by the authenticated Stripe
// environment and currently omit `livemode` from API responses. If Stripe
// begins returning it, retain the explicit cross-environment guard.
if (typeof action.livemode === "boolean" && action.livemode !== live) {
  throw new Error("The action portal belongs to the wrong Stripe environment.");
}

const actionProducts = action.features?.subscription_update?.products;
const actionPriceIds = new Set(
  Array.isArray(actionProducts) ? actionProducts.flatMap((product) => product.prices ?? []) : [],
);
const actionFailures = [];
if (!action.active) actionFailures.push("inactive");
if (action.is_default) actionFailures.push("must not be the default portal");
if (action.metadata?.belki_purpose !== "subscription_actions") actionFailures.push("missing purpose metadata");
if (action.default_return_url !== `${origin}/billing`) actionFailures.push("incorrect return URL");
if (action.features?.subscription_update?.enabled !== true) actionFailures.push("subscription updates disabled");
if (action.features?.subscription_update?.proration_behavior !== "always_invoice") {
  actionFailures.push(`upgrade proration=${action.features?.subscription_update?.proration_behavior ?? "missing"}`);
}
if (action.features?.subscription_update?.billing_cycle_anchor !== "unchanged") {
  actionFailures.push(`billing cycle anchor=${action.features?.subscription_update?.billing_cycle_anchor ?? "missing"}`);
}
if (action.features?.subscription_cancel?.enabled !== true) actionFailures.push("cancellation disabled");
if (action.features?.subscription_cancel?.mode !== "at_period_end") {
  actionFailures.push(`cancellation mode=${action.features?.subscription_cancel?.mode ?? "missing"}`);
}
// Stripe's current portal-configuration response omits the Products array even
// when the create/update request accepted it. Validate it when exposed; the
// target Prices themselves are always validated above and passed explicitly by
// Belki's subscription_update_confirm flow.
if (Array.isArray(actionProducts)) {
  const missingActionPrices = prices.filter((price) => !actionPriceIds.has(price.priceId));
  if (missingActionPrices.length) {
    actionFailures.push(`missing Prices=${missingActionPrices.map((price) => price.priceId).join(",")}`);
  }
}
if (actionFailures.length) {
  throw new Error(`Belki action portal ${action.id ?? "unknown"} is invalid: ${actionFailures.join("; ")}.`);
}

console.log(`STRIPE_ENVIRONMENT=${mode}`);
for (const price of prices) console.log(`STRIPE_${price.key.toUpperCase()}_PRICE_ID=${price.priceId}`);
console.log(`STRIPE_BILLING_ACTION_PORTAL_CONFIGURATION_ID=${action.id}`);
console.log(checkOnly ? "Stripe billing configuration check passed." : "Stripe catalogue and action portal configured.");
