import type {
  Env,
  JiraSearchResponse,
  JiraSearchIssue,
  JiraIssue,
  JiraWorklog,
  JiraRawWorklog,
  JiraWorklogResponse,
  JiraConfig,
  JiraUsers,
} from "../types/index.ts";
import { CACHE_KEY_ACCOUNT_MAP, TTL_ACCOUNT_MAP } from "../constants.ts";
import { getWeekBoundaries } from "../utils/date.ts";

// ─── Helpers ───

function authHeader(env: Env, email?: string, token?: string): string {
  const userEmail = email ?? env.JIRA_USER_EMAIL;
  const apiToken = token ?? env.JIRA_API_TOKEN;
  return "Basic " + btoa(`${userEmail}:${apiToken}`);
}

function baseHeaders(env: Env, email?: string, token?: string): Record<string, string> {
  return {
    "Authorization": authHeader(env, email, token),
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

// ─── Search Issues with Worklogs ───

/**
 * Searches Jira for issues that have worklogs in the given date range.
 * Uses the v3 POST search endpoint with token-based pagination.
 */
export async function searchIssuesWithWorklogs(
  env: Env,
  email?: string,
): Promise<JiraIssue[]> {
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
  const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
  const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
  const users = JSON.parse(env.USERS) as JiraUsers;
  // fetch issues that are in project components, to ensure we get all relevant worklogs for the day.
  const jql = `project in (${boardList}) AND component IN (${componentList})${(email && users[email]) ? ` AND worklogAuthor = currentUser()` : ""}`;

  const fields = [
    "summary", "status", "created", "updated", "assignee", "labels", "components", "worklog"
  ];

  const allIssues: JiraSearchIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const url = `${env.JIRA_BASE_URL}/rest/api/3/search/jql`;
    const resp = await fetch(url, {
      method: "POST",
      headers: baseHeaders(env),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jira search failed (${resp.status}): ${text}`);
      break;
    }

    const data = (await resp.json()) as JiraSearchResponse;
    allIssues.push(...data.issues);
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // Convert raw issues into our normalized type, fetching full worklogs if needed
  const results: JiraIssue[] = [];
  for (const raw of allIssues) {
    const worklogs = await resolveWorklogs(env, raw);
    results.push({
      key: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      assigneeAccountId: raw.fields.assignee?.accountId ?? null,
      assigneeEmail: raw.fields.assignee?.emailAddress ?? null,
      assigneeDisplayName: raw.fields.assignee?.displayName ?? null,
      worklogs,
    });
  }

  return results;
}

/**
 * If the issue's inline worklogs are complete (total <= maxResults), use them.
 * Otherwise, fetch the full worklog list via the dedicated endpoint.
 */
async function resolveWorklogs(env: Env, issue: JiraSearchIssue): Promise<JiraWorklog[]> {
  const wl = issue.fields.worklog;
  if (wl && wl.total <= wl.maxResults) {
    return wl.worklogs.map((w) => mapRawWorklog(w, issue.key, issue.fields.summary));
  }
  return fetchAllWorklogsForIssue(env, issue.key, issue.fields.summary);
}

// ─── Fetch Worklogs for a Single Issue ───

async function fetchAllWorklogsForIssue(
  env: Env,
  issueKey: string,
  issueSummary: string,
): Promise<JiraWorklog[]> {
  const all: JiraWorklog[] = [];
  let startAt = 0;

  do {
    const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=1000`;
    const resp = await fetch(url, {
      method: "GET",
      headers: baseHeaders(env),
    });

    if (!resp.ok) {
      console.error(`Worklog fetch failed for ${issueKey}: ${resp.status}`);
      break;
    }

    const data = (await resp.json()) as JiraWorklogResponse;
    const { monday, friday: weekFriday } = getWeekBoundaries(new Date());
    // 1. Filter worklogs by weekdays (only filter worklogs that fall within the current week, based on their 'started' date)
    const weeklyWorklogs = data.worklogs.filter((w) => {
      // Jira returns the 'started' field in this ISO format: "2026-04-01T12:00:00.000+0000"
      return w.started.substring(0, 10) >= monday && w.started.substring(0, 10) <= weekFriday;
    });

    // 2. Map and insert only those that passed the filter
    all.push(...weeklyWorklogs.map((w) => mapRawWorklog(w, issueKey, issueSummary)));

    if (startAt + data.maxResults >= data.total) break;
    startAt += data.maxResults;
  } while (true);

  return all;
}

function mapRawWorklog(w: JiraRawWorklog, issueKey: string, issueSummary: string): JiraWorklog {
  return {
    id: w.id,
    issueKey,
    issueSummary,
    authorAccountId: w.author.accountId,
    authorEmail: w.author.emailAddress,
    authorDisplayName: w.author.displayName,
    started: w.started,
    timeSpentSeconds: w.timeSpentSeconds,
  };
}

// ─── Post a Worklog ───

/**
 * Posts a new worklog entry to a Jira issue.
 * Returns true on success, false on failure.
 */
export async function postWorklog(
  env: Env,
  issueKey: string,
  dateStr: string,
  timeSpentSeconds: number,
  email: string
): Promise<boolean> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/worklog`;
  const body = {
    started: `${dateStr}T12:00:00.000+0000`,
    timeSpentSeconds,
  };
  const users = JSON.parse(env.USERS) as JiraUsers;

  const resp = await fetch(url, {
    method: "POST",
    headers: baseHeaders(env, email, users[email]),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Post worklog failed for ${issueKey}: ${resp.status} - ${text}`);
    return false;
  }

  return true;
}

// ─── Fetch Issue Details (for generic tickets) ───

export async function fetchIssueSummary(
  env: Env,
  issueKey: string
): Promise<string> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}?fields=summary`;
  const resp = await fetch(url, {
    method: "GET",
    headers: baseHeaders(env),
  });

  if (!resp.ok) return issueKey;

  const data = (await resp.json()) as { fields: { summary: string } };
  return data.fields.summary;
}

// ─── Build accountId → email mapping from search results ───

/**
 * Builds a mapping of Jira accountId to email from the issues' assignees
 * and worklog authors. Caches in KV for 24 hours.
 * Fresh emails always overwrite cached entries to self-heal stale mappings.
 */
export async function buildAccountIdEmailMap(
  env: Env,
  issues: JiraIssue[]
): Promise<Map<string, string>> {
  const cached = await env.CACHE.get(CACHE_KEY_ACCOUNT_MAP, "json");
  const map = new Map<string, string>(
    cached ? Object.entries(cached as Record<string, string>) : []
  );

  let updated = false;

  for (const issue of issues) {
    if (issue.assigneeAccountId && issue.assigneeEmail) {
      const prev = map.get(issue.assigneeAccountId);
      if (prev !== issue.assigneeEmail) {
        map.set(issue.assigneeAccountId, issue.assigneeEmail);
        updated = true;
      }
    }
    for (const wl of issue.worklogs) {
      if (wl.authorEmail) {
        const prev = map.get(wl.authorAccountId);
        if (prev !== wl.authorEmail) {
          map.set(wl.authorAccountId, wl.authorEmail);
          updated = true;
        }
      }
    }
  }

  if (updated) {
    await env.CACHE.put(CACHE_KEY_ACCOUNT_MAP, JSON.stringify(Object.fromEntries(map)), {
      expirationTtl: TTL_ACCOUNT_MAP,
    });
  }

  return map;
}
