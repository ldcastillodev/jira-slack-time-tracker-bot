# Architecture

## Module Map

```
src/
├── index.ts                      # Entry: routes fetch + scheduled handlers
├── handlers/
│   ├── cron.ts                   # 4PM ET summary + 11AM ET ticket refresh
│   ├── slack-command.ts          # /submit, /summary, /summary-components, /refresh-tickets, /help
│   ├── slack-interaction.ts      # Interactive button webhooks (submit_hours, add_slot)
│   └── slack-options.ts          # external_select typeahead endpoint
├── services/
│   ├── jira.ts                   # Jira REST API v3 client + ticket cache writer
│   ├── slack.ts                  # Slack Web API + KV-backed user ID cache
│   └── aggregator.ts             # Hours aggregation (daily, weekly, by component)
├── builders/
│   └── message-builder.ts        # Block Kit message construction
├── utils/
│   ├── date.ts                   # Date/timezone utilities (ET-aware)
│   └── crypto.ts                 # HMAC-SHA256 Slack signature verification
├── types/index.ts                # All TypeScript interfaces
└── constants/constants.ts        # KV cache keys and TTL values
config/
├── config.ts                     # Loads and validates tracker-config.json
└── tracker-config.json           # Tracking thresholds (dailyTarget, cronHourET, etc.)
```

---

## HTTP Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `GET` | `/health` | inline | Returns `OK` |
| `POST` | `/slack/interactions` | `handleSlackInteraction` | Button clicks: `submit_hours`, `add_slot` |
| `POST` | `/slack/options` | `handleSlackOptions` | `external_select` typeahead responses |
| `POST` | `/slack/commands` | `handleSlackCommand` | All slash commands |
| `POST` | `/trigger` | inline | Manual cron trigger (dev/testing only) |

---

## Cron Schedule

Two cron expressions registered in `wrangler.toml`:

| Cron | UTC | ET (approx.) | Handler | Days |
|------|-----|------|---------|------|
| `0 20 * * 1-5` | 8 PM | 4 PM EDT | `handleScheduledSummary` | Mon–Fri |
| `0 15 * * *` | 3 PM | 11 AM EDT | `handleScheduledTicketsRefresh` | Daily |

The handler switch in `src/index.ts` also handles `0 21 * * 1-5` and `0 16 * * *` to cover EST (UTC-5) during winter. `getCurrentHourET()` confirms the actual ET hour before executing — only one of the two cases fires depending on DST.

### 4PM ET Summary Flow (`handleScheduledSummary`)

```
1. Load tracker-config.json → parse JIRA_CONFIG + USERS from env
2. getCurrentHourET() !== cronHourET → skip (DST guard)
3. searchAllTicketsWithWorklogs → JQL: boards + components + worklogDate >= -1w
4. buildAccountIdEmailMap → writes KV jira_account_map (24h TTL)
5. refreshJiraTicketsCache → writes KV all_tickets (7d TTL)
6. aggregateUserHours → daily Map<email, UserHoursSummary>
7. If Friday: aggregateWeeklyHours → weekly Map<email, WeeklyBreakdown>
8. For each user:
   a. lookupUserByEmail → KV slack_user:{email} (7d TTL, lazy)
   b. buildDailyMessage + (if Friday) buildWeeklyMessage
   c. sendDirectMessage → Slack Web API
```

### 11AM ET Ticket Refresh Flow (`handleScheduledTicketsRefresh`)

Runs `refreshJiraTicketsCache` — fetches all project tickets and writes `all_tickets` to KV (7d TTL). Keeps the typeahead cache fresh even on days the summary cron doesn't fire (weekends).

---

## KV Cache

All keys and TTLs defined in `src/constants/constants.ts`.

| KV Key | TTL | Content | Written by |
|--------|-----|---------|-----------|
| `all_tickets` | 7 days | `CachedTicket[]` — full ticket list for typeahead | Cron 4PM, Cron 11AM, `/refresh-tickets` |
| `jira_account_map` | 24 hours | `{ [accountId]: email }` mapping | Cron 4PM, every interaction |
| `slack_user:{email}` | 7 days | Slack user ID string | Lazy on first DM send |

**Consistency:** KV has ~60s eventual consistency globally. Hours are never cached — every validation reads directly from the Jira API. `jira_account_map` self-heals on every write (overwrites, no append-only guard).

---

## Multi-Slot Interaction Flow

### `submit_hours`

```
POST /slack/interactions (action_id = "submit_hours")
  ├── Verify HMAC-SHA256 Slack signature
  ├── Parse state.values → detect slot count dynamically
  ├── Validate in order:
  │     1. Calendar week — targetDate in same ISO week as now (ET)
  │     2. Partial data — each slot has both ticket + hours, or is empty
  │     3. At least 1 complete slot
  │     4. No duplicate ticket keys across slots
  │     5. Sum of submitted hours ≤ dailyTarget
  │     6. Stale-data guard — re-fetch Jira: actualHours + submittedTotal ≤ dailyTarget
  └── POST worklogs one-by-one using per-user Jira API token from USERS secret
```

### `add_slot`

```
POST /slack/interactions (action_id = "add_slot")
  ├── Parse button value: "{slotCount}:{targetDate}"
  ├── Read existing selections from state.values (preserve user input)
  └── Rebuild Block Kit with slotCount+1 slots (max 10)
```

### `targetDate` Encoding

The Submit button's `value` encodes the date for which the alert was generated (e.g. `2026-04-02`). This ensures worklogs are posted to the correct date even if the user clicks the next day, and allows the stale-data guard to reject submissions for past ISO weeks.

---

## Ticket Typeahead (`external_select`)

`external_select` selectors use `min_query_length: 0`:
- Opening the selector shows all cached tickets grouped as "📌 Generic Tickets" and "📋 Project Tickets"
- Typing filters by key or summary from the full cache (no 100-item Slack limit)
- `/slack/options` reads from KV `all_tickets` and returns `option_groups`
