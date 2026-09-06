#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

TARGET=""
APP_URL=""
ASSUME_YES=0
ALLOW_UNREVIEWED=0
RUN_CHECKS=1
RUN_DRY_RUN=1
RUN_R2_LIFECYCLE=0
RESET_TEST_PAYMENTS=0
RESET_TEST_PAYMENTS_CONFIRMATION=""
MIGRATION_STARTED=0
PAYMENT_RESET_STARTED=0
PAYMENT_RESET_RECOVERY_BOOKMARK=""
CURRENT_STEP="preflight"

usage() {
  printf '%s\n' \
    "Guided Belki deployment" \
    "" \
    "Usage:" \
    "  pnpm deploy:guided -- [options]" \
    "" \
    "Options:" \
    "  --target getbelki|self-hosted  Deployment profile (asked interactively when omitted)." \
    "  --url https://example.com      Public origin used for the post-deploy smoke check." \
    "  --skip-checks                  Skip pnpm check and Wrangler type validation." \
    "  --skip-dry-run                 Skip the Wrangler deployment dry run." \
    "  --with-r2-lifecycle            Apply the checked-in R2 lifecycle after deployment." \
    "  --reset-test-payments          Discard audited sandbox billing after migrations." \
    "  --confirm-reset-test-payments DISCARD-TEST-PAYMENTS" \
    "                                  Non-interactive confirmation for that destructive reset." \
    "  --allow-unreviewed             Allow a dirty tree or non-main GetBelki deployment." \
    "  --yes                          Accept normal confirmations; never bypasses the reset phrase." \
    "  -h, --help                     Show this help." \
    "" \
    "The script never receives provider credentials as command-line arguments. Missing" \
    "Cloudflare secrets are entered through Wrangler's protected prompt, and business" \
    "configuration remains in Belki's authenticated Operator UI."
}

log() {
  printf '\n==> %s\n' "$1"
}

note() {
  printf '    %s\n' "$1"
}

warn() {
  printf 'WARNING: %s\n' "$1" >&2
}

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

run() {
  printf '    $'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

is_interactive() {
  [[ -t 0 && -t 1 ]]
}

confirm() {
  local prompt="$1"
  local answer
  if [[ "${ASSUME_YES}" -eq 1 ]]; then
    return 0
  fi
  if ! is_interactive; then
    die "A confirmation is required. Run from a terminal or pass --yes."
  fi
  read -r -p "${prompt} [y/N] " answer
  case "${answer}" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

on_error() {
  local exit_code=$?
  trap - ERR
  printf '\nDeployment stopped during: %s\n' "${CURRENT_STEP}" >&2
  if [[ "${MIGRATION_STARTED}" -eq 1 ]]; then
    printf '%s\n' \
      "Some or all additive migrations may already be applied." \
      "Do not restore D1 just because deployment stopped; fix the reported error and rerun" \
      "this script. Wrangler migration tracking makes the same migration pass safe to retry." >&2
  fi
  if [[ "${PAYMENT_RESET_STARTED}" -eq 1 && -n "${PAYMENT_RESET_RECOVERY_BOOKMARK}" ]]; then
    printf '%s\n' \
      "The pre-reset CONTROL_DB recovery bookmark is ${PAYMENT_RESET_RECOVERY_BOOKMARK}." \
      "Inspect current state before considering a restore. The authenticated restore command is:" \
      "pnpm exec wrangler d1 time-travel restore CONTROL_DB --bookmark ${PAYMENT_RESET_RECOVERY_BOOKMARK}" >&2
  fi
  exit "${exit_code}"
}

trap on_error ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target requires a value."
      TARGET="$2"
      shift 2
      ;;
    --url)
      [[ $# -ge 2 ]] || die "--url requires a value."
      APP_URL="$2"
      shift 2
      ;;
    --skip-checks)
      RUN_CHECKS=0
      shift
      ;;
    --skip-dry-run)
      RUN_DRY_RUN=0
      shift
      ;;
    --with-r2-lifecycle)
      RUN_R2_LIFECYCLE=1
      shift
      ;;
    --reset-test-payments)
      RESET_TEST_PAYMENTS=1
      shift
      ;;
    --confirm-reset-test-payments)
      [[ $# -ge 2 ]] || die "--confirm-reset-test-payments requires a value."
      RESET_TEST_PAYMENTS_CONFIRMATION="$2"
      shift 2
      ;;
    --allow-unreviewed)
      ALLOW_UNREVIEWED=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

if [[ -n "${RESET_TEST_PAYMENTS_CONFIRMATION}" && "${RESET_TEST_PAYMENTS}" -ne 1 ]]; then
  die "--confirm-reset-test-payments requires --reset-test-payments."
fi

if [[ -z "${TARGET}" ]]; then
  if ! is_interactive; then
    die "Pass --target getbelki or --target self-hosted."
  fi
  printf '%s\n' \
    "Choose a deployment target:" \
    "  1) GetBelki managed profile" \
    "  2) Self-hosted profile"
  read -r -p "Selection [1-2]: " target_choice
  case "${target_choice}" in
    1) TARGET="getbelki" ;;
    2) TARGET="self-hosted" ;;
    *) die "Invalid deployment target." ;;
  esac
fi

case "${TARGET}" in
  getbelki|self-hosted) ;;
  managed) TARGET="getbelki" ;;
  *) die "--target must be getbelki or self-hosted." ;;
esac

cd "${REPO_ROOT}"

log "Preflight"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required. Install the packageManager version declared in package.json."
command -v node >/dev/null 2>&1 || die "Node.js is required."
command -v git >/dev/null 2>&1 || die "Git is required for the release-safety checks."
[[ -f package.json && -f wrangler.jsonc ]] || die "Run this script from the Belki repository."

if [[ ! -d node_modules ]]; then
  note "node_modules is missing."
  if confirm "Install locked dependencies now?"; then
    CURRENT_STEP="dependency installation"
    run pnpm install --frozen-lockfile
  else
    die "Dependencies are required for validation and deployment."
  fi
fi

git_branch="$(git branch --show-current 2>/dev/null || true)"
git_changes="$(git status --short 2>/dev/null || true)"
release_warning=""
if [[ -n "${git_changes}" ]]; then
  release_warning="the working tree has uncommitted changes"
  printf '%s\n' "${git_changes}"
fi
if [[ "${TARGET}" == "getbelki" && "${git_branch}" != "main" ]]; then
  if [[ -n "${release_warning}" ]]; then
    release_warning="${release_warning}, and the current branch is ${git_branch:-detached HEAD}"
  else
    release_warning="the current branch is ${git_branch:-detached HEAD}, not main"
  fi
fi
if [[ -n "${release_warning}" && "${ALLOW_UNREVIEWED}" -ne 1 ]]; then
  warn "Release safety check: ${release_warning}."
  if [[ "${ASSUME_YES}" -eq 1 ]]; then
    die "Use a clean reviewed checkout, or explicitly pass --allow-unreviewed."
  fi
  confirm "Continue with this unreviewed checkout?" || die "Deployment cancelled."
fi

if is_interactive && [[ "${ASSUME_YES}" -ne 1 ]]; then
  if confirm "Configure analytics hosting before deployment?"; then
    if [[ "${TARGET}" == "getbelki" ]]; then
      run pnpm configure:analytics -- --profile deployment/getbelki.json
    else
      run pnpm configure:analytics
    fi
  fi
fi

CURRENT_STEP="Cloudflare authentication"
run pnpm exec wrangler whoami

check_required_secrets() {
  local secret_json
  local missing
  secret_json="$(pnpm exec wrangler secret list --format json)"
  missing="$(node -e '
    const configured = new Set(JSON.parse(process.argv[1]).map((entry) => entry.name));
    process.stdout.write(["APP_CRYPTO_KEY", "BOOTSTRAP_TOKEN"]
      .filter((name) => !configured.has(name)).join("\n"));
  ' "${secret_json}")"
  printf '%s' "${missing}"
}

CURRENT_STEP="required secret verification"
missing_secrets="$(check_required_secrets)"
if [[ -n "${missing_secrets}" ]]; then
  warn "Required Worker secrets are missing."
  while IFS= read -r secret_name; do
    [[ -n "${secret_name}" ]] || continue
    if [[ "${ASSUME_YES}" -eq 1 ]] || ! is_interactive; then
      printf '  - %s\n' "${secret_name}" >&2
      continue
    fi
    if [[ "${secret_name}" == "APP_CRYPTO_KEY" ]]; then
      warn "For an existing installation, enter the original APP_CRYPTO_KEY. Replacing it makes stored provider credentials unreadable."
    fi
    if confirm "Configure ${secret_name} now through Wrangler's protected prompt?"; then
      run pnpm exec wrangler secret put "${secret_name}"
    fi
  done <<< "${missing_secrets}"
  missing_secrets="$(check_required_secrets)"
  if [[ -n "${missing_secrets}" ]]; then
    printf '%s\n' "Still missing required secrets:" >&2
    while IFS= read -r secret_name; do
      [[ -n "${secret_name}" ]] && printf '  - %s\n' "${secret_name}" >&2
    done <<< "${missing_secrets}"
    die "Configure the required secrets and rerun the guided deployment."
  fi
fi
note "Required Worker secret names are present. Values were not read."

if [[ "${RUN_CHECKS}" -eq 1 ]]; then
  log "Application validation"
  CURRENT_STEP="application checks"
  run pnpm check
  CURRENT_STEP="Wrangler type validation"
  run pnpm types:check
else
  warn "Application checks were skipped by request."
fi

if [[ "${RUN_DRY_RUN}" -eq 1 ]]; then
  log "Deployment dry run"
  CURRENT_STEP="deployment dry run"
  if [[ "${TARGET}" == "getbelki" ]]; then
    run pnpm deploy:getbelki:dry
  else
    run pnpm deploy:dry
  fi
else
  warn "Deployment dry run was skipped by request."
fi

log "Remote migration preview"
CURRENT_STEP="migration preview"
run pnpm exec wrangler d1 migrations list CONTROL_DB --remote
run pnpm exec wrangler d1 migrations list SNAPSHOT_DB_00 --remote
run pnpm exec wrangler d1 migrations list SNAPSHOT_DB_31 --remote

printf '\nRelease summary:\n'
printf '  Target: %s\n' "${TARGET}"
printf '%s\n' \
  "  Database: CONTROL_DB plus 32 snapshot shards" \
  "  Order: checks -> additive migrations -> schema verification -> Worker deployment"
if [[ "${RUN_R2_LIFECYCLE}" -eq 1 ]]; then
  printf '%s\n' "  R2 lifecycle: apply checked-in policy after deployment"
else
  printf '%s\n' "  R2 lifecycle: unchanged"
fi
if [[ "${RESET_TEST_PAYMENTS}" -eq 1 ]]; then
  printf '%s\n' "  Payments: audit and discard test-only billing after recording a recovery bookmark"
else
  printf '%s\n' "  Payments: preserve and migrate existing billing state"
fi

confirm "Apply remote migrations and publish this release?" || die "Deployment cancelled before changing remote state."

log "Applying remote D1 migrations"
CURRENT_STEP="remote D1 migrations"
MIGRATION_STARTED=1
run pnpm db:migrate:remote -- --yes

log "Verifying provider and billing schema"
CURRENT_STEP="post-migration schema verification"
schema_query="SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('capture_provider_accounts', 'capture_provider_attempts', 'payment_provider_accounts', 'payment_configuration', 'billing_plans', 'payment_provider_plan_mappings') ORDER BY name"
run pnpm exec wrangler d1 execute CONTROL_DB --remote --yes --command "${schema_query}"
run pnpm exec wrangler d1 migrations list CONTROL_DB --remote
run pnpm exec wrangler d1 migrations list SNAPSHOT_DB_00 --remote
run pnpm exec wrangler d1 migrations list SNAPSHOT_DB_31 --remote

if [[ "${RESET_TEST_PAYMENTS}" -eq 1 ]]; then
  log "Auditing sandbox payment state"
  CURRENT_STEP="test payment reset audit"
  run node scripts/reset-test-payments.mjs --remote --audit

  log "Recording the pre-reset D1 recovery bookmark"
  CURRENT_STEP="test payment reset recovery bookmark"
  payment_reset_bookmark_json="$(
    node node_modules/wrangler/bin/wrangler.js \
      d1 time-travel info CONTROL_DB --json
  )"
  PAYMENT_RESET_RECOVERY_BOOKMARK="$(node -e '
    const result = JSON.parse(process.argv[1]);
    process.stdout.write(String(result.bookmark ?? ""));
  ' "${payment_reset_bookmark_json}")"
  [[ -n "${PAYMENT_RESET_RECOVERY_BOOKMARK}" ]] || die "Cloudflare did not return a CONTROL_DB recovery bookmark."
  note "Recovery bookmark: ${PAYMENT_RESET_RECOVERY_BOOKMARK}"
  note "Restore only after inspecting an actual reset failure: pnpm exec wrangler d1 time-travel restore CONTROL_DB --bookmark ${PAYMENT_RESET_RECOVERY_BOOKMARK}"

  if [[ "${RESET_TEST_PAYMENTS_CONFIRMATION}" != "DISCARD-TEST-PAYMENTS" ]]; then
    if ! is_interactive; then
      die "The test-payment reset requires --confirm-reset-test-payments DISCARD-TEST-PAYMENTS in a non-interactive run."
    fi
    printf '%s\n' \
      "This permanently removes the audited test subscriptions, Checkout sessions," \
      "plan changes, billing events, test payment accounts, credentials, and mappings." \
      "Projects, prompts, captures, users, logical plan definitions, and R2 objects are not touched."
    read -r -p "Type DISCARD-TEST-PAYMENTS to continue: " RESET_TEST_PAYMENTS_CONFIRMATION
  fi
  [[ "${RESET_TEST_PAYMENTS_CONFIRMATION}" == "DISCARD-TEST-PAYMENTS" ]] || die "Test-payment reset cancelled."

  log "Discarding audited sandbox payment state"
  CURRENT_STEP="test payment reset"
  PAYMENT_RESET_STARTED=1
  run node scripts/reset-test-payments.mjs \
    --remote --apply --confirm DISCARD-TEST-PAYMENTS
fi

log "Migrated configuration state"
CURRENT_STEP="post-migration state inspection"
capture_query="
  SELECT id, provider, status, credential_source, is_default,
    COALESCE(last_test_status, 'not_tested') AS last_test_status
  FROM capture_provider_accounts ORDER BY is_default DESC, priority, id;
  SELECT tracking_source, enabled,
    COALESCE(provider_account_id, 'installation_default') AS provider_account_id
  FROM capture_provider_routes ORDER BY tracking_source;
"
payment_query="
  SELECT configuration.mode, configuration.enabled,
    configuration.default_provider_account_id,
    COUNT(account.id) AS payment_account_count
  FROM payment_configuration configuration
  LEFT JOIN payment_provider_accounts account ON 1 = 1
  WHERE configuration.id = 'installation'
  GROUP BY configuration.mode, configuration.enabled,
    configuration.default_provider_account_id;
  SELECT id, provider, environment, status, credential_source,
    configuration_source, is_default,
    COALESCE(last_test_status, 'not_tested') AS last_test_status
  FROM payment_provider_accounts ORDER BY is_default DESC, created_at, id;
  SELECT provider_account_id, billing_plan_id, currency, amount_minor,
    billing_interval, external_reference
  FROM payment_provider_plan_mappings
  ORDER BY provider_account_id, billing_plan_id;
"
plan_query="
  SELECT id, name, status, monthly_units, project_limit, prompt_limit, source_limit
  FROM billing_plans ORDER BY status, sort_order, id;
"
run pnpm exec wrangler d1 execute CONTROL_DB --remote --yes --command "${capture_query}"
run pnpm exec wrangler d1 execute CONTROL_DB --remote --yes --command "${payment_query}"
run pnpm exec wrangler d1 execute CONTROL_DB --remote --yes --command "${plan_query}"

log "Publishing Worker"
CURRENT_STEP="Worker deployment"
if [[ "${TARGET}" == "getbelki" ]]; then
  run pnpm deploy:getbelki
else
  run pnpm deploy:analytics
  run pnpm exec wrangler deploy
fi

if [[ "${RUN_R2_LIFECYCLE}" -eq 1 ]]; then
  log "Applying R2 lifecycle"
  CURRENT_STEP="R2 lifecycle configuration"
  run pnpm r2:lifecycle
elif is_interactive && [[ "${ASSUME_YES}" -ne 1 ]]; then
  if confirm "Apply the checked-in R2 lifecycle now? This is normally needed only on first deploy or after a policy change."; then
    log "Applying R2 lifecycle"
    CURRENT_STEP="R2 lifecycle configuration"
    run pnpm r2:lifecycle
  fi
fi

if [[ -z "${APP_URL}" && "${TARGET}" == "getbelki" ]]; then
  APP_URL="$(node -e '
    const profile = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(profile.vars?.PUBLIC_APP_ORIGIN ?? ""));
  ' "${REPO_ROOT}/deployment/getbelki.json")"
fi
if [[ -z "${APP_URL}" && "${ASSUME_YES}" -ne 1 ]] && is_interactive; then
  read -r -p "Public app URL for a smoke check (blank to skip): " APP_URL
fi

if [[ -n "${APP_URL}" ]]; then
  case "${APP_URL}" in
    http://*|https://*) ;;
    *) die "The smoke-check URL must start with http:// or https://." ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    log "Public API smoke check"
    CURRENT_STEP="public API smoke check"
    smoke_url="${APP_URL%/}/api/v1/status"
    smoke_response=""
    if smoke_response="$(curl --silent --show-error --location --max-time 20 --write-out $'\n%{http_code}' "${smoke_url}")"; then
      smoke_status="${smoke_response##*$'\n'}"
      smoke_body="${smoke_response%$'\n'*}"
      if [[ "${smoke_status}" == "200" && "${smoke_body}" == *'"data"'* ]]; then
        note "${smoke_url} returned Belki status successfully."
        printf '%s\n' "${smoke_body}"
      else
        warn "${smoke_url} returned HTTP ${smoke_status} or a non-Belki response. Cloudflare Access may require a browser check."
      fi
    else
      warn "The public smoke check could not reach ${smoke_url}. Verify the custom domain and route manually."
    fi
  else
    warn "curl is unavailable; skipping the public smoke check."
  fi
fi

CURRENT_STEP="complete"
printf '\nDeployment completed.\n\n'
printf '%s\n' \
  "Security-sensitive setup intentionally remains in the authenticated Belki UI:" \
  "  1. Review the logical plans before creating the first payment account." \
  "  2. In Operator -> Providers, test the migrated DataForSEO account and use" \
  "     Replace credentials to move legacy Worker credentials into the encrypted vault."
if [[ "${RESET_TEST_PAYMENTS}" -eq 1 ]]; then
  printf '%s\n' \
    "  3. Cancel the discarded subscription and remove its legacy webhook in the Stripe" \
    "     sandbox. The database reset does not mutate objects in Stripe." \
    "  4. In Operator -> Payments, choose self-hosted or configure one new Stripe/Dodo" \
    "     test account. The discarded Stripe account is intentionally not importable." \
    "  5. Copy the new account-specific webhook URL, update the provider dashboard, and" \
    "     run Test before removing legacy Worker secrets."
else
  printf '%s\n' \
    "  3. In Operator -> Payments, choose self-hosted, import legacy Stripe, or configure" \
    "     exactly one Stripe/Dodo account. Currency and provider IDs are set there." \
    "  4. Copy each account-specific webhook URL, update the provider dashboard, and run Test." \
    "  5. Remove legacy Worker secrets only after new crawls and signed test webhooks pass."
fi
if [[ -n "${APP_URL}" ]]; then
  printf '\nOperator links:\n  %s/operator/providers\n  %s/operator/payments\n' "${APP_URL%/}" "${APP_URL%/}"
fi
if [[ -n "${PAYMENT_RESET_RECOVERY_BOOKMARK}" ]]; then
  printf '\nPre-reset CONTROL_DB recovery bookmark: %s\n' "${PAYMENT_RESET_RECOVERY_BOOKMARK}"
fi
