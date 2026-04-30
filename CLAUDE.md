# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: Jira Time Tracker Bot

### Key gotchas

**Slash command is `/submit`** — not `/daily-summary`. Anywhere you see `/daily-summary` is a stale reference.

**Config is split across three locations:**

- `config/tracker-config.json` — tracking thresholds only (`dailyTarget`, `weeklyTarget`, `timezone`, `cronHourET`)
- `JIRA_CONFIG` secret — JSON string: `{ jira: { boards, genericTickets, projectComponents } }`
- `USERS` secret — JSON string: `{ "email@company.com": "jira_api_token" }` (per-user tokens, not an array)

**`projectComponents` in `JIRA_CONFIG` is required** — used in JQL `component IN (...)` to scope worklog queries. Missing it breaks ticket fetching.

**File paths that differ from what you'd expect:**

- Config loader: `config/config.ts` (not `src/config.ts`)
- Cache constants: `src/constants/constants.ts` (not `src/constants.ts`)

**KV TTLs** (from `src/constants/constants.ts`):

- `all_tickets` → 7 days
- `jira_account_map` → 24 hours
- `slack_user:{email}` → 7 days

**Two cron triggers** registered in `wrangler.toml`:

- `0 20 * * 1-5` → 4PM ET daily summary (Mon–Fri), handler is `handleScheduledSummary`
- `0 15 * * *` → 11AM ET ticket cache refresh (daily), handler is `handleScheduledTicketsRefresh`
- Code also handles `0 21` / `0 16` variants for EST (winter DST) but they're not registered

**Hours are never cached in KV** — always fetched live from Jira on every validation.

### Docs

`docs/` directory exists with: `configuration.md`, `architecture.md`, `slash-commands.md`, `ci-cd.md`. Keep these in sync when changing cron schedule, KV keys, commands, or config structure.
