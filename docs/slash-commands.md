# Slash Commands Reference

All commands are registered in Slack App → Slash Commands and all point to the same endpoint: `POST /slack/commands`.

## Available Commands

| Command | Description |
|---------|-------------|
| `/summary` | Weekly hour summary — Mon–Fri total vs. 40h target, day-by-day breakdown per ticket |
| `/summary-components` | Weekly summary grouped by Jira component |
| `/submit [day]` | Daily summary for a specific day with interactive hour logging form |
| `/refresh-tickets` | Manually refresh the Jira ticket typeahead cache |
| `/help` | List available commands |

---

## `/submit` Validation Rules

`/submit` accepts an optional Spanish day abbreviation for the current week.

| Input | Behavior |
|-------|----------|
| No param, weekday | Today's summary + interactive form |
| No param, weekend | Error: use `/submit lun\|mar\|mie\|jue\|vie` |
| Invalid abbreviation | Error: must be one of `lun`, `mar`, `mie`, `jue`, `vie` |
| Future day this week | Error: future days not allowed |
| Any day from a past week | Error: only current week |

Valid abbreviations: `lun` (Monday), `mar` (Tuesday), `mie` (Wednesday), `jue` (Thursday), `vie` (Friday).

```bash
/submit            # Today's summary (Mon–Fri only)
/submit lun        # Monday of the current week
/submit jue        # Thursday of the current week
```

---

## Slash Command Flow

1. Slack sends `POST /slack/commands` (form-urlencoded)
2. Bot verifies HMAC-SHA256 signature via `SLACK_SIGNING_SECRET`
3. Returns ephemeral loading message immediately (within Slack's 3-second limit)
4. `ctx.waitUntil(...)` — fetches Jira data asynchronously, builds Block Kit, posts via `response_url`

If user identity cannot be resolved (email not in `USERS` secret or not in Slack), an ephemeral error is sent.

---

## Adding a New Command

Register the command in Slack App → Slash Commands pointing to the deployed `/slack/commands` URL. Add a case to `src/handlers/slack-command.ts`:

```typescript
case "/mycommand":
  ctx.waitUntil(processMyCommand(payload.user_id, payload.response_url, env));
  return jsonResponse({ response_type: "ephemeral", text: "⏳ Procesando..." });
```

The async processor receives `response_url` and posts results back via `updateMessageViaResponseUrl` from `src/services/slack.ts`.
