# Contributing to Belki

Thanks for helping improve Belki. Contributions should keep the checked-in
configuration safe for a fresh self-hosted Cloudflare account while preserving
the separately configured Belki managed deployment.

## Development setup

You need Node.js 24 or newer and pnpm 11.

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Use test credentials or inert placeholders in `.dev.vars`. Never add real
Worker secrets, customer data, provider responses, Cloudflare resource IDs, or
private deployment output to Git.

## Making a change

1. Create a focused branch from the latest `main`.
2. Keep runtime behavior, migrations, tests, and documentation in sync.
3. Add D1 migrations instead of editing an already released migration.
4. Run the complete validation suite before opening a pull request.

```bash
pnpm check
pnpm types:check
pnpm deploy:dry
```

Changes to `deployment/getbelki.json`, managed billing, authentication,
tenant isolation, migrations, or destructive retention paths need an explicit
review note explaining their production impact and rollback plan.

## Pull requests

Describe the user-visible result, test evidence, schema or configuration
changes, and any manual rollout steps. Keep unrelated refactors separate. Do
not include generated build output or private evaluation fixtures.

By contributing, you agree that your contribution is licensed under the
repository's Apache-2.0 license.
