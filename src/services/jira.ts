import type {
  Env,
  JiraSearchResponse,
  JiraSearchIssue,
  JiraIssue,
  JiraWorklog,
  JiraRawWorklog,
  JiraWorklogResponse,
} from "../types/index.ts";

// ─── Helpers ───

function authHeader(env: Env): string {
  return "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
}

function baseHeaders(env: Env): Record<string, string> {
  return {
    Authorization: authHeader(env),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── Search Issues with Worklogs ───

/**
 * Searches Jira for issues that have worklogs in the given date range.
 * Uses the v3 POST search endpoint with token-based pagination.
 */
export async function searchIssuesWithWorklogs(
  env: Env,
  boards: string[],
  dateFrom: string,
  dateTo: string
): Promise<JiraIssue[]> {
  const boardList = boards.map((b) => `"${b}"`).join(", ");
  const jql = `project in (${boardList}) AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;
  const fields = ["summary", "status", "assignee", "worklog"];

  const allIssues: JiraSearchIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields,
      validation: "strict",
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
  issueSummary: string
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
    all.push(...data.worklogs.map((w) => mapRawWorklog(w, issueKey, issueSummary)));

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
  timeSpentSeconds: number
): Promise<boolean> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/worklog`;
  const body = {
    started: `${dateStr}T12:00:00.000+0000`,
    timeSpentSeconds,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: baseHeaders(env),
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
 * and worklog authors. Caches in KV for 7 days.
 */
export async function buildAccountIdEmailMap(
  env: Env,
  issues: JiraIssue[]
): Promise<Map<string, string>> {
  const KV_KEY = "jira_account_map";
  const cached = await env.CACHE.get(KV_KEY, "json");
  const map = new Map<string, string>(
    cached ? Object.entries(cached as Record<string, string>) : []
  );

  let updated = false;

  for (const issue of issues) {
    if (issue.assigneeAccountId && issue.assigneeEmail && !map.has(issue.assigneeAccountId)) {
      map.set(issue.assigneeAccountId, issue.assigneeEmail);
      updated = true;
    }
    for (const wl of issue.worklogs) {
      if (wl.authorEmail && !map.has(wl.authorAccountId)) {
        map.set(wl.authorAccountId, wl.authorEmail);
        updated = true;
      }
    }
  }

  if (updated) {
    await env.CACHE.put(KV_KEY, JSON.stringify(Object.fromEntries(map)), {
      expirationTtl: 7 * 24 * 3600,
    });
  }

  return map;
}
