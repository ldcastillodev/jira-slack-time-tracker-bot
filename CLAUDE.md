# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that DMs each configured user a daily Jira-hours report in Slack (4PM ET, Mon–Fri) and lets them log worklogs back to Jira interactively from the message. UI text is in **Spanish** — keep it that way. Code/comments are English.

## Commands

```bash
npm run dev          # wrangler dev --env-file .env.dev (local worker)
npm run check        # tsc --noEmit (type-check)
npm run build        # wrangler deploy --dry-run
npm test             # vitest run (Workers pool / miniflare)
npm run test:watch   # single file: npx vitest run tests/services/jira.test.ts
npm run lint         # eslint .  (lint:fix to autofix)
npm run format       # prettier --write  (format:check in CI)
npm run deploy       # wrangler deploy (prod); add --env test for test env
npm run tail         # stream live worker logs
```

Pre-commit hook (`.husky/pre-commit`) runs format → lint-staged → test → check. Node 22 (`.nvmrc`). Tests use `@cloudflare/vitest-pool-workers` with in-memory bindings defined in `vitest.config.mts` (real env vars are NOT loaded in tests).

## CI/CD

- `pull-request.yaml`: lint → test → build on PRs to `develop`/`master`.
- `develop` push → `wrangler deploy --env test` (test worker).
- `master` push → `wrangler deploy` (production).

## Architecture

`src/index.ts` is the only Worker entrypoint. It exposes `fetch` (HTTP router) and `scheduled` (cron). Flow per layer:

- **handlers/** — entry points; parse/verify the request, then call services. `cron.ts` (scheduled summary + ticket-cache refresh), `slack-command.ts` (slash commands), `slack-interaction.ts` (button/submit actions), `slack-options.ts` (typeahead).
- **services/** — `jira.ts` (all Jira REST calls + KV caching), `slack.ts` (chat.postMessage, users.lookupByEmail, response_url updates), `aggregator.ts` (pure functions: roll worklogs into daily/weekly/by-component summaries).
- **builders/message-builder.ts** — turns aggregated data into Slack Block Kit blocks.
- **utils/** — `crypto.ts` (Slack signature HMAC), `date.ts` (all ET-timezone date math).
- **config/** — `config.ts` loads/validates `tracker-config.json` (the only non-secret, in-repo config).

### Three separate config sources — do not confuse them

1. **`config/tracker-config.json`** (in repo, via `loadConfig()`): targets + timezone (`dailyTarget` 8, `weeklyTarget` 40, `cronHourET` 16).
2. **`JIRA_CONFIG`** secret (JSON string): `{ jira: { boards, projectComponents, genericTickets } }` — drives the JQL and the typeahead seed list. Parsed with `JSON.parse(env.JIRA_CONFIG)`.
3. **`USERS`** secret (JSON string): maps `email → that user's personal Jira API token`. This is the linchpin of the auth model (see below).

### Per-user Jira auth (critical)

Reports use the service account (`JIRA_USER_EMAIL` / `JIRA_API_TOKEN`). But any action _on behalf of a user_ — `searchTicketsForUser` (uses `worklogAuthor = currentUser()`) and `postWorklog` — authenticates with **that user's own token from `USERS`** via `baseHeaders(env, email, users[email])`. Using the service account there would make `currentUser()` resolve wrong and log hours under the wrong person. When touching Jira calls, be deliberate about which credential you pass.

### Cron + DST handling

`wrangler.toml` registers two UTC cron times per job to straddle EST/EDT (`crons = ["0 20 * * 2-6", "0 15 * * *"]`, plus the off-by-one cases handled in `index.ts`'s switch). The handler then guards with `getCurrentHourET() !== config.tracking.cronHourET` and returns early — so it actually fires once at 4PM ET regardless of DST. `index.ts` dispatches by `controller.cron` string; if you change cron times, update both `wrangler.toml` and the `switch` cases.

### Slack request lifecycle

Every Slack endpoint first calls `verifySlackSignature` (HMAC-SHA256, 5-min replay window) and returns 401 on failure — never skip this. Slack requires a response within **3 seconds**, so handlers reply immediately with an ephemeral "loading" message and run the real work in `ctx.waitUntil(...)`, posting the result back via `response_url` (`updateMessageViaResponseUrl`). The `submit_hours` interaction runs a strict validation chain (week-boundary → partial-slot → duplicate → daily-limit → **re-fetch Jira for stale-data guard** → post). `targetDate` is encoded in button `value`s so a click the next day still logs to the right date and is rejected if it falls outside the current ISO week.

### KV cache (`CACHE` binding)

- `slack_user:<email>` → Slack user ID (7d TTL).
- `jira_account_map` → accountId→email map (24h; self-heals — fresh emails overwrite).
- `all_tickets` → full ticket list for typeahead (7d TTL constant, refreshed daily by the 11AM ET cron / `/refresh-tickets`).

### Aggregation model

`aggregator.ts` functions are pure (no I/O) — test them directly. They pre-populate all configured `USERS` emails with 0 hours (so inactive users still get a message) and dynamically add anyone else found in worklogs/assignees. Emails are keyed lowercase throughout.

## Conventions

- ESM with **explicit `.ts` extensions** in imports (`allowImportingTsExtensions`) — required, not optional.
- Worker runtime: `nodejs_compat` flag is on, but prefer Web APIs (`fetch`, `crypto.subtle`) over Node built-ins.
- Jira `started` timestamps are ISO like `2026-04-01T12:00:00.000+0000`; date comparisons slice `.substring(0,10)` and compare yyyy-MM-dd strings.
- Jira search uses the v3 POST `/rest/api/3/search/jql` endpoint with `nextPageToken` pagination (not `startAt`).

## Local dev

`npm run dev` reads `.env.dev` (gitignored; see `.env.example`). Secrets in prod/test are set via `wrangler secret put <NAME> [--env test]`: `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `USERS`, `JIRA_CONFIG`. KV namespace IDs live in `wrangler.toml`.
