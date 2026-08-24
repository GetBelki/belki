# Security policy

## Supported versions

Security fixes are made on the latest `main` branch and included in the next
release. Older commits and self-hosted deployments are not maintained as
separate support lines; operators should update to the latest release after
reviewing its migration notes.

## Report a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, log excerpt, or screenshot.

When this repository is public, use GitHub's **Security → Report a
vulnerability** flow to open a private security advisory. If private reporting
is unavailable, contact the maintainers privately through
[getbelki.com](https://getbelki.com/) without including exploit details in a
public channel.

Include the affected commit or release, deployment mode, reproduction steps,
impact, and any suggested mitigation. Remove credentials, customer data,
provider responses, and Cloudflare account identifiers from the report.

The maintainers will acknowledge a report as soon as practical, validate its
scope, coordinate a fix, and credit the reporter if requested and appropriate.
Please allow time for supported deployments to be patched before publishing
technical details.

## Operator responsibility

Self-hosters are responsible for Cloudflare account security, Worker secrets,
DataForSEO credentials, access policies, backups, updates, and retention. Never
commit `.dev.vars`, generated credentials, database exports, provider payloads,
or production deployment profiles containing secrets.
