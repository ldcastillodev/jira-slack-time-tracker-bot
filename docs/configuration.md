# Configuration Reference

## tracker-config.json

`config/tracker-config.json` — static tracking thresholds only. Loaded and validated by `config/config.ts`.

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

| Field | Description |
|-------|-------------|
| `tracking.dailyTarget` | Daily hour goal (default: 8) |
| `tracking.weeklyTarget` | Weekly hour goal (default: 40) |
| `tracking.timezone` | IANA timezone string for ET calculations |
| `tracking.cronHourET` | ET hour for daily notifications (default: 16 = 4PM) |

---

## Worker Secrets

Set via `wrangler secret put <NAME>` for production, or `--env test` for the test environment. For local dev, set in `.dev.vars`.

### `JIRA_CONFIG`

JSON string with Jira project configuration. Parsed at runtime as `JiraConfig`.

```json
{
  "jira": {
    "boards": ["MP", "PROJ2"],
    "genericTickets": [
      { "key": "MP-100", "summary": "Client requested meetings" },
      { "key": "MP-101", "summary": "Others" }
    ],
    "projectComponents": [
      { "name": "Backend" },
      { "name": "Frontend" }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `jira.boards` | Jira project keys included in JQL worklog queries |
| `jira.genericTickets` | Predefined tickets always shown in the dropdown. Must exist in Jira. Field is `summary` (not `label`). |
| `jira.projectComponents` | Component filter in JQL: `component IN (...)`. Narrows worklog search to components relevant to time tracking. Omitting components would fetch all tickets in the project. |

### `USERS`

JSON object mapping each tracked user's email to their individual Jira API token. Each user's token is used when posting worklogs on their behalf so worklogs are attributed to the correct Jira account.

```json
{
  "john.doe@company.com": "ATATT3xFfGF0...",
  "jane.smith@company.com": "ATATT3xFfGF1..."
}
```

Parsed as `{ [email: string]: string }` (type `JiraUsers` in `src/types/index.ts`).

### `JIRA_API_TOKEN` / `JIRA_USER_EMAIL`

Service account credentials used for read-only operations (fetching tickets and worklogs). Recommendation: use a dedicated service account, not a personal account.

### `SLACK_BOT_TOKEN`

Bot User OAuth Token (`xoxb-...`). Found in Slack App → OAuth & Permissions after installing to workspace.

Required scopes: `chat:write`, `users:read.email`, `im:write`, `commands`.

### `SLACK_SIGNING_SECRET`

Found in Slack App → Basic Information. Used for HMAC-SHA256 request verification on all incoming webhooks. Not the same as the Bot Token.

---

## wrangler.toml Variables

| Variable | Location | Description |
|----------|----------|-------------|
| `JIRA_BASE_URL` | `[vars]` | Jira Cloud base URL, e.g. `https://company.atlassian.net` |

---

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in values. `JIRA_CONFIG` and `USERS` must be valid JSON strings (single-line).

```env
JIRA_API_TOKEN=ATATT3xFfGF0...
JIRA_USER_EMAIL=service@company.com
SLACK_BOT_TOKEN=xoxb-123456-789...
SLACK_SIGNING_SECRET=abc123def456...
JIRA_CONFIG={"jira":{"boards":["MP"],"genericTickets":[{"key":"MP-100","summary":"Meetings"}],"projectComponents":[{"name":"Backend"}]}}
USERS={"john@company.com":"ATATT3x..."}
```
