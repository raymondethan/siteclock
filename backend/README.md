# SiteClock cloud backend

Google federation through Cognito -> HTTP API JWT authorizer -> Node.js Lambda handlers -> DynamoDB on-demand. No VPC, NAT gateway, database instances, or polling server. AWS SAM defines separate `siteclock-dev` and `siteclock-prod` stacks. The current development account permits Ohio (`us-east-2`); use that region consistently for its resources and Google redirect URI.

### Current development deployment

The development stack is deployed in Ohio. Its public outputs are configured in `cloud-config.js` and the manifest. Production remains a separate deployment. The extension needs to be reloaded in Chrome to use the configured development backend; cloud backup remains opt-in.

`tools/deploy_cloud.py` provides a development-only AWS CLI deployment path without requiring the SAM CLI. It reads ignored `.test-build/deploy/development.json`, verifies account/region and a prebuilt artifact hash, creates a private encrypted artifact bucket, stores the Google secret through a local owner-readable file, reviews CloudFormation change sets, and refuses resource deletions or replacements, except a conditionally replaced cleanup invocation permission whose processed properties are verified identical. Run `python3 tools/deploy_cloud.py preflight`, then `deploy`, or use `status` to inspect the stacks. Metadata and secret files under `.test-build` must remain ignored. The helper's optional isolated test callbacks are development-only; remove them after testing.

API Gateway has no CORS configuration because it rejects `chrome-extension://` origins. Extension service-worker requests use the exact API host permission in the manifest. JWT authorization is still required on every route. A future browser website client would need a separately configured HTTP(S) origin.

## Prepare and deploy

Prerequisites: Node.js 22+, pnpm, AWS CLI credentials, AWS SAM CLI, and a Google Cloud OAuth web client. Nothing in this repository provisions AWS until you deploy it.

1. Establish stable development and published Chrome extension IDs. The extension callback is `https://EXTENSION_ID.chromiumapp.org/oauth2`. For development, keep a fixed unpacked extension path or use a separate development manifest key. Never package a development key for the store. Each environment takes one extension ID.
2. Choose a unique Cognito domain prefix for each stack, such as `siteclock-dev-YOUR_SUFFIX`. In Google's OAuth web client, register `https://PREFIX.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` as an authorized redirect. Configure Google's consent screen for the public release, basic identity scopes, support email, and this project's current privacy policy. Use separate OAuth clients for development and production. Do not request access to Google browsing history.
3. Store the Google client secret in AWS Secrets Manager as JSON with a `client_secret` property. Use the AWS console or a local secret file; do not put secret values in shell arguments, git, or extension configuration. Note its ARN. The deploying identity needs access to resolve that secret; the extension and Lambda handlers do not.
4. Install pinned backend dependencies: `pnpm --dir backend install --frozen-lockfile`. SAM uses the included Makefile to install the same frozen pnpm lock into each deployment artifact, with a hoisted production dependency layout.
5. Validate and build:

   ```sh
   cfn-lint --regions us-east-1 -t backend/template.json
   cfn-guard validate --rules backend/security.guard --data backend/template.json
   sam build --template-file backend/template.json
   ```

6. Deploy development first:

   ```sh
   sam deploy --guided --region us-east-1 --stack-name siteclock-dev --tags Project=siteclock-dev
   ```

   Set `Environment=dev`, the development `ExtensionId`, Google client ID, Google secret ARN, chosen `AuthDomainPrefix`, and alert email. Acknowledge IAM creation through SAM. The stack creates database storage, accounts, an API, monitoring, a KMS key, and a tagged $10 monthly budget. Confirm the operational SNS email subscription. Activate the `Project` cost-allocation tag in AWS Billing so the filtered budget can measure project spend; tag activation/reporting can lag. Budget emails at $5 and $10 are notifications, not a hard cap, and don't capture untagged costs or other projects.

7. Configure the extension from public outputs:

   ```sh
   aws cloudformation describe-stacks --region us-east-1 --stack-name siteclock-dev --query 'Stacks[0].Outputs' > /tmp/siteclock-outputs.json
   python3 tools/configure_cloud.py /tmp/siteclock-outputs.json
   ```

   This updates `cloud-config.js`, exact host permissions, and the extension CSP. Those outputs are public; Google client secrets and AWS credentials must never be included. Reload the unpacked extension. A build with empty configuration remains fully local and explains that cloud backup is unavailable.

8. Perform the two-installation checks below. Repeat with a separate production stack, `Environment=prod`, its published extension ID, and its OAuth client. Configure the release against production before packaging with `python3 tools/package.py`. Do not distribute a development-configured package.

## Data and interfaces

One table has string keys `pk` and `sk`:

- `ACCOUNT#<Cognito sub>` / `PROFILE`: `version`, `createdAt`, current UUID `generation`.
- `ACCOUNT#<sub>#<generation>` / `INSTALL#<installationId>`: creation and last-sync timestamps.
- Same generation partition / `USAGE#<installationId>#<hostname>`: installation ID, normalized hostname, lifetime `totalMs`, `baselineMs` for undated pre-upgrade history, `dailyMs`, optimistic `revision`, and server `updatedAt`.
- Same generation partition / `DAY#<YYYY-MM-DD>#INSTALL#<installationId>#HOST#<hostname>`: cumulative `totalMs` for that local calendar date, plus date, installation ID and hostname.
- `CLEANUP` / `<sub>#<retired generation>`: retired partition and job creation timestamp. Jobs persist until every retired record is removed.

No secondary indexes, account scans, full URLs, or active-tab/session data. Cognito owns authentication and the Google identity mapping; the table does not store passwords or Google tokens.

All routes require a Cognito access token from this stack's public client, with `openid` scope. ID tokens are rejected by the handler. Account ownership comes from the authorizer's `sub`, never from request data. Registration and each counter update transactionally condition-check the profile generation. Registration is repeatable. Updates accept only higher counters; equal/lower counters are acknowledged without changing data. A batch can partially succeed, and retrying the whole batch is safe.

| Route | Request | Response |
|---|---|---|
| `GET /v1/account` | — | `accountId`, `generation`, display identity fallback |
| `PUT /v1/installations` | `generation`, `installationId` | `ok` |
| `PUT /v1/usage` | `generation`, `installationId`, `schemaVersion: 2`, `counters: [{hostname, totalMs, day?}]` (1–50); omit `day` for the undated baseline | `ok` |
| `GET /v1/usage` | query `generation`, optional `from`/`to` calendar dates and opaque `cursor` | `generation`, `contributions`, next `cursor` or null |
| `DELETE /v1/usage` | `generation` being deleted | current/new `generation` |

Uploads are bounded to 32 KiB; durations are nonnegative safe-integer milliseconds. Downloads return up to 200 contribution rows per page and constrain cursors to the caller's account and generation. Pages use strongly consistent reads but do not promise a cross-page snapshot. Counters merge by maximum and converge on subsequent syncs. HTTP 409 means the generation changed; clients must retire their old contributions and pause. HTTP 401 requires reconnection. Other transient failures retry with backoff. Network requests have a 20-second client timeout.

Deletion atomically advances the profile generation and adds a cleanup job. The expected generation is its idempotency condition, so retries cannot delete newly accumulated history. A scheduled cleanup Lambda processes bounded batches every five minutes, retries unprocessed DynamoDB deletes, and removes a job only when its partition is empty. Failed or interrupted work remains resumable. The current account profile remains, and retired generations are never served through the API.

## Recovery and privacy

Production enables seven-day DynamoDB point-in-time recovery, table deletion protection, and retained state on stack deletion/replacement. Dev retains state too, but does not enable PITR or deletion protection. API/Lambda logs retain for 14 days; only operation names, route templates, status codes, latency, and request identifiers are logged. No hostnames, payloads, claims, or tokens belong in logs.

PITR restores into a **new table**. A recovery must preserve later deletions: keep the current account profiles and pending cleanup jobs authoritative, and copy only restored records whose generation still matches those current profiles. Never point production at a historical table wholesale. Validate that users who deleted cloud history remain empty. If the current deletion records are unavailable, do not restore user history automatically; investigate first. An account's usage is a backup of uploaded data, not a guarantee that the last minute before abrupt device failure was uploaded.

## Cost target

Target: below $10/month for a small pilot, not an unlimited-user price promise. Planning example: 10 daily active installations, two browsing hours/day, 100 hostnames/account, minute polling, one changed domain/minute. This produces roughly 180,000 API calls/month (account check, registration, upload, lifetime download, daily-range download), plus occasional login and pagination calls. Estimate API request charges using current pricing, then add Lambda execution, DynamoDB transactions/reads/storage/PITR, logs, alarms, Secrets Manager, KMS, and transfer. A small single-stack deployment is expected to remain within the target, but measure actual bills and handler duration before public rollout. Development and production resources both count toward the overall budget. There is no dependency on temporary signup credits.

Current pricing references: [HTTP API](https://aws.amazon.com/api-gateway/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [Cognito](https://aws.amazon.com/cognito/pricing/). Recalculate for more installations, large histories, pagination, or continuously open Chrome profiles, which continue polling even while idle. Cost alarms do not instantly stop abuse; HTTP API throttling and Lambda reserved concurrency limit request throughput.

## Verification

```sh
node tests/run.js
node --test tests/sync.test.cjs tests/cloud-client.test.cjs backend/tests/*.test.mjs
```

Run from the repository root. Unit/integration tests use Chrome mocks and injected stores, not live AWS. The SDK store tests inspect transactional requests, cursor boundaries, cancellation handling, and cleanup retries.

Development verification on 2026-10-31 exercised real Google sign-in with PKCE, token refresh, and the deployed API/DynamoDB using two synthetic installation IDs. Concurrent uploads, combined totals, duplicate and out-of-order uploads, generation changes, stale-upload rejection, and deletion retry behavior passed. Unauthenticated requests, ID tokens, forged account claims, invalid cursors, and a cursor targeting another account were rejected. The account was verified empty before fixtures were created, and exact fixture ownership was checked before cleanup. The temporary test refresh token was revoked and its local file removed. This does not cover two real Google accounts or the complete Chrome extension UI workflow below.

After deployment, use two distinct Chrome profiles with the same Google account:

1. Confirm no network communication before sign-in, and no usage transfers until enabling backup.
2. Import existing local totals on profile A, add usage on B, and check popup and overlay show the sum after a sync.
3. Pause backup, add time, re-enable, and confirm only that installation's contribution increases.
4. Disconnect the network; continue browsing, reconnect, and confirm catch-up without duplication.
5. Erase B's extension storage; sign in and enable again. Confirm restored totals and a new installation ID, then add new time once.
6. Switch to a second Google account and verify assigned history is absent. Sign back into the first account and restore it.
7. Keep B offline, delete cloud history on A, then reconnect B. It must pause and keep old usage local. Re-enable B and confirm old counters stay out of the cloud.
8. Confirm popup/overlay updates, token refresh after expiration, canceled Google sign-in, and worker/browser restarts. Check CloudWatch alarms, cleanup completion, budget/tag activation, and the absence of private data in logs.

## Daily and lifetime consistency (0.3.0)

Calendar dates are assigned on the tracking computer, using its local timezone at accounting checkpoints. Intervals split at local midnight; timezone changes affect subsequent intervals and do not regroup history. Last 7 days means today plus the previous six calendar dates, not a rolling 168 hours. Lifetime includes all prior usage; daily views begin at upgrade. No timezone identifier or full browsing events are uploaded.

Schema-2 baseline uploads preserve the maximum of the old lifetime counter and the supplied undated baseline. Daily uploads strongly read the daily record and summary, compute the increase, and transactionally compare-and-swap both records with a profile generation check. Conflicts reread and retry; duplicate or older counters add nothing. The summary stores `totalMs = baselineMs + dailyMs`. All comparisons are server-side; the client never uploads an authoritative lifetime total combining daily and undated usage. Existing schema-1 clients continue to work for their own unmigrated contributions. A legacy upload for an already migrated installation/hostname receives HTTP 426 rather than corrupting its summary.

The existing table, routes and table-scoped IAM permissions support this model. There is no backfill that fabricates historical dates and no database replacement. Sync reads lifetime summary rows and only the current seven-day daily range. Calendar-range pagination cursors are bound to the account, generation and exact requested range; ranges are limited to 366 days per request. Monthly views can use the same date-range API, though the current UI displays Today, Last 7 days and Total.

Run `python3 tools/period_smoke.py` after a development deployment to exercise the actual Lambda execution role and DynamoDB transactions, including baseline migration, concurrent uploads, calendar-range queries, and stale-generation rejection. The script uses a random synthetic account via IAM-authenticated Lambda invocation and removes only its own test records. It does not test Google login or API Gateway JWT verification; verify those through the installed extension separately.
