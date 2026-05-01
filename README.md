# Jira Time Tracker Bot

Interactive bot for daily hour logging, integrating **Jira** and **Slack** on **Cloudflare Workers**.

## What it does

Every weekday at **4:00 PM ET**, the bot sends each configured user a Slack DM:

| Scenario        | Behavior                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 8h logged** | Breakdown + 3 interactive slots (expandable to 10 with "➕ Add ticket") to log hours. Typeahead ticket search, 0.5h intervals, real-time Jira validation. |
| **= 8h logged** | Breakdown only — no interactive form.                                                                                                                     |
| **Friday**      | Daily report + weekly summary (total vs. 40h goal, day-by-day breakdown).                                                                                 |

At **11 AM ET daily**, the ticket typeahead cache is refreshed automatically.

## Stack

| Component   | Technology                                                        |
| ----------- | ----------------------------------------------------------------- |
| Runtime     | Cloudflare Workers                                                |
| Language    | TypeScript                                                        |
| KV store    | Cloudflare Workers KV                                             |
| Scheduling  | Cloudflare Cron Triggers                                          |
| Tests       | Vitest + `@cloudflare/vitest-pool-workers` (real Workers runtime) |
| Lint/Format | ESLint + Prettier                                                 |

## Prerequisites

- Cloudflare account (free tier sufficient for teams up to ~20 people)
- Node.js ≥ 18
- Wrangler CLI: `npm install -g wrangler`
- Slack workspace admin access
- Jira Cloud with API token permissions

## Setup

### 1. Create Slack App

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Add bot token scopes: `chat:write`, `users:read.email`, `im:write`, `commands`
3. Enable **Interactivity** (update URLs after deploy):
   - **Request URL**: `https://jira-time-tracker-bot.<subdomain>.workers.dev/slack/interactions`
   - **Options Load URL**: `https://jira-time-tracker-bot.<subdomain>.workers.dev/slack/options`
4. Create slash commands (all point to `.../slack/commands`): `/submit`, `/summary`, `/summary-components`, `/refresh-tickets`, `/help`
5. Install to workspace. Copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN` and **Signing Secret** (Basic Information) → `SLACK_SIGNING_SECRET`.

### 2. Create Jira API Tokens

1. [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → **Create API token**
2. Service account token → `JIRA_API_TOKEN`. Service account email → `JIRA_USER_EMAIL`.
3. Each tracked user also needs their own Jira API token for posting worklogs under their account (set in the `USERS` secret — see [docs/configuration.md](docs/configuration.md)).

### 3. Install and configure

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in secrets for local dev
```

Edit `config/tracker-config.json` (tracking thresholds only — boards and users go in secrets):

```json
{
  "tracking": {
    "dailyTarget": 8,
    "weeklyTarget": 40,
    "timezone": "America/New_York",
    "cronHourET": 16
  }
}
```

Set the `JIRA_CONFIG` secret (boards, genericTickets, projectComponents) and `USERS` secret (email → Jira API token map). See [docs/configuration.md](docs/configuration.md) for exact JSON format.

### 4. Create KV namespace

```bash
wrangler login
wrangler kv namespace create CACHE
wrangler kv namespace create CACHE --preview
```

Update `wrangler.toml` with the generated IDs under `[[kv_namespaces]]`.

### 5. Set Cloudflare secrets

```bash
wrangler secret put JIRA_API_TOKEN
wrangler secret put JIRA_USER_EMAIL
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put USERS
wrangler secret put JIRA_CONFIG
```

### 6. Deploy

```bash
wrangler deploy
```

Update the Slack App Request URL and Options Load URL with the deployed Worker hostname.

## Local Development

```bash
wrangler dev   # http://localhost:8787

# Manually trigger the 4PM cron
curl -X POST http://localhost:8787/trigger

# Health check
curl http://localhost:8787/health
# → OK
```

To receive Slack webhooks locally, expose with `ngrok http 8787` and update Interactivity URLs in your Slack App.

## Tests

```bash
npm test                # run once
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
```

## Lint & Format

```bash
npm run lint && npm run format:check   # check
npm run lint:fix && npm run format     # auto-fix
```

Pre-commit hooks (Husky + lint-staged) run `eslint --fix`, `prettier --write`, and `tsc --noEmit` on staged `.ts` files. Bypass with `git commit --no-verify` only for emergencies — CI will still catch failures.

## Troubleshooting

### Bot doesn't send messages

- Emails in the `USERS` secret must exactly match the user's Jira and Slack accounts
- Check logs: `wrangler tail`
- Verify Slack App scopes and workspace installation

### Stale hours shown after logging

- Hours are never cached — always read directly from the Jira API
- If `jira_account_map` is corrupted, delete the key in the Cloudflare KV dashboard; it rebuilds on the next cron run or interaction

### 401 on Slack interactions

- `SLACK_SIGNING_SECRET` must be from Slack App → Basic Information, not the Bot Token

### Hours not logged in Jira

- Per-user Jira API tokens in `USERS` secret must be valid and not expired
- `genericTickets` entries in `JIRA_CONFIG` must exist as real Jira issues

### Cron doesn't fire at 4PM ET

- `wrangler.toml` registers `0 20 * * 1-5` (8PM UTC, covers EDT). The handler checks the actual ET hour to handle DST automatically.
- Check with `wrangler tail` that the cron is firing

### Free tier subrequest limit

- Free tier: 50 subrequests/invocation. Large teams or boards may need the Paid plan ($5/month → 10K subrequests)

## Costs

| Component         | Free Tier    |
| ----------------- | ------------ |
| Cloudflare Worker | 100K req/day |
| KV Reads          | 100K/day     |
| KV Writes         | 1K/day       |
| Cron Triggers     | 5 (2 used)   |

## Docs

- [Configuration](docs/configuration.md) — `tracker-config.json`, `JIRA_CONFIG` and `USERS` secret format, `projectComponents` field
- [Architecture](docs/architecture.md) — cron flows, handler routing, KV cache lifecycle, multi-slot interaction logic
- [Slash Commands](docs/slash-commands.md) — command reference, `/submit` validation rules, adding new commands
- [CI/CD](docs/ci-cd.md) — GitHub Actions workflows, test environment setup
