import type {
  CaptureProvider,
  CaptureProviderAccountInput,
  CaptureProviderCredentialInput,
  TrackingSource,
} from "../../shared/contracts";
import {
  CAPTURE_PROVIDER_LABELS,
  CAPTURE_PROVIDER_PRIORITY,
  CAPTURE_PROVIDER_SOURCES,
  captureProviderSupportsSource,
} from "../../shared/capture-providers";
import { TRACKING_SOURCES } from "../../shared/tracking-sources";
import {
  summarizeCaptureProviderActivity,
  type CaptureProviderActivityRow,
} from "../../shared/provider-activity";
import { ApiError, nowIso } from "../lib/http";
import {
  decryptProviderCredential,
  encryptProviderCredential,
} from "../lib/provider-credential-vault";
import { CAPTURE_PROVIDER_ADAPTERS } from "./registry";

interface CaptureProviderAccountRow {
  id: string;
  provider: CaptureProvider;
  label: string;
  status: "active" | "disabled";
  credential_source: "environment" | "database";
  active_credential_version: number | null;
  is_default: number;
  priority: number;
  last_test_status: "passed" | "failed" | null;
  last_tested_at: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CaptureProviderRouteRow {
  tracking_source: TrackingSource;
  enabled: number;
  provider_account_id: string | null;
  updated_at: string;
}

interface CredentialRow {
  algorithm: "aes-256-gcm-hkdf-sha256";
  ciphertext: string;
  nonce: string;
}

export interface ResolvedCaptureProviderAccount {
  accountId: string;
  provider: CaptureProvider;
  label: string;
  adapterVersion: string;
  credentialVersion: number | null;
  credentials: CaptureProviderCredentialInput;
}

export interface CaptureProviderJobRoute {
  providerAccountId: string;
  provider: CaptureProvider;
  adapterVersion: string;
  credentialVersion: number | null;
  attemptId: string;
}

function environmentConfigured(env: Env, account: CaptureProviderAccountRow): boolean {
  const legacyEnv = env as unknown as Record<string, unknown>;
  const login = legacyEnv.DATAFORSEO_LOGIN;
  const password = legacyEnv.DATAFORSEO_PASSWORD;
  return account.provider === "dataforseo"
    && account.credential_source === "environment"
    && typeof login === "string"
    && login.length > 0
    && typeof password === "string"
    && password.length > 0;
}

function accountConfigured(env: Env, account: CaptureProviderAccountRow): boolean {
  return account.credential_source === "database"
    ? account.active_credential_version !== null
    : environmentConfigured(env, account);
}

function publicAccount(env: Env, account: CaptureProviderAccountRow) {
  return {
    id: account.id,
    provider: account.provider,
    providerLabel: CAPTURE_PROVIDER_LABELS[account.provider],
    label: account.label,
    status: account.status,
    credentialSource: account.credential_source,
    credentialConfigured: accountConfigured(env, account),
    credentialVersion: account.active_credential_version,
    isDefault: account.is_default === 1,
    priority: account.priority,
    supportedSources: CAPTURE_PROVIDER_SOURCES[account.provider],
    adapterVersion: CAPTURE_PROVIDER_ADAPTERS[account.provider].version,
    lastTestStatus: account.last_test_status,
    lastTestedAt: account.last_tested_at,
    lastTestMessage: account.last_test_message,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

async function accountRows(env: Env): Promise<CaptureProviderAccountRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, status, credential_source,
      active_credential_version, is_default, priority, last_test_status,
      last_tested_at, last_test_message, created_at, updated_at
     FROM capture_provider_accounts
     ORDER BY is_default DESC, priority, created_at, id`,
  ).all<CaptureProviderAccountRow>();
  return result.results;
}

async function routeRows(env: Env): Promise<CaptureProviderRouteRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT tracking_source, enabled, provider_account_id, updated_at
     FROM capture_provider_routes ORDER BY tracking_source`,
  ).all<CaptureProviderRouteRow>();
  return result.results;
}

function routeCandidates(
  source: TrackingSource,
  route: CaptureProviderRouteRow | undefined,
  accounts: CaptureProviderAccountRow[],
): CaptureProviderAccountRow[] {
  const active = accounts.filter(
    (account) => account.status === "active"
      && captureProviderSupportsSource(account.provider, source),
  );
  const preferred = route?.provider_account_id
    ? active.find((account) => account.id === route.provider_account_id)
    : active.find((account) => account.is_default === 1);
  return [
    ...(preferred ? [preferred] : []),
    ...active.filter((account) => account.id !== preferred?.id),
  ].sort((left, right) => {
    if (left.id === preferred?.id) return -1;
    if (right.id === preferred?.id) return 1;
    return left.priority - right.priority || left.created_at.localeCompare(right.created_at);
  });
}

export async function captureProviderConfiguration(env: Env) {
  const [accounts, routes] = await Promise.all([accountRows(env), routeRows(env)]);
  return {
    providers: Object.values(CAPTURE_PROVIDER_ADAPTERS).map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      version: adapter.version,
      priority: adapter.priority,
      supportedSources: adapter.supportedSources,
    })),
    accounts: accounts.map((account) => publicAccount(env, account)),
    routes: TRACKING_SOURCES.map((source) => {
      const route = routes.find((value) => value.tracking_source === source);
      const effective = routeCandidates(source, route, accounts).find((account) =>
        accountConfigured(env, account)
      );
      return {
        trackingSource: source,
        enabled: route?.enabled === 1,
        providerAccountId: route?.provider_account_id ?? null,
        effectiveProviderAccountId: effective?.id ?? null,
        updatedAt: route?.updated_at ?? null,
      };
    }),
  };
}


export async function captureProviderActivity(env: Env) {
  const to = nowIso();
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = await env.CONTROL_DB.prepare(
    `SELECT attempt.provider_account_id, attempt.provider, job.tracking_source,
      COUNT(*) AS attempts,
      SUM(CASE WHEN attempt.submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN attempt.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN attempt.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN attempt.status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN attempt.status IN (
        'queued', 'submitting', 'accepted', 'awaiting_result', 'normalizing'
      ) THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN attempt.status = 'completed'
        AND attempt.submitted_at IS NOT NULL AND attempt.completed_at IS NOT NULL
        THEN 1 ELSE 0 END) AS latency_samples,
      COALESCE(SUM(CASE WHEN attempt.status = 'completed'
        AND attempt.submitted_at IS NOT NULL AND attempt.completed_at IS NOT NULL
        THEN MAX(0, (julianday(attempt.completed_at) - julianday(attempt.submitted_at)) * 86400000)
        ELSE 0 END), 0) AS latency_total_ms,
      MAX(attempt.updated_at) AS last_activity_at
     FROM capture_provider_attempts attempt
     JOIN crawl_jobs job ON job.id = attempt.crawl_job_id
     WHERE attempt.created_at >= ? AND attempt.created_at <= ?
     GROUP BY attempt.provider_account_id, attempt.provider, job.tracking_source
     ORDER BY attempt.provider, attempt.provider_account_id, job.tracking_source`,
  ).bind(from, to).all<CaptureProviderActivityRow>();
  return summarizeCaptureProviderActivity(rows.results, { from, to });
}

export async function hasConfiguredCaptureProvider(env: Env): Promise<boolean> {
  return (await accountRows(env)).some(
    (account) => account.status === "active" && accountConfigured(env, account),
  );
}

async function decryptDatabaseCredential(
  env: Env,
  account: CaptureProviderAccountRow,
  credentialVersion?: number | null,
): Promise<CaptureProviderCredentialInput> {
  const version = credentialVersion ?? account.active_credential_version;
  if (version === null) {
    throw new ApiError(503, "provider_credentials_missing", "Provider credentials are not configured.");
  }
  const credential = await env.CONTROL_DB.prepare(
    `SELECT algorithm, ciphertext, nonce
     FROM capture_provider_credentials
     WHERE provider_account_id = ? AND version = ? AND revoked_at IS NULL`,
  ).bind(account.id, version).first<CredentialRow>();
  if (!credential) {
    throw new ApiError(503, "provider_credentials_missing", "Provider credentials are not configured.");
  }
  return decryptProviderCredential(
    env.APP_CRYPTO_KEY,
    {
      accountId: account.id,
      provider: account.provider,
      version,
    },
    credential,
  );
}

async function resolvedAccount(
  env: Env,
  account: CaptureProviderAccountRow,
  credentialVersion?: number | null,
): Promise<ResolvedCaptureProviderAccount> {
  const credentials: CaptureProviderCredentialInput = account.credential_source === "environment"
    ? {
        provider: "dataforseo",
        credentials: {
          login: String(Reflect.get(env, "DATAFORSEO_LOGIN") ?? ""),
          password: String(Reflect.get(env, "DATAFORSEO_PASSWORD") ?? ""),
        },
      }
    : await decryptDatabaseCredential(env, account, credentialVersion);
  return {
    accountId: account.id,
    provider: account.provider,
    label: account.label,
    adapterVersion: CAPTURE_PROVIDER_ADAPTERS[account.provider].version,
    credentialVersion: account.active_credential_version,
    credentials,
  };
}

export async function resolveCaptureProviderAccount(
  env: Env,
  source: TrackingSource,
): Promise<ResolvedCaptureProviderAccount> {
  const [accounts, routes] = await Promise.all([accountRows(env), routeRows(env)]);
  const route = routes.find((value) => value.tracking_source === source);
  if (route && route.enabled !== 1) {
    throw new ApiError(409, "tracking_source_disabled", "This tracking platform is disabled.");
  }
  const account = routeCandidates(source, route, accounts).find((candidate) =>
    accountConfigured(env, candidate)
  );
  if (!account) {
    throw new ApiError(
      503,
      "capture_provider_unavailable",
      `No active capture provider is configured for ${source}.`,
    );
  }
  return resolvedAccount(env, account);
}

export async function resolveCaptureProviderByProvider(
  env: Env,
  provider: CaptureProvider,
): Promise<ResolvedCaptureProviderAccount> {
  const account = (await accountRows(env))
    .filter((candidate) =>
      candidate.provider === provider
      && candidate.status === "active"
      && accountConfigured(env, candidate)
    )
    .sort((left, right) =>
      right.is_default - left.is_default
      || left.priority - right.priority
      || left.created_at.localeCompare(right.created_at)
    )[0];
  if (!account) {
    throw new ApiError(
      503,
      "capture_provider_unavailable",
      `No active ${CAPTURE_PROVIDER_LABELS[provider]} account is configured.`,
    );
  }
  return resolvedAccount(env, account);
}

export async function hasConfiguredCaptureProviderType(
  env: Env,
  provider: CaptureProvider,
): Promise<boolean> {
  return (await accountRows(env)).some((account) =>
    account.provider === provider
    && account.status === "active"
    && accountConfigured(env, account)
  );
}

export function captureProviderJobRoute(
  account: ResolvedCaptureProviderAccount,
): CaptureProviderJobRoute {
  return {
    providerAccountId: account.accountId,
    provider: account.provider,
    adapterVersion: account.adapterVersion,
    credentialVersion: account.credentialVersion,
    attemptId: crypto.randomUUID(),
  };
}

export function prepareCaptureProviderAttempt(
  db: D1Database,
  jobId: string,
  route: CaptureProviderJobRoute,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO capture_provider_attempts (
      id, crawl_job_id, provider_account_id, provider, role, attempt_number,
      status, adapter_version, credential_version, created_at, updated_at
    ) SELECT ?, ?, ?, ?, 'primary', 1, 'queued', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM crawl_jobs WHERE id = ?)`,
  ).bind(
    route.attemptId,
    jobId,
    route.providerAccountId,
    route.provider,
    route.adapterVersion,
    route.credentialVersion,
    createdAt,
    createdAt,
    jobId,
  );
}

export async function createCaptureProviderAccount(
  env: Env,
  input: CaptureProviderAccountInput,
  userId: string,
  test: { status: "passed" | "failed"; message: string },
) {
  if (test.status !== "passed") {
    throw new ApiError(422, "provider_credentials_rejected", test.message);
  }
  const id = crypto.randomUUID();
  const version = 1;
  const now = nowIso();
  const shouldBecomeDefault = !(await hasConfiguredCaptureProvider(env));
  const encrypted = await encryptProviderCredential(
    env.APP_CRYPTO_KEY,
    { accountId: id, provider: input.provider, version },
    { provider: input.provider, credentials: input.credentials } as CaptureProviderCredentialInput,
  );
  const statements: D1PreparedStatement[] = [];
  if (shouldBecomeDefault) {
    statements.push(
      env.CONTROL_DB.prepare(
        "UPDATE capture_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
      ).bind(now),
    );
  }
  statements.push(
    env.CONTROL_DB.prepare(
      `INSERT INTO capture_provider_accounts (
        id, provider, label, status, credential_source, active_credential_version,
        is_default, priority, last_test_status, last_tested_at, last_test_message,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', 'database', ?, ?, ?, 'passed', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.provider,
      input.label,
      version,
      shouldBecomeDefault ? 1 : 0,
      CAPTURE_PROVIDER_PRIORITY[input.provider],
      now,
      test.message,
      userId,
      userId,
      now,
      now,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO capture_provider_credentials (
        provider_account_id, version, algorithm, ciphertext, nonce,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      version,
      encrypted.algorithm,
      encrypted.ciphertext,
      encrypted.nonce,
      userId,
      now,
    ),
  );
  await env.CONTROL_DB.batch(statements);
  const account = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, status, credential_source,
      active_credential_version, is_default, priority, last_test_status,
      last_tested_at, last_test_message, created_at, updated_at
     FROM capture_provider_accounts WHERE id = ?`,
  ).bind(id).first<CaptureProviderAccountRow>();
  if (!account) throw new Error("Created provider account could not be loaded");
  return publicAccount(env, account);
}

export async function replaceCaptureProviderCredential(
  env: Env,
  accountId: string,
  input: CaptureProviderCredentialInput,
  userId: string,
  test: { status: "passed" | "failed"; message: string },
) {
  const account = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, status, credential_source,
      active_credential_version, is_default, priority, last_test_status,
      last_tested_at, last_test_message, created_at, updated_at
     FROM capture_provider_accounts WHERE id = ?`,
  ).bind(accountId).first<CaptureProviderAccountRow>();
  if (!account) throw new ApiError(404, "provider_account_not_found", "Provider account not found.");
  if (account.provider !== input.provider) {
    throw new ApiError(409, "provider_mismatch", "Credentials do not match this provider account.");
  }
  if (test.status !== "passed") {
    await recordCaptureProviderTest(env, accountId, test);
    throw new ApiError(422, "provider_credentials_rejected", test.message);
  }
  const version = (account.active_credential_version ?? 0) + 1;
  const now = nowIso();
  const encrypted = await encryptProviderCredential(
    env.APP_CRYPTO_KEY,
    { accountId, provider: account.provider, version },
    input,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO capture_provider_credentials (
        provider_account_id, version, algorithm, ciphertext, nonce,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      version,
      encrypted.algorithm,
      encrypted.ciphertext,
      encrypted.nonce,
      userId,
      now,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE capture_provider_accounts SET credential_source = 'database',
        active_credential_version = ?, last_test_status = 'passed', last_tested_at = ?,
        last_test_message = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(version, now, test.message, userId, now, accountId),
  ]);
  return { id: accountId, credentialVersion: version, ...test };
}

export async function recordCaptureProviderTest(
  env: Env,
  accountId: string,
  test: { status: "passed" | "failed"; message: string },
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE capture_provider_accounts SET last_test_status = ?, last_tested_at = ?,
      last_test_message = ?, updated_at = ? WHERE id = ?`,
  ).bind(test.status, nowIso(), test.message, nowIso(), accountId).run();
}

export async function setDefaultCaptureProviderAccount(
  env: Env,
  accountId: string,
  userId: string,
): Promise<void> {
  const account = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, status, credential_source,
      active_credential_version, is_default, priority, last_test_status,
      last_tested_at, last_test_message, created_at, updated_at
     FROM capture_provider_accounts WHERE id = ?`,
  ).bind(accountId).first<CaptureProviderAccountRow>();
  if (!account) throw new ApiError(404, "provider_account_not_found", "Provider account not found.");
  if (account.status !== "active" || !accountConfigured(env, account)) {
    throw new ApiError(409, "provider_account_unavailable", "Only an active, configured account can be the default.");
  }
  const now = nowIso();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE capture_provider_accounts SET is_default = 0, updated_at = ? WHERE is_default = 1",
    ).bind(now),
    env.CONTROL_DB.prepare(
      `UPDATE capture_provider_accounts SET is_default = 1,
        updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(userId, now, accountId),
  ]);
}

export async function updateCaptureProviderAccount(
  env: Env,
  accountId: string,
  input: { label?: string; status?: "active" | "disabled" },
  userId: string,
): Promise<void> {
  const account = await env.CONTROL_DB.prepare(
    "SELECT id, is_default FROM capture_provider_accounts WHERE id = ?",
  ).bind(accountId).first<{ id: string; is_default: number }>();
  if (!account) throw new ApiError(404, "provider_account_not_found", "Provider account not found.");
  if (input.status === "disabled" && account.is_default === 1) {
    throw new ApiError(409, "default_provider_cannot_be_disabled", "Choose another default before disabling this account.");
  }
  if (input.status === "disabled") {
    const route = await env.CONTROL_DB.prepare(
      "SELECT tracking_source FROM capture_provider_routes WHERE provider_account_id = ? LIMIT 1",
    ).bind(accountId).first<{ tracking_source: string }>();
    if (route) {
      throw new ApiError(409, "routed_provider_cannot_be_disabled", `Remove the ${route.tracking_source} override before disabling this account.`);
    }
  }
  await env.CONTROL_DB.prepare(
    `UPDATE capture_provider_accounts SET label = COALESCE(?, label),
      status = COALESCE(?, status), updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
  ).bind(input.label ?? null, input.status ?? null, userId, nowIso(), accountId).run();
}

export async function updateCaptureProviderRoute(
  env: Env,
  source: TrackingSource,
  input: { enabled?: boolean; providerAccountId?: string | null },
  userId: string,
): Promise<void> {
  if (input.providerAccountId) {
    const account = await env.CONTROL_DB.prepare(
      `SELECT id, provider, label, status, credential_source,
        active_credential_version, is_default, priority, last_test_status,
        last_tested_at, last_test_message, created_at, updated_at
       FROM capture_provider_accounts WHERE id = ?`,
    ).bind(input.providerAccountId).first<CaptureProviderAccountRow>();
    if (!account) throw new ApiError(404, "provider_account_not_found", "Provider account not found.");
    if (
      account.status !== "active"
      || !accountConfigured(env, account)
      || !captureProviderSupportsSource(account.provider, source)
    ) {
      throw new ApiError(409, "provider_account_incompatible", "This provider account cannot serve that platform.");
    }
  }
  const now = nowIso();
  await env.CONTROL_DB.prepare(
    `INSERT INTO capture_provider_routes (
      tracking_source, enabled, provider_account_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracking_source) DO UPDATE SET
      enabled = COALESCE(?, capture_provider_routes.enabled),
      provider_account_id = CASE WHEN ? THEN ? ELSE capture_provider_routes.provider_account_id END,
      updated_by_user_id = ?, updated_at = ?`,
  ).bind(
    source,
    input.enabled === false ? 0 : 1,
    input.providerAccountId ?? null,
    userId,
    now,
    now,
    input.enabled === undefined ? null : input.enabled ? 1 : 0,
    input.providerAccountId !== undefined ? 1 : 0,
    input.providerAccountId ?? null,
    userId,
    now,
  ).run();
}

export async function loadCaptureProviderCredential(
  env: Env,
  accountId: string,
  credentialVersion?: number | null,
): Promise<CaptureProviderCredentialInput> {
  const account = await env.CONTROL_DB.prepare(
    `SELECT id, provider, label, status, credential_source,
      active_credential_version, is_default, priority, last_test_status,
      last_tested_at, last_test_message, created_at, updated_at
     FROM capture_provider_accounts WHERE id = ?`,
  ).bind(accountId).first<CaptureProviderAccountRow>();
  if (!account) throw new ApiError(404, "provider_account_not_found", "Provider account not found.");
  return (await resolvedAccount(env, account, credentialVersion)).credentials;
}
