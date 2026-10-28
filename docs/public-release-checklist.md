# Public release checklist

This checklist is for the maintainer who approves making the Belki repository
public. It does not authorize a visibility change or a production deployment.

## Repository controls

- [ ] Explicit public-release approval has been recorded.
- [ ] `main` is protected and requires the complete CI workflow.
- [ ] GitHub private vulnerability reporting is enabled.
- [ ] GitHub recognizes `LICENSE` as Apache-2.0.
- [ ] `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE`, and the README render correctly.
- [ ] Issue and pull-request access is configured for the intended maintainer workflow.

## Sensitive-data review

- [x] The tracked tree and all locally available Git refs were scanned for
      secrets on 2026-10-28; see [the review record](release-security-review.md).
- [ ] After fetching all release refs, repeat the scan on the final release
      commit. The local review cannot cover unfetched or deleted remote history.
- [ ] No `.dev.vars`, Cloudflare tokens, API keys, customer data, provider
      payloads, D1 exports, private evaluation fixtures, or production logs are tracked.
- [ ] All URLs, email senders, resource identifiers, and credentials unique to
      Belki's managed service are either non-secret examples or isolated in the
      documented managed deployment profile.
- [ ] Any credential that ever appeared in Git history has been revoked even if
      the commit was later removed.

## Fresh-account installation test

- [ ] Use a separate Cloudflare Workers Paid test account with no pre-existing
      Belki resources.
- [ ] Open the README's Deploy to Cloudflare button while signed into that account.
- [ ] Confirm the installer requests exactly the two documented self-hosted
      secrets: `APP_CRYPTO_KEY` and `BOOTSTRAP_TOKEN`.
- [ ] Confirm one control D1 database, 32 snapshot D1 databases, the R2 bucket,
      queues, Durable Object namespace, Workers AI binding, and static assets are provisioned.
- [ ] Confirm all control and snapshot migrations complete before the Worker is published.
- [ ] Open the generated `workers.dev` URL and complete first-run setup with the
      bootstrap token.
- [ ] Create a project, submit a test prompt, receive or recover its result, and
      verify the Overview report.
- [ ] Apply `pnpm r2:lifecycle` from the generated fork and inspect the resulting rules.
- [ ] Attach a disposable custom domain, set `PUBLIC_APP_ORIGIN`, and verify new
      postback and invitation URLs use only that origin.
- [ ] Confirm self-hosted mode contains no billing flow and works without Stripe secrets.

## Release

- [ ] `pnpm check`, `pnpm types:check`, and `pnpm deploy:dry` pass on the release commit.
- [ ] Documentation matches the exact Cloudflare installer screens observed in
      the fresh-account test.
- [x] Required paid services and the default 33-database topology are stated in
      the README quick start. Confirm any newly discovered installation limitations
      are documented after the fresh-account test.
- [ ] A version tag and release notes identify schema changes and operator actions.
- [ ] The repository visibility change is performed only after final maintainer approval.

After release, repeat the fresh-account test for changes to bindings, required
secrets, migrations, build commands, or the Deploy button.
