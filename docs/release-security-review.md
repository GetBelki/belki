# Pre-release sensitive-data review

Reviewed on 2026-10-28 against `e412704` and the locally available refs.

## Scope and result

Gitleaks 8.30.1 was downloaded from the official GitHub release and its archive
was verified against the release's SHA-256 checksum. Scanning ran locally;
source files and credentials were not uploaded to a scanning service.

- The repository is not shallow. `git rev-list --all --count` reported 265
  reachable commits. The final scan used `--all --full-history -m` and scanned
  all 265 commits, including merge diffs.
- A separate directory scan covered a copy of all 352 tracked files, excluding
  ignored local secrets, installed dependencies and generated build output.
- The tree scan reported ten matches. The full history scan reported fifteen:
  the same ten test examples, with five Stripe placeholder matches repeated in
  merge history. Every historical flagged line is also present in the reviewed
  current tests, and all matches were reviewed against the source.
- No actual credential was identified among these findings. No credential
  revocation or history rewrite was indicated by the reviewed matches.

## Reviewed matches

| Location | Tree / history matches | Explanation |
|---|---:|---|
| `tests/contracts.test.ts` | 1 / 1 | Explicit Dodo example credential |
| `tests/payment-credential-vault.test.ts` | 1 / 1 | Explicit Dodo test credential used in local encryption tests |
| `tests/payment-provider-form.test.tsx` | 2 / 2 | Fixed webhook endpoint UUID used by mocked form submissions to `example.com` |
| `tests-workers/stripe-environment.test.ts` | 5 / 10 | Literal Stripe placeholder strings used to test environment-prefix validation |
| `tests/structured-answer.test.tsx` | 1 / 1 | Encoded public advertiser-domain identifier, not an authentication key |

No broad test-directory exclusion or scanner suppression was added.

## Repository hygiene

The current tracked-file list and historical filenames were inspected for
environment files, credentials, private keys, logs, dumps, exports and private
evaluation fixtures. The environment files in history are example templates;
SQL files found by this inventory are migrations and the maintenance script.
No tracked `.dev.vars`, private key, production log, D1 export or private JSONL
evaluation fixture was identified by that review. This filename inspection is
not an exhaustive semantic audit of every historical provider example.

The managed profile `deployment/getbelki.json` contains public service origins,
a sender address and a D1 resource ID, not authentication credentials. It is
separate from the self-hosted defaults. Public Belki links and example provider
content in documentation and tests are intentional.

## Repeating the review before publication

Run from a fully fetched checkout with Gitleaks installed. Store reports outside
the repository and keep redaction enabled:

```bash
gitleaks git --redact --log-opts="--all --full-history -m" \
  --report-format json --report-path /tmp/belki-history-review.json .
```

For the current tree, copy only `git ls-files` entries into an empty temporary
directory and run `gitleaks dir --redact` there. Do not scan ignored local secrets
and mistake them for published files. Review matches individually, including
their historical context; the reviewed test matches above produce a nonzero
scanner exit status and should not be interpreted as real leaked credentials.

GitHub authentication was unavailable during this review. Unfetched remote
branches, deleted remote history, GitHub artifacts, issues, external services and
credential revocation status are outside its scope. A scanner passing or reporting
only reviewed false positives does not prove the absence of every possible secret.
Repeat the review after fetching release refs and before changing visibility.
