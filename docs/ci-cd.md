# CI/CD

## GitHub Actions Workflows

| File | Trigger | Steps | Deploys? |
|------|---------|-------|---------|
| `pull-request.yaml` | PR to `develop` or `master` | Lint → Test → Build (dry-run) | No |
| `deploy-production.yaml` | Push/merge to `master` | Lint → Test → Type Check → Deploy | Yes (production) |
| `deploy-test.yaml` | Push/merge to `develop` | Lint → Test → Type Check → Deploy | Yes (test env) |
| `deploy.yaml` | `workflow_dispatch` (manual) | Build → Deploy | Yes |

No deploy runs unless lint, tests, and build all pass.

---

## Required GitHub Secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Description | Where to get |
|--------|-------------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with `Workers Scripts:Edit` permission | Cloudflare Dashboard → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Cloudflare Dashboard → Overview (right sidebar) |

Jira and Slack secrets are not needed in GitHub — they are set directly in Cloudflare via `wrangler secret put`.

---

## Test Environment

`develop` deploys to a separate Worker (`jira-time-tracker-bot-test`) with its own KV namespace and secrets. This environment mirrors production but is isolated.

### Initial test environment setup

```bash
# 1. Create test KV namespace
wrangler kv namespace create CACHE --env test

# 2. Update wrangler.toml [env.test] kv_namespaces with the generated IDs

# 3. Set test secrets
wrangler secret put JIRA_API_TOKEN --env test
wrangler secret put JIRA_USER_EMAIL --env test
wrangler secret put SLACK_BOT_TOKEN --env test
wrangler secret put SLACK_SIGNING_SECRET --env test
wrangler secret put USERS --env test
wrangler secret put JIRA_CONFIG --env test

# 4. Deploy manually to verify
wrangler deploy --env test
```

The test Slack App and test Jira project should have their own credentials to avoid polluting production data.
