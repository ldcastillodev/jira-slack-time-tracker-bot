# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Local dev server (port 8787)
npm test             # Run tests once
npm run test:watch   # Watch mode
npm run test:coverage
npm run lint         # ESLint check
npm run lint:fix
npm run format       # Prettier auto-format
npm run check        # TypeScript type check (no emit)
npm run build        # Wrangler dry-run deploy
npm run deploy       # Deploy to production
npm run tail         # Stream live logs from deployed Worker
```

Run single test file: `npx vitest run tests/handlers/cron.test.ts`

Local trigger (requires `.env.dev`): `curl -X POST http://localhost:8787/trigger`

## Architecture

Cloudflare Workers app (TypeScript) that sends daily Slack DMs prompting users to log Jira worklogs. No database — Jira is source of truth; Cloudflare KV is cache only.

**Entry point:** `src/index.ts` exports `{ fetch, scheduled }`.

**Two cron triggers** (dual UTC entries per cron to handle EDT/EST DST — handler checks `getCurrentHourET()` and exits early if wrong hour):
- 4 PM ET → `handleScheduledSummary()` — DMs every configured user with hours logged + interactive form
- 11 AM ET → `handleScheduledTicketsRefresh()` — refreshes KV ticket typeahead cache

**HTTP endpoints:**
- `POST /slack/interactions` → `handleSlackInteraction` (button clicks: submit, add_slot)
- `POST /slack/options` → `handleSlackOptions` (typeahead ticket suggestions)
- `POST /slack/commands` → `handleSlackCommand` (`/submit`, `/summary`, `/summary-components`, `/refresh-tickets`, `/help`)
- `POST /trigger` → manual cron trigger for dev
- `GET /health`

**Service layer (`src/services/`):**
- `jira.ts` — Jira REST API v3: search tickets (JQL), post worklogs, refresh KV cache, build accountId↔email map
- `slack.ts` — Slack Web API: lookup user by email (KV cached), send DMs, update messages via response URL
- `aggregator.ts` — roll up raw worklogs into daily/weekly/component breakdowns

**Handlers (`src/handlers/`):** cron, slack-interaction, slack-command, slack-options

**Builder:** `src/builders/message-builder.ts` — all Slack Block Kit message construction

**Utils:** `src/utils/date.ts` (ET timezone helpers), `src/utils/crypto.ts` (HMAC-SHA256 Slack signature verification)

## KV Cache Keys

| Key | TTL | Contents |
|-----|-----|----------|
| `all_tickets` | 7 days | Typeahead ticket list |
| `jira_account_map` | 24h | accountId ↔ email map |
| `slack_user:{email}` | 7 days | Slack user ID |

## Environment / Secrets

| Variable | Notes |
|----------|-------|
| `JIRA_API_TOKEN` | Service account token (for reads/search) |
| `JIRA_USER_EMAIL` | Service account email |
| `JIRA_BASE_URL` | e.g. `https://applydigital.atlassian.net` |
| `SLACK_BOT_TOKEN` | Scopes: `chat:write`, `users:read.email`, `im:write`, `commands` |
| `SLACK_SIGNING_SECRET` | Webhook signature verification |
| `JIRA_CONFIG` | JSON: `{ jira: { boards, genericTickets, projectComponents } }` |
| `USERS` | JSON: `{ "email": "jira-api-token" }` — each user posts worklogs with their own token |

Local dev: secrets go in `.env.dev` (not committed). See `docs/configuration.md` for JSON formats.

## Testing

Tests run in real Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers`. Miniflare bindings (mock secrets, KV) are configured in `vitest.config.mts`.

Structure mirrors `src/`: `tests/builders/`, `tests/handlers/`, `tests/services/`, `tests/utils/`, `tests/integration/`.

## Key Behaviors to Know

**DST handling:** Two cron entries per schedule (e.g. `0 20 * * 2-6` and `0 21 * * 2-6`). Handler checks actual ET hour via `getCurrentHourET()` and no-ops if it doesn't match `config.cronHourET`.

**Hours submission validation (in order):** same ISO week, each slot complete or empty, ≥1 slot, no duplicate tickets, sum ≤ dailyTarget, stale-data re-check against Jira.

**Per-user Jira tokens:** worklogs posted with the submitting user's token (from `USERS` secret), not the service account. The service account is only used for reads.

**Typeahead:** `external_select` with `min_query_length: 0`. Results grouped as "📌 Generic" + "📋 Project" from `all_tickets` KV.

## Code Style

Prettier: 100-char width, 2-space indent, trailing commas, double quotes, semicolons. ESLint: strict TypeScript-ESLint; `_`-prefixed vars are allowed to be unused. Pre-commit hooks (Husky + lint-staged) auto-fix staged `.ts` files.
