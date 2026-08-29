import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const cleanupPath = resolve(import.meta.dirname, "reset-test-payments.sql");
const remote = process.argv.includes("--remote");
const local = process.argv.includes("--local");
const apply = process.argv.includes("--apply");
const auditOnly = process.argv.includes("--audit");
const jsonOutput = process.argv.includes("--json");
const persistIndex = process.argv.indexOf("--persist-to");
const persistPath = persistIndex >= 0 ? process.argv[persistIndex + 1] : undefined;
const confirmationIndex = process.argv.indexOf("--confirm");
const confirmation = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : undefined;
const REQUIRED_CONFIRMATION = "DISCARD-TEST-PAYMENTS";

if (remote === local) throw new Error("Pass exactly one of --remote or --local.");
if (apply === auditOnly) throw new Error("Pass exactly one of --audit or --apply.");
if (persistIndex >= 0 && (!persistPath || remote)) {
  throw new Error("--persist-to requires a directory and is supported only with --local.");
}
if (apply && confirmation !== REQUIRED_CONFIRMATION) {
  throw new Error(`Applying the reset requires --confirm ${REQUIRED_CONFIRMATION}.`);
}

const targetArguments = [remote ? "--remote" : "--local"];
if (persistPath) targetArguments.push("--persist-to", resolve(persistPath));

const SUMMARY_SQL = `
SELECT
  (SELECT COUNT(*) FROM payment_provider_accounts
   WHERE environment = 'test') AS test_provider_accounts,
  (SELECT COUNT(*) FROM workspace_billing_subscriptions
   WHERE environment = 'test') AS test_workspace_subscriptions,
  (SELECT COUNT(*) FROM billing_accounts billing
   WHERE billing.stripe_livemode = 0
      OR billing.workspace_id IN (
        SELECT workspace_id FROM workspace_billing_subscriptions
        WHERE environment = 'test'
      )) AS test_billing_accounts,
  (SELECT COUNT(*) FROM billing_checkout_sessions checkout
   WHERE checkout.payment_provider_account_id IN (
       SELECT id FROM payment_provider_accounts WHERE environment = 'test'
     )
     OR checkout.workspace_id IN (
       SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
       UNION
       SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
     )) AS test_checkout_sessions,
  (SELECT COUNT(*) FROM billing_plan_changes change
   WHERE change.payment_provider_account_id IN (
       SELECT id FROM payment_provider_accounts WHERE environment = 'test'
     )
     OR change.workspace_id IN (
       SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
       UNION
       SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
     )) AS test_plan_changes,
  (SELECT COUNT(*) FROM billing_events event
   WHERE event.stripe_livemode = 0
      OR event.payment_environment = 'test'
      OR event.payment_provider_account_id IN (
        SELECT id FROM payment_provider_accounts WHERE environment = 'test'
      )) AS test_billing_events,
  (SELECT COUNT(*) FROM payment_provider_accounts
   WHERE environment = 'live') AS live_provider_accounts,
  (SELECT COUNT(*) FROM workspace_billing_subscriptions
   WHERE environment = 'live') AS live_workspace_subscriptions,
  (SELECT COUNT(*) FROM billing_accounts
   WHERE stripe_livemode = 1) AS live_billing_accounts,
  (SELECT COUNT(*) FROM billing_checkout_sessions checkout
   WHERE checkout.payment_provider_account_id IN (
       SELECT id FROM payment_provider_accounts WHERE environment = 'live'
     )
     OR checkout.workspace_id IN (
       SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 1
       UNION
       SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'live'
     )) AS live_checkout_sessions,
  (SELECT COUNT(*) FROM billing_plan_changes change
   WHERE change.payment_provider_account_id IN (
       SELECT id FROM payment_provider_accounts WHERE environment = 'live'
     )
     OR change.workspace_id IN (
       SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 1
       UNION
       SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'live'
     )) AS live_plan_changes,
  (SELECT COUNT(*) FROM billing_events event
   WHERE event.stripe_livemode = 1
      OR event.payment_environment = 'live'
      OR event.payment_provider_account_id IN (
        SELECT id FROM payment_provider_accounts WHERE environment = 'live'
      )) AS live_billing_events,
  (
    (SELECT COUNT(*) FROM billing_accounts billing
     WHERE billing.payment_mode != 'disabled'
       AND billing.stripe_livemode IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM workspace_billing_subscriptions subscription
         WHERE subscription.workspace_id = billing.workspace_id
       ))
    +
    (SELECT COUNT(*) FROM billing_checkout_sessions checkout
     WHERE (checkout.stripe_session_id IS NOT NULL OR checkout.external_session_id IS NOT NULL)
       AND checkout.payment_provider_account_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM billing_accounts billing
         WHERE billing.workspace_id = checkout.workspace_id
           AND billing.stripe_livemode IN (0, 1)
       )
       AND NOT EXISTS (
         SELECT 1 FROM workspace_billing_subscriptions subscription
         WHERE subscription.workspace_id = checkout.workspace_id
       ))
    +
    (SELECT COUNT(*) FROM billing_plan_changes change
     WHERE change.payment_provider_account_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM billing_accounts billing
         WHERE billing.workspace_id = change.workspace_id
           AND billing.stripe_livemode IN (0, 1)
       )
       AND NOT EXISTS (
         SELECT 1 FROM workspace_billing_subscriptions subscription
         WHERE subscription.workspace_id = change.workspace_id
       ))
    +
    (SELECT COUNT(*) FROM billing_events event
     WHERE event.provider = 'stripe'
       AND event.payment_provider_account_id IS NULL
       AND event.payment_environment IS NULL
       AND event.stripe_livemode IS NULL)
  ) AS ambiguous_payment_records,
  (SELECT COUNT(*) FROM payment_provider_accounts) AS total_provider_accounts,
  (SELECT mode FROM payment_configuration WHERE id = 'installation') AS configuration_mode;
`;

const WORKSPACES_SQL = `
WITH affected_workspaces AS (
  SELECT workspace_id FROM billing_accounts WHERE stripe_livemode = 0
  UNION
  SELECT workspace_id FROM workspace_billing_subscriptions WHERE environment = 'test'
  UNION
  SELECT checkout.workspace_id
  FROM billing_checkout_sessions checkout
  JOIN payment_provider_accounts account
    ON account.id = checkout.payment_provider_account_id
  WHERE account.environment = 'test'
  UNION
  SELECT change.workspace_id
  FROM billing_plan_changes change
  JOIN payment_provider_accounts account
    ON account.id = change.payment_provider_account_id
  WHERE account.environment = 'test'
  UNION
  SELECT workspace_id FROM billing_events
  WHERE workspace_id IS NOT NULL
    AND (stripe_livemode = 0 OR payment_environment = 'test')
)
SELECT workspace.id, workspace.name, workspace.status, workspace.plan_key,
  billing.payment_mode, billing.status AS billing_status,
  billing.stripe_livemode,
  GROUP_CONCAT(subscription.external_subscription_id) AS test_subscription_ids
FROM affected_workspaces affected
JOIN workspaces workspace ON workspace.id = affected.workspace_id
LEFT JOIN billing_accounts billing ON billing.workspace_id = workspace.id
LEFT JOIN workspace_billing_subscriptions subscription
  ON subscription.workspace_id = workspace.id AND subscription.environment = 'test'
GROUP BY workspace.id, workspace.name, workspace.status, workspace.plan_key,
  billing.payment_mode, billing.status, billing.stripe_livemode
ORDER BY workspace.created_at, workspace.id;
`;

const ACCOUNTS_SQL = `
SELECT account.id, account.provider, account.label, account.environment,
  account.status, account.is_default, account.credential_source,
  COUNT(mapping.billing_plan_id) AS mapped_plans
FROM payment_provider_accounts account
LEFT JOIN payment_provider_plan_mappings mapping
  ON mapping.provider_account_id = account.id
GROUP BY account.id, account.provider, account.label, account.environment,
  account.status, account.is_default, account.credential_source
ORDER BY account.environment, account.is_default DESC, account.created_at, account.id;
`;

function executeJson(sql) {
  const args = [
    wrangler,
    "d1", "execute", "CONTROL_DB",
    ...targetArguments,
    "--yes", "--json",
    "--command", sql,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("D1 payment reset command failed.");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Wrangler returned non-JSON output: ${result.stdout.slice(0, 500)}`);
  }
}

function executeFile(file) {
  const args = [
    wrangler,
    "d1", "execute", "CONTROL_DB",
    ...targetArguments,
    "--yes", "--json", "--file", file,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error("D1 payment reset command failed.");
  }
}

function resultRows(value) {
  const rows = [];
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry.results)) rows.push(...entry.results);
  };
  visit(value);
  return rows;
}

function numeric(summary, key) {
  return Number(summary[key] ?? 0);
}

function collectAudit() {
  const summary = resultRows(executeJson(SUMMARY_SQL))[0];
  if (!summary) throw new Error("The payment reset audit returned no summary row. Apply migrations first.");
  const workspaces = resultRows(executeJson(WORKSPACES_SQL));
  const accounts = resultRows(executeJson(ACCOUNTS_SQL));
  const testKeys = [
    "test_provider_accounts",
    "test_workspace_subscriptions",
    "test_billing_accounts",
    "test_checkout_sessions",
    "test_plan_changes",
    "test_billing_events",
  ];
  const liveKeys = [
    "live_provider_accounts",
    "live_workspace_subscriptions",
    "live_billing_accounts",
    "live_checkout_sessions",
    "live_plan_changes",
    "live_billing_events",
  ];
  const resettableRows = testKeys.reduce((total, key) => total + numeric(summary, key), 0);
  const liveRows = liveKeys.reduce((total, key) => total + numeric(summary, key), 0);
  const ambiguousRows = numeric(summary, "ambiguous_payment_records");
  return {
    target: remote ? "remote" : "local",
    safe: liveRows === 0 && ambiguousRows === 0,
    resettableRows,
    liveRows,
    ambiguousRows,
    summary,
    workspaces,
    accounts,
  };
}

function printAudit(audit) {
  console.log(`Test-payment reset audit (${audit.target} CONTROL_DB)`);
  console.log(`  Payment configuration: ${audit.summary.configuration_mode ?? "missing"}`);
  console.log("  Resettable sandbox rows:");
  console.log(`    provider accounts: ${numeric(audit.summary, "test_provider_accounts")}`);
  console.log(`    workspace subscriptions: ${numeric(audit.summary, "test_workspace_subscriptions")}`);
  console.log(`    billing accounts: ${numeric(audit.summary, "test_billing_accounts")}`);
  console.log(`    checkout sessions: ${numeric(audit.summary, "test_checkout_sessions")}`);
  console.log(`    plan changes: ${numeric(audit.summary, "test_plan_changes")}`);
  console.log(`    billing events: ${numeric(audit.summary, "test_billing_events")}`);
  if (audit.workspaces.length) {
    console.log("  Affected workspaces:");
    for (const workspace of audit.workspaces) {
      console.log(
        `    ${workspace.id} | ${workspace.name} | ${workspace.status}/${workspace.plan_key}` +
        ` | billing=${workspace.payment_mode}/${workspace.billing_status}` +
        `${workspace.test_subscription_ids ? ` | subscriptions=${workspace.test_subscription_ids}` : ""}`,
      );
    }
  }
  if (audit.accounts.length) {
    console.log("  Payment accounts:");
    for (const account of audit.accounts) {
      console.log(
        `    ${account.id} | ${account.provider}/${account.environment}` +
        ` | ${account.status} | default=${account.is_default}` +
        ` | credentials=${account.credential_source} | mapped_plans=${account.mapped_plans}`,
      );
    }
  }
  if (audit.safe) {
    console.log("  Safety result: PASS — no live or ambiguous payment state detected.");
  } else {
    console.error(
      `  Safety result: REFUSED — live markers=${audit.liveRows}, ambiguous records=${audit.ambiguousRows}.`,
    );
  }
}

const audit = collectAudit();
if (jsonOutput) console.log(JSON.stringify(audit, null, 2));
else printAudit(audit);

if (!audit.safe) process.exit(2);

if (apply) {
  if (!readFileSync(cleanupPath, "utf8").trim()) throw new Error("Payment reset SQL is empty.");
  // Remote Wrangler uploads SQL files and currently writes progress messages to
  // stdout before its JSON result. The exit status is the authoritative result
  // for this mutation; the independent audit below verifies the final state.
  executeFile(cleanupPath);
  const after = collectAudit();
  const resetComplete = after.safe
    && after.resettableRows === 0
    && numeric(after.summary, "total_provider_accounts") === 0
    && after.summary.configuration_mode === "undecided";
  if (!resetComplete) {
    if (jsonOutput) console.error(JSON.stringify(after, null, 2));
    else printAudit(after);
    throw new Error("The sandbox payment reset did not reach the expected empty state.");
  }
  if (!jsonOutput) {
    console.log("Test payment state removed. Logical plans and non-billing application data were preserved.");
  }
}
