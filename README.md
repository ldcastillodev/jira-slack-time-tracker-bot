# Jira Time Tracker Bot

Interactive bot for daily hour logging, integrating **Jira** and **Slack** on **Cloudflare Workers**.

## What does it do?

Every weekday at **4:00 PM ET**, the bot:

1. Reads Jira worklogs from the configured boards.
2. Calculates the hours logged by each person for the day.
3. Sends a direct message (DM) in Slack to each configured user with:

| Scenario | Behavior |
|----------|----------|
| **< 8h logged** | Shows the breakdown + **dynamic interactive slots** (3 by default, expandable up to 10 with the "➕ Add ticket" button) to log hours in multiple tickets at once (0.5h intervals). Tickets are searched with typeahead (no 100 limit). Validates duplicates, partial data, daily limit, and stale data against Jira in real time. |
| **= 8h logged** | Shows only the breakdown as confirmation. No interactive options. |
| **Friday** | In addition to the daily report, includes a weekly summary with the total vs. the 40h goal and a day-by-day breakdown. |

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
│  ┌──────────┐                                            │
│  │ Workers  │  Cache: Slack user IDs, Jira accountId     │
│  │   KV     │  → email map, all_tickets (typeahead)      │
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

The ticket cache updates automatically on each cron run (4PM ET) and is stored in KV with key `all_tickets`.

### `targetDate` Encoding

The Submit button's `value` field contains the target date (e.g., `2026-04-02`) for which the alert was generated. This allows:
- Logging hours for **the correct date** even if the user clicks a day later.
- **Rejecting** the log if the current date is no longer in the same ISO calendar week (Monday–Sunday).

The "➕ Add ticket" button encodes `{slotCount}:{targetDate}` in its `value` to preserve context.

### Validation Rules (Backend)

On submit, the backend dynamically detects the number of slots from `state.values` and runs this validation chain in order:

| # | Validation | Behavior if fails |
|---|------------|-------------------|
| 1 | **Calendar week** — `targetDate` must be in the same ISO week as the current date (ET) | Replaces the message with a period expired notice |
| 2 | **Partial data** — Each slot must have both fields (ticket + hours) or be empty | Error indicating which slot(s) are incomplete |
| 3 | **At least 1 slot** — At least one complete slot is required | Error requesting at least one complete slot |
| 4 | **Duplicate tickets** — Same ticket not allowed in more than one slot | Error indicating duplication |
| 5 | **Sum vs. limit** — Total submitted must not exceed `dailyTarget` (8h) | Error with the submitted total |
| 6 | **Stale-data guard** — Jira is re-fetched for actual hours. `actualHours + submittedTotal ≤ dailyTarget` | Replaces message with real balance and new interactive slots |
| 7 | **POST worklogs** — Worklogs are sent one by one | If any fail, reports which and confirms the successful ones |

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

#### Interactivity & Shortcuts
- **Enable Interactivity**
- **Request URL**: `https://jira-time-tracker-bot.<your-account>.workers.dev/slack/interactions`
- **Options Load URL**: `https://jira-time-tracker-bot.<your-account>.workers.dev/slack/options`
  _(update both URLs after deploy)_

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
  "users": [
    "john.doe@applydigital.com",
    "jane.smith@applydigital.com"
  ]
}
```

| Field | Description |
|-------|-------------|
| `jira.boards` | Jira project keys to search for worklogs |
| `jira.genericTickets` | Predefined tickets always shown in the dropdown (must exist in Jira) |
| `tracking.dailyTarget` | Daily hour goal (default: 8) |
| `tracking.weeklyTarget` | Weekly hour goal (default: 40) |
| `tracking.cronHourET` | ET hour for notifications (default: 16 = 4PM) |
| `users` | List of emails to receive notifications |

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

The project includes a GitHub Actions workflow with two stages:
- `build`: runs on pushes and pull requests to `master`, installs dependencies, runs type-check, and generates the Worker bundle with `wrangler deploy --dry-run`
- `deploy`: runs only on pushes to `master` and only if the build job passed

### Set secrets in GitHub

In your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | Description | How to get it |
|--------|-------------|--------------|
| `CLOUDFLARE_API_TOKEN` | API token with `Workers Scripts:Edit` permissions | [Cloudflare Dashboard → API Tokens → Create Token](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Cloudflare Dashboard → Overview (right sidebar) |

> **Note**: Jira and Slack secrets are not needed in GitHub — they're set in Cloudflare via `wrangler secret put`.

Recommended variables and secrets:
- GitHub `Secrets`: only CI/CD credentials, e.g. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
- Cloudflare Worker Secrets: `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `USERS`, `JIRA_CONFIG`
- `wrangler.toml`: non-sensitive, static values, e.g. bindings, cron, and `JIRA_BASE_URL` if not sensitive
- GitHub `Variables`: only if you need non-sensitive pipeline-only parameters later; not needed today

### Workflow flow

```
push/pull_request master → checkout → setup-node@20 → npm ci → tsc --noEmit → wrangler deploy --dry-run
push master + build OK → wrangler deploy
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
├── config/
│   └── tracker-config.json         # Boards, users, tickets, thresholds
├── wrangler.toml                   # CF Worker config + cron
├── tsconfig.json
├── package.json
├── .dev.vars.example               # Secret template
├── .github/
│   └── workflows/
│       └── deploy.yml              # CI/CD: auto-deploy on push to main
├── .gitignore
└── README.md
```

---

## Troubleshooting

### Bot doesn't send messages
- Check that emails in `config/tracker-config.json` exactly match Slack and Jira emails
- Check logs: `wrangler tail`
- Check that the Slack App has the required scopes and is installed in the workspace

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

| Component | Free Tier | When to pay |
|-----------|-----------|-------------|
| Cloudflare Worker | 100K req/day | >100K req/day → $5/month |
| KV Reads | 100K/day | >100K/day |
| KV Writes | 1K/day | >1K/day |
| Cron Triggers | 5 (we use 2) | >5 |
| CPU Time (cron) | 10ms | If exceeded → $5/month plan gives 30s |

For a team of up to ~20 people, the free tier should be enough.
