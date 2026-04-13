// ─── Cache Keys ───

export const CACHE_KEY_ALL_TICKETS = "all_tickets";
export const CACHE_KEY_ACCOUNT_MAP = "jira_account_map";
export const CACHE_KEY_SLACK_USER_PREFIX = "slack_user:";

// ─── Cache TTLs (seconds) ───

export const TTL_ALL_TICKETS = 7 * 24 * 3_600; // 7 days
export const TTL_ACCOUNT_MAP = 86_400; // 24 hours
export const TTL_SLACK_USER = 7 * 24 * 3_600; // 7 days

// ─── Jira Ticket fields ───
export const JIRA_TICKET_FIELDS = [
  "summary",
  "status",
  "created",
  "updated",
  "assignee",
  "labels",
  "components",
  "worklog",
];

export const GENERIC_JIRA_TICKET_FIELDS = ["key", "summary"];
