# Jira Time Tracker Bot

Interactive bot for daily hour logging, integrating **Jira** and **Slack** on **Cloudflare Workers**.

## What does it do?

Every weekday at **4:00 PM ET**, the bot:

1. Reads Jira worklogs from the configured boards.
2. Calculates the hours logged by each person for the day.
3. Sends a direct message (DM) in Slack to each configured user with:

| Scenario        | Behavior                                                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 8h logged** | Shows the breakdown + **dynamic interactive slots** (3 by default, expandable up to 10 with the "➕ Add ticket" button) to log hours in multiple tickets at once (0.5h intervals). Tickets are searched with typeahead (no 100 limit). Validates duplicates, partial data, daily limit, and stale data against Jira in real time. |
| **= 8h logged** | Shows only the breakdown as confirmation. No interactive options.                                                                                                                                                                                                                                                                 |
| **Friday**      | In addition to the daily report, includes a weekly summary with the total vs. the 40h goal and a day-by-day breakdown.                                                                                                                                                                                                            |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                       │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  Cron    │───▶│ Jira API: fetch worklogs         │    │
│  │ 4PM ET   │    │ Aggregate per user                │    │
│  │ Mon-Fri  │    │ Cache all tickets in KV            │    │
│  │          │    │ Build Block Kit (dynamic slots)    │    │
│  │          │───▶│ Slack API: send DM                │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature            │    │
│  │ /slack/  │    │ submit_hours: validate + post     │    │
│  │ interact │    │ add_slot: add slot + preserve      │    │
│  │          │───▶│ Re-fetch Jira (stale guard)       │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature            │    │
│  │ /slack/  │    │ Read ticket cache from KV         │    │
│  │ options  │    │ Filter by query (typeahead)       │    │
│  │          │───▶│ Return option_groups (max 100)    │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature            │    │
│  │ /slack/  │    │ Dispatch by command               │    │
│  │ commands │    │ /summary: fetch Jira weekly data  │    │
│  │          │───▶│ Post summary via response_url     │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐                                            │
  │ Workers  │  Cache: Slack user IDs (7d TTL), Jira     │
  │   KV     │  accountId→email map (24h TTL),           │
  │          │  all_tickets typeahead (24h TTL)           │
│  └──────────┘                                            │
└──────────────────────────────────────────────────────────┘
```

---

## Multi-Slot Hour Logging (Dynamic Slots)

### Interface

When a user has less than 8h logged, the Slack message renders **3 initial slots**, expandable up to **10** with the **"➕ Add ticket"** button. Each slot contains:

- An `external_select` with typeahead search to pick a ticket (no 100 limit)
- A `static_select` to pick hours (0.5h intervals)

Available buttons:

- **"✅ Log hours"** — Submits all complete slots
- **"➕ Add ticket"** — Adds an extra slot, preserving existing selections

### Ticket Search (external_select)

Ticket selectors use `external_select` with `min_query_length: 0`, meaning:

- Clicking the selector shows the most relevant tickets (generic + project)
- Typing filters dynamically by key or summary
- No 100-ticket limit (search filters from the full cache)
- The `/slack/options` endpoint responds with `option_groups` separating "📌 Generic Tickets" and "📋 Project Tickets"

The ticket cache updates automatically on each cron run (4PM ET) and is stored in KV with key `all_tickets` (TTL: 24 hours, aligned with cron frequency).

### `targetDate` Encoding

The Submit button's `value` field contains the target date (e.g., `2026-04-02`) for which the alert was generated. This allows:

- Logging hours for **the correct date** even if the user clicks a day later.
- **Rejecting** the log if the current date is no longer in the same ISO calendar week (Monday–Sunday).

The "➕ Add ticket" button encodes `{slotCount}:{targetDate}` in its `value` to preserve context.

### Validation Rules (Backend)

On submit, the backend dynamically detects the number of slots from `state.values` and runs this validation chain in order:

| #   | Validation                                                                                               | Behavior if fails                                            |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | **Calendar week** — `targetDate` must be in the same ISO week as the current date (ET)                   | Replaces the message with a period expired notice            |
| 2   | **Partial data** — Each slot must have both fields (ticket + hours) or be empty                          | Error indicating which slot(s) are incomplete                |
| 3   | **At least 1 slot** — At least one complete slot is required                                             | Error requesting at least one complete slot                  |
| 4   | **Duplicate tickets** — Same ticket not allowed in more than one slot                                    | Error indicating duplication                                 |
| 5   | **Sum vs. limit** — Total submitted must not exceed `dailyTarget` (8h)                                   | Error with the submitted total                               |
| 6   | **Stale-data guard** — Jira is re-fetched for actual hours. `actualHours + submittedTotal ≤ dailyTarget` | Replaces message with real balance and new interactive slots |
| 7   | **POST worklogs** — Worklogs are sent one by one                                                         | If any fail, reports which and confirms the successful ones  |

---

## Slash Commands

| Command                | Description                                                                                    | Parameters                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/summary`             | Your **weekly hour summary** — total Mon–Fri vs. 40h target, day-by-day breakdown per ticket.  | —                                              |
| `/summary-components`  | Your **weekly summary grouped by Jira component** — hours per component, then per day.         | —                                              |
| `/daily-summary [dia]` | Your **daily hour summary on demand** — reuses the same interactive form to log missing hours. | `lun`, `mar`, `mie`, `jue`, `vie` _(optional)_ |

### `/daily-summary` validation rules

- **No parameter** → returns today's summary (only valid Mon–Fri; returns an error on weekends).
- **With parameter** → returns the summary for the given day of the **current week**.
- **Restriction:** Only days of the current week are allowed. Past weeks and future days are rejected.
- Valid values: `lun` (Monday), `mar` (Tuesday), `mie` (Wednesday), `jue` (Thursday), `vie` (Friday).

**Examples:**

```sh
/daily-summary          # Today's summary (Mon-Fri only)
/daily-summary lun      # Monday of the current week
/daily-summary jue      # Thursday of the current week
```

### How commands work

1. Slack sends a `POST` to `/slack/commands` with your Slack user ID.
2. The bot immediately responds with an ephemeral loading message (within the 3-second Slack limit).
3. Asynchronously, it fetches worklogs from Jira, aggregates them, builds a Block Kit message, and replaces the loading message via `response_url`.
4. If something goes wrong (user not found, Jira error), you receive a friendly ephemeral error instead.

> **Note:** The two new commands (`/summary-components` and `/daily-summary`) must be registered in your Slack App dashboard pointing to the same `/slack/commands` endpoint.

### Adding new commands

The handler in `src/handlers/slack-command.ts` uses a `switch` dispatcher. To add a command:

```typescript
case "/mycommand":
  ctx.waitUntil(processMyCommand(payload.user_id, payload.response_url, env));
  return jsonResponse({ response_type: "ephemeral", text: "⏳ Procesando..." });
```

---

## Prerequisites

- **Cloudflare account** (free tier is enough)
- **Node.js** >= 18
- **Wrangler CLI** (`npm install -g wrangler`)
- Admin access to the **Slack workspace**
- **Jira Cloud** with permissions to create API tokens

---

## Step-by-step Setup

### 1. Create Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name: `Jira Time Tracker` (or your choice)
3. Select your workspace

#### Bot Token Scopes (OAuth & Permissions)

Add these scopes:

- `chat:write` — Send messages
- `users:read.email` — Lookup users by email
- `im:write` — Open DMs with users
- `commands` — Register and receive slash commands

#### Interactivity & Shortcuts

- **Enable Interactivity**
- **Request URL**: `https://jira-time-tracker-bot.<your-account>.workers.dev/slack/interactions`
- **Options Load URL**: `https://jira-time-tracker-bot.<your-account>.workers.dev/slack/options`
  _(update both URLs after deploy)_

#### Slash Commands

1. Go to **Slash Commands** in your app's settings
2. Click **Create New Command**
3. Fill in:
   - **Command**: `/summary`
   - **Request URL**: `https://jira-time-tracker-bot.<your-account>.workers.dev/slack/commands`
   - **Short Description**: `Ver tu resumen semanal de horas`
   - **Usage Hint**: _(leave empty)_
   - **Escape channels, users, and links**: off
4. Save and reinstall the app to your workspace

#### Install to Workspace

- Install the app and copy:
  - **Bot User OAuth Token** (`xoxb-...`) → will be `SLACK_BOT_TOKEN`
  - **Signing Secret** (in Basic Information) → will be `SLACK_SIGNING_SECRET`

### 2. Create Jira API Token

1. Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. **Create API token** → copy the value → will be `JIRA_API_TOKEN`
3. The account email will be `JIRA_USER_EMAIL`

> **Recommendation**: use a service (not personal) account for production.

### 3. Configure the project

```bash
cd jira-time-tracker-bot

# Install dependencies
npm install

# Copy secrets file for local development
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your real values:

```env
JIRA_API_TOKEN=ATATT3xFfGF0...
JIRA_USER_EMAIL=your.email@company.com
SLACK_BOT_TOKEN=xoxb-123456-789...
SLACK_SIGNING_SECRET=abc123def456...
```

### 4. Configure boards, users, and tickets

Edit `config/tracker-config.json`:

```json
{
  "jira": {
    "boards": ["MP", "PROJ2"],
    "genericTickets": [
      { "key": "MP-100", "label": "Client requested meetings" },
      { "key": "MP-101", "label": "Others" }
    ]
  },
  "tracking": {
    "dailyTarget": 8,
    "weeklyTarget": 40,
    "timezone": "America/New_York",
    "cronHourET": 16
  },
  "users": ["john.doe@applydigital.com", "jane.smith@applydigital.com"]
}
```

| Field                   | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `jira.boards`           | Jira project keys to search for worklogs                             |
| `jira.genericTickets`   | Predefined tickets always shown in the dropdown (must exist in Jira) |
| `tracking.dailyTarget`  | Daily hour goal (default: 8)                                         |
| `tracking.weeklyTarget` | Weekly hour goal (default: 40)                                       |
| `tracking.cronHourET`   | ET hour for notifications (default: 16 = 4PM)                        |
| `users`                 | List of emails to receive notifications                              |

### 5. Create KV namespace

```bash
# Login to Cloudflare
wrangler login

# Create production namespace
wrangler kv namespace create CACHE

# Create preview/dev namespace
wrangler kv namespace create CACHE --preview
```

Copy the generated IDs and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "your-production-id"
preview_id = "your-preview-id"
```

### 6. Set secrets in Cloudflare

```bash
wrangler secret put JIRA_API_TOKEN
wrangler secret put JIRA_USER_EMAIL
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

### 7. Deploy

```bash
wrangler deploy
```

After deploy, update the URLs in the Slack App:

- **Request URL** (Interactivity): `https://jira-time-tracker-bot.<your-subdomain>.workers.dev/slack/interactions`
- **Options Load URL** (Interactivity): `https://jira-time-tracker-bot.<your-subdomain>.workers.dev/slack/options`

---

## CI/CD with GitHub Actions

The project includes three GitHub Actions workflows:

| Workflow                 | Trigger                 | Steps                             | Deploy?          |
| ------------------------ | ----------------------- | --------------------------------- | ---------------- |
| `pr.yaml`                | PR to `master`          | Lint → Test → Build (dry-run)     | No               |
| `deploy-production.yaml` | Push/merge to `master`  | Lint → Test → Type Check → Deploy | Yes (production) |
| `deploy-test.yaml`       | Push/merge to `develop` | Lint → Test → Type Check → Deploy | Yes (test)       |

**Rule**: No deploy ever runs unless lint, tests, and build pass first.

### Set secrets in GitHub

In your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret                  | Description                                       | How to get it                                                                                      |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | API token with `Workers Scripts:Edit` permissions | [Cloudflare Dashboard → API Tokens → Create Token](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                             | Cloudflare Dashboard → Overview (right sidebar)                                                    |

> **Note**: Jira and Slack secrets are not needed in GitHub — they're set in Cloudflare via `wrangler secret put`.

Recommended variables and secrets:

- GitHub `Secrets`: only CI/CD credentials, e.g. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
- Cloudflare Worker Secrets: `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `USERS`, `JIRA_CONFIG`
- `wrangler.toml`: non-sensitive, static values, e.g. bindings, cron, and `JIRA_BASE_URL` if not sensitive
- GitHub `Variables`: only if you need non-sensitive pipeline-only parameters later; not needed today

### Workflow flow

```
PR → master:     lint → test → build (dry-run)
Push → master:   lint → test → type-check → wrangler deploy
Push → develop:  lint → test → type-check → wrangler deploy --env test
```

---

## Testing

The project uses **Vitest** with `@cloudflare/vitest-pool-workers` to run tests inside the real Workers runtime (miniflare). This provides native access to KV, `crypto.subtle`, `fetch`, etc.

### Running tests

```bash
# Run all tests once
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# With coverage report
npm run test:coverage
```

### Test structure

```
tests/
├── setup.ts                         # Mock factories and helpers
├── utils/
│   ├── date.test.ts                 # Date/timezone utility tests
│   └── crypto.test.ts               # Slack signature verification tests
├── services/
│   ├── aggregator.test.ts           # Hours aggregation logic tests
│   ├── jira.test.ts                 # Jira API service tests
│   └── slack.test.ts                # Slack API service tests
├── handlers/
│   ├── cron.test.ts                 # Cron trigger handler tests
│   ├── slack-interaction.test.ts    # Slack interaction handler tests
│   └── slack-options.test.ts        # Slack options endpoint tests
├── builders/
│   └── message-builder.test.ts      # Block Kit builder tests
└── integration/
    └── index.test.ts                # Router integration tests
```

### Mocking strategy

- **External APIs (Jira, Slack)**: Mocked via `vi.stubGlobal("fetch", ...)` to intercept all HTTP calls
- **KV namespace**: Either real miniflare KV (from pool config) or manual mock with `vi.fn()` for precise control
- **Date/time**: Spied via `vi.spyOn()` to control `getCurrentHourET()`, `getTodayET()`, etc.

---

## Linting & Formatting

```bash
# Run ESLint
npm run lint

# Auto-fix ESLint issues
npm run lint:fix

# Check formatting (Prettier)
npm run format:check

# Auto-format files
npm run format
```

---

## Pre-commit Hooks

The project uses **Husky** + **lint-staged** to automatically lint and format staged files before each commit.

**What runs on commit:**

1. `eslint --fix` on staged `.ts` files
2. `prettier --write` on staged `.ts` files
3. `tsc --noEmit` (full type check)

If any step fails, the commit is blocked.

### Emergency bypass

In extreme cases (e.g., hotfix that must ship immediately), you can skip the pre-commit hook:

```bash
git commit --no-verify -m "hotfix: critical fix"
```

> **Warning**: Use `--no-verify` sparingly. CI will still catch any issues on the PR/push.

---

## test Environment

The `develop` branch deploys to a separate Cloudflare Worker (`jira-time-tracker-bot-test`) with its own KV namespace and secrets.

### Setup test

```bash
# 1. Create test KV namespace
wrangler kv namespace create CACHE --env test

# 2. Update wrangler.toml [env.test] with the generated IDs

# 3. Set test secrets
wrangler secret put JIRA_API_TOKEN --env test
wrangler secret put JIRA_USER_EMAIL --env test
wrangler secret put SLACK_BOT_TOKEN --env test
wrangler secret put SLACK_SIGNING_SECRET --env test
wrangler secret put USERS --env test
wrangler secret put JIRA_CONFIG --env test

# 4. Deploy manually (or push to develop)
wrangler deploy --env test
```

---

## Local development

```bash
# Start dev server
wrangler dev

# Worker will be at http://localhost:8787
```

### Manually trigger cron

```bash
# Using the test endpoint (ignores ET hour validation)
curl -X POST http://localhost:8787/trigger

# Using Cloudflare's native cron endpoint
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

### Test Slack interactions locally

To let Slack send webhooks to your local machine:

```bash
# In another terminal, expose the local server
ngrok http 8787

# Copy the generated URL (https://xxxx.ngrok.io)
# and update it as the Request URL in Slack App → Interactivity
```

### Health check

```bash
curl http://localhost:8787/health
# → OK
```

---

## File structure

```
jira-time-tracker-bot/
├── src/
│   ├── index.ts                    # Entry: fetch + scheduled handlers
│   ├── config.ts                   # Config loader + validation
│   ├── constants.ts                # Cache key names and TTL values
│   ├── types/
│   │   └── index.ts                # TypeScript interfaces
│   ├── handlers/
│   │   ├── cron.ts                 # 4PM ET notification logic + ticket cache
│   │   ├── slack-interaction.ts    # Slack webhook handler (submit + add_slot)
│   │   └── slack-options.ts        # external_select typeahead endpoint
│   ├── services/
│   │   ├── jira.ts                 # Jira REST API v3 client
│   │   ├── slack.ts                # Slack Web API + KV cache
│   │   └── aggregator.ts          # Hours aggregation
│   ├── builders/
│   │   └── message-builder.ts      # Block Kit construction
│   └── utils/
│       ├── date.ts                 # Date/timezone utilities
│       └── crypto.ts               # HMAC-SHA256 signature verification
├── tests/
│   ├── setup.ts                    # Mock factories and helpers
│   ├── utils/                      # Utility tests
│   ├── services/                   # Service tests
│   ├── handlers/                   # Handler tests
│   ├── builders/                   # Builder tests
│   └── integration/                # Router integration tests
├── config/
│   └── tracker-config.json         # Boards, users, tickets, thresholds
├── .github/
│   └── workflows/
│       ├── pr.yaml                  # CI: lint + test + build on PRs
│       ├── deploy-production.yaml   # CD: deploy to production on merge to master
│       └── deploy-test.yaml      # CD: deploy to test on push to develop
├── .husky/
│   └── pre-commit                  # Pre-commit hook (lint-staged + type check)
├── wrangler.toml                   # CF Worker config + cron + test env
├── vitest.config.ts                # Vitest + Workers pool configuration
├── eslint.config.mjs               # ESLint flat config
├── .prettierrc                     # Prettier configuration
├── tsconfig.json
├── package.json
├── .dev.vars.example               # Secret template
├── .gitignore
└── README.md
```

---

## Cache Strategy

All KV cache keys and TTLs are centralized in `src/constants.ts`.

| KV Key               | TTL      | Content                          | Written by          |
| -------------------- | -------- | -------------------------------- | ------------------- |
| `all_tickets`        | 24 hours | Full ticket list for typeahead   | Cron (4PM ET)       |
| `jira_account_map`   | 24 hours | Jira `accountId` → email mapping | Cron + interactions |
| `slack_user:{email}` | 7 days   | Slack user ID for each email     | Lazy on first send  |

### Invalidation rules

- **`all_tickets`** — Overwritten on every cron run. Expires after 24h, ensuring stale tickets cannot outlive one day even if the cron misses.
- **`jira_account_map`** — Overwritten on every cron and every user interaction. Fresh emails **always overwrite** cached entries (no append-only guard), so corrupted or incomplete mappings self-heal automatically. TTL reduced to 24h (was 7 days) to cap the blast radius of a bad entry.
- **`slack_user:{email}`** — Written once per email (lazy) and cached for 7 days. Slack user IDs are stable; 7 days provides a safety margin if an account is recreated.

### Consistency in Cloudflare Workers KV

KV has eventual consistency (~60 s global propagation). This does **not** affect correctness because:

- **Hours are never cached in KV.** Every validation and confirmation reads directly from the Jira API.
- Cache writes return the in-memory `Map` to the same request, so the issuing Worker sees its own writes immediately.

---

## Troubleshooting

### Bot doesn't send messages / "No summary found" error

- Check that emails in `config/tracker-config.json` exactly match Slack and Jira emails
- The aggregator pre-populates all configured emails with 0 hours, so even users with no worklogs will always get a message. If this error still appears, check that the email is in the `USERS` secret.
- Check logs: `wrangler tail`
- Check that the Slack App has the required scopes and is installed in the workspace

### Bot reports stale hours after logging (e.g. shows 5h after logging 8h)

- This was caused by the `jira_account_map` using an append-only merge strategy that prevented email mappings from being updated. Fixed: the map now always overwrites with the latest email from Jira.
- If the issue persists, manually delete the `jira_account_map` key via the Cloudflare KV dashboard. It will be rebuilt on the next cron run or user interaction.
- Note: hours are always fetched fresh from the Jira API — they are never stored in KV.

### 401 error on Slack interactions

- Check that `SLACK_SIGNING_SECRET` is correct (in Slack App Basic Information, NOT the Bot Token)
- Check that the Interactivity Request URL points to the correct Worker

### Hours not logged in Jira

- Check that `JIRA_API_TOKEN` is valid and not expired
- The email in `JIRA_USER_EMAIL` must have write permissions in the configured projects
- Generic tickets (`genericTickets`) must exist in Jira

### Cron doesn't run at 4PM ET

- The Worker uses two UTC cron triggers (20:00 and 21:00) to cover EDT and EST
- Only one runs the logic based on the real ET hour
- Check with `wrangler tail` that the cron is firing

### Free tier subrequest limit

- Free tier allows 50 subrequests per invocation
- If your team has many users or tickets, consider upgrading to Paid ($5/month → 10K subrequests)

---

## Costs

| Component         | Free Tier    | When to pay                           |
| ----------------- | ------------ | ------------------------------------- |
| Cloudflare Worker | 100K req/day | >100K req/day → $5/month              |
| KV Reads          | 100K/day     | >100K/day                             |
| KV Writes         | 1K/day       | >1K/day                               |
| Cron Triggers     | 5 (we use 2) | >5                                    |
| CPU Time (cron)   | 10ms         | If exceeded → $5/month plan gives 30s |

For a team of up to ~20 people, the free tier should be enough.
