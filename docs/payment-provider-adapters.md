# Payment-provider adapters

Belki resolves payments through installation-level accounts instead of reading
provider credentials from Worker bindings. Stripe and Dodo Payments are both
installed adapters. A fresh installation may configure either one, or choose
the explicit self-hosted/in-house mode and run without Checkout.

## Installation modes

- `undecided`: first-run state; onboarding must choose a path.
- `self_hosted`: internal use with payments and customer Checkout disabled.
- `managed`: one active, verified default account is required for new Checkout
  sessions.

Creating the first payment account or selecting an existing account changes the
installation to `managed`. A self-hosted installation can therefore enable
managed subscriptions later from **Operator → Payments**. Switching back to
self-hosted is rejected while subscriptions, open Checkout sessions, or plan
changes are active.

`DEPLOYMENT_MODE` still controls the deployment's security posture and
`PAYMENT_MODE` remains an infrastructure kill switch. Use `enabled` for a
managed deployment and `disabled` for self-hosted. Historical non-disabled
values remain backward compatible; the database default account—not this
variable—selects Stripe or Dodo.

## Sources of truth

- `payment_provider_accounts`: provider, environment, adapter version, status,
  webhook key, and non-secret configuration.
- `payment_provider_credentials`: versioned AES-GCM ciphertext. Plaintext is
  never returned by the API.
- `billing_plans`: the installation-owned logical catalogue: names, order,
  presentation metadata, usage limits, and allowed tracking sources.
- `payment_provider_plan_mappings`: one mapping from each logical plan to each
  account's Price/Product ID, currency, and integer minor-unit amount.
- `payment_provider_plan_catalog`: read-only legacy compatibility data migrated
  into the dynamic mapping table.
- `payment_configuration`: installation mode and the default account for new
  Checkout sessions.
- `workspace_billing_subscriptions`: the account and external identifiers that
  own an existing workspace subscription.

`billing_accounts` remains a compatibility/read-model projection. It must not be
used to choose credentials or a provider.

## Adapter contract

Every adapter in `src/worker/payments` implements:

- account and dynamic-catalogue validation, including the configured currency
  and amount for every provider Price/Product;
- hosted Checkout creation;
- subscription retrieval and neutral normalization;
- customer management, paid plan changes, and cancellation/reactivation;
- scheduled downgrades and release;
- signed webhook verification and neutral event translation.

Checkout expiration is an optional capability because Dodo does not publish a
manual Checkout-expiration endpoint. Belki reuses an existing Dodo Checkout for
the same plan and refuses to replace an open one with a different plan rather
than allowing two payable sessions.

Provider payloads are normalized before billing state or entitlements are
updated. Webhook events are deduplicated by provider account plus external event
ID. Changing the installation default affects new Checkout sessions only;
existing subscriptions stay pinned to their original account, allowing Stripe
and Dodo to operate side by side.

## Stripe mapping

Stripe accounts store the server secret key, endpoint signing secret, one ISO
4217 billing currency, one monthly Price ID and amount per active installation
plan, and the non-default
Customer Portal configuration used for billing actions. The adapter verifies
that every Stripe Price matches the account-specific currency and amount. It
uses Checkout Sessions, Customer Portal, Subscription Schedules, automatic tax,
and Stripe-signed webhooks.

## Dodo Payments mapping

Dodo accounts store an API key, Standard Webhooks secret, one ISO 4217 billing
currency, and one monthly Product ID and amount per active installation plan. Account verification checks
that every mapped product matches the account-specific currency and amount and
is monthly recurring and tax-exclusive. The adapter uses:

- `POST /checkouts` for hosted subscription Checkout;
- customer portal sessions for payment method and cancellation management;
- `POST /subscriptions/{id}/change-plan` for immediate paid upgrades and
  next-billing-date downgrades;
- the scheduled plan-change delete endpoint for cancellation/recovery;
- HMAC-SHA256 Standard Webhooks verification over the exact raw body.

Enable Dodo's **Collect Plan Change Payments by Payment Link** capability when
managed customers may upgrade. Configure the account-specific webhook URL for
at least payment succeeded/failed/cancelled and subscription active, renewed,
on-hold, failed, cancelled, expired, plan-changed, and updated events.

## Legacy Stripe cutover

The legacy `/api/webhooks/stripe` route and Worker-binding resolver are migration
bridges. Use **Import current Stripe configuration**, move the Stripe webhook to
the account-specific `/api/webhooks/payments/{endpoint-key}` URL, test it, then
remove the old Stripe Worker variables and secrets. The legacy import is always
optional during onboarding; an operator may configure Dodo instead.

For an unpublished installation whose complete payment history is disposable
sandbox data, `pnpm deploy:guided -- --target getbelki
--reset-test-payments` deliberately removes that test billing state after an
audit and recovery bookmark. It refuses live or ambiguous records, preserves
the installation's logical plans and all non-billing application data, and
returns payments to `undecided`. This is a pre-launch reset, not a customer
subscription migration mechanism. It does not cancel provider-side objects;
remove the printed test subscription and legacy webhook in Stripe separately.

## Adding another provider

Rebill, Polar, or another provider can be added without changing billing route
ownership. Add its typed provider ID, credential and catalogue schemas, declare
its capabilities, implement the neutral adapter contract, register the adapter,
and cover catalogue, Checkout, subscription, and webhook normalization with
contract tests. Rebill and Polar currently appear as disabled **Coming soon**
roadmap entries; they remain outside the persisted provider enum, API contracts,
and adapter registry until their implementations are complete and verified.

If a provider lacks a lifecycle operation, extend the relevant capability guard
and disable that Belki action before registering it; otherwise it must implement
the complete current contract. Provider-specific IDs and payloads remain inside
the adapter, while subscriptions remain pinned to the account that created them.
