import type {
  Env,
  JiraSearchResponse,
  JiraSearchTicket,
  JiraTicket,
  JiraWorklog,
  JiraRawWorklog,
  JiraWorklogResponse,
  JiraConfig,
  JiraUsers,
  GenericTicket,
  CachedTicket,
} from "../types/index.ts";
import {
  CACHE_KEY_ACCOUNT_MAP,
  CACHE_KEY_ALL_TICKETS,
  GENERIC_JIRA_TICKET_FIELDS,
  JIRA_TICKET_FIELDS,
  TTL_ACCOUNT_MAP,
  TTL_ALL_TICKETS,
} from "../constants/constants.ts";
import { getWeekBoundaries } from "../utils/date.ts";

// ─── Helpers ───

function authHeader(env: Env, email?: string, token?: string): string {
  const userEmail = email ?? env.JIRA_USER_EMAIL;
  const apiToken = token ?? env.JIRA_API_TOKEN;
  return "Basic " + btoa(`${userEmail}:${apiToken}`);
}

function baseHeaders(env: Env, email?: string, token?: string): Record<string, string> {
  return {
    Authorization: authHeader(env, email, token),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── Search tickets with Worklogs ───

/**
 * Searches Jira for tickets that have worklogs in 1 week date range.
 * Uses the v3 POST search endpoint with token-based pagination.
 */
export async function searchAllTicketsWithWorklogs(env: Env): Promise<JiraTicket[]> {
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
  const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
  const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
  // fetch tickets that are in project components, to ensure we get all relevant worklogs for the day.
  const jql = `project in (${boardList}) AND component IN (${componentList}) AND worklogDate >= -1w`;

  const allTickets: JiraSearchTicket[] = [];
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields: JIRA_TICKET_FIELDS,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const url = `${env.JIRA_BASE_URL}/rest/api/3/search/jql`;
    const searchHeaders = baseHeaders(env);
    const resp = await fetch(url, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jira search failed (${resp.status}): ${text}`);
      break;
    }

    const data = (await resp.json()) as JiraSearchResponse;
    allTickets.push(...data.issues);
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // Convert raw tickets into our normalized type, fetching full worklogs if needed
  const results: JiraTicket[] = [];
  for (const raw of allTickets) {
    const worklogs = await resolveWorklogs(env, raw);
    results.push({
      key: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      assigneeAccountId: raw.fields.assignee?.accountId ?? null,
      assigneeEmail: raw.fields.assignee?.emailAddress ?? null,
      assigneeDisplayName: raw.fields.assignee?.displayName ?? null,
      components: raw.fields.components?.map((c) => c.name) ?? [],
      worklogs,
    });
  }

  return results;
}

// ─── Search All tickets ───

/**
 * Searches Jira for all tickets in the project.
 * Uses the v3 POST search endpoint with token-based pagination.
 */
export async function searchAllTickets(env: Env): Promise<GenericTicket[]> {
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
  const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
  const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
  // fetch tickets that are in project components, to ensure we get all relevant worklogs for the day.
  const jql = `project in (${boardList}) AND component IN (${componentList})`;

  const allTickets: JiraSearchTicket[] = [];
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields: GENERIC_JIRA_TICKET_FIELDS,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const url = `${env.JIRA_BASE_URL}/rest/api/3/search/jql`;
    const searchHeaders = baseHeaders(env);
    const resp = await fetch(url, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jira search failed (${resp.status}): ${text}`);
      break;
    }

    const data = (await resp.json()) as JiraSearchResponse;
    allTickets.push(...data.issues);
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // Convert raw tickets into our normalized Generic Ticket type,
  const results: GenericTicket[] = [];
  for (const raw of allTickets) {
    results.push({
      key: raw.key,
      summary: raw.fields.summary,
    });
  }

  return results;
}

export async function searchTicketsForUser(env: Env, email: string): Promise<JiraTicket[]> {
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
  const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
  const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
  const users = JSON.parse(env.USERS) as JiraUsers;
  const jql = `project in (${boardList}) AND component IN (${componentList}) AND worklogDate >= -1w AND worklogAuthor = currentUser()`;
  const allTickets: JiraSearchTicket[] = [];

  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields: JIRA_TICKET_FIELDS,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const url = `${env.JIRA_BASE_URL}/rest/api/3/search/jql`;
    // When searching on behalf of a specific user, use their credentials so that
    // currentUser() in the JQL resolves to that user and not the service account.
    const searchHeaders = baseHeaders(env, email, users[email]);
    const resp = await fetch(url, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jira search failed (${resp.status}): ${text}`);
      break;
    }

    const data = (await resp.json()) as JiraSearchResponse;
    allTickets.push(...data.issues);
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // Convert raw tickets into our normalized type, fetching full worklogs if needed
  const results: JiraTicket[] = [];
  for (const raw of allTickets) {
    const worklogs = await resolveWorklogs(env, raw);
    results.push({
      key: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      assigneeAccountId: raw.fields.assignee?.accountId ?? null,
      assigneeEmail: raw.fields.assignee?.emailAddress ?? null,
      assigneeDisplayName: raw.fields.assignee?.displayName ?? null,
      components: raw.fields.components?.map((c) => c.name) ?? [],
      worklogs,
    });
  }

  return results;
}

/**
 * If the ticket's inline worklogs are complete (total <= maxResults), use them.
 * Otherwise, fetch the full worklog list via the dedicated endpoint.
 */
async function resolveWorklogs(env: Env, ticket: JiraSearchTicket): Promise<JiraWorklog[]> {
  const wl = ticket.fields.worklog;
  if (wl && wl.total <= wl.maxResults) {
    return wl.worklogs.map((w) => mapRawWorklog(w, ticket.key, ticket.fields.summary));
  }
  return fetchAllWorklogsForTicket(env, ticket.key, ticket.fields.summary);
}

// ─── Fetch Worklogs for a Single Ticket ───

async function fetchAllWorklogsForTicket(
  env: Env,
  ticketKey: string,
  ticketSummary: string,
): Promise<JiraWorklog[]> {
  const all: JiraWorklog[] = [];
  let startAt = 0;

  do {
    const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/worklog?startAt=${startAt}&maxResults=1000`;
    const resp = await fetch(url, {
      method: "GET",
      headers: baseHeaders(env),
    });

    if (!resp.ok) {
      console.error(`Worklog fetch failed for ${ticketKey}: ${resp.status}`);
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
    all.push(...weeklyWorklogs.map((w) => mapRawWorklog(w, ticketKey, ticketSummary)));

    if (startAt + data.maxResults >= data.total) break;
    startAt += data.maxResults;
  } while (true);

  return all;
}

function mapRawWorklog(w: JiraRawWorklog, ticketKey: string, ticketSummary: string): JiraWorklog {
  return {
    id: w.id,
    ticketKey,
    ticketSummary,
    authorAccountId: w.author.accountId,
    authorEmail: w.author.emailAddress,
    authorDisplayName: w.author.displayName,
    started: w.started,
    timeSpentSeconds: w.timeSpentSeconds,
  };
}

// ─── Post a Worklog ───

/**
 * Posts a new worklog entry to a Jira ticket.
 * Returns true on success, false on failure.
 */
export async function postWorklog(
  env: Env,
  ticketKey: string,
  dateStr: string,
  timeSpentSeconds: number,
  email: string,
): Promise<boolean> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/worklog`;
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
    console.error(`Post worklog failed for ${ticketKey}: ${resp.status} - ${text}`);
    return false;
  }

  return true;
}

// ─── Fetch Ticket Details (for generic tickets) ───

export async function fetchTicketSummary(env: Env, ticketKey: string): Promise<string> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}?fields=summary`;
  const resp = await fetch(url, {
    method: "GET",
    headers: baseHeaders(env),
  });

  if (!resp.ok) return ticketKey;

  const data = (await resp.json()) as { fields: { summary: string } };
  return data.fields.summary;
}

export async function refreshJiraTicketsCache(env: Env): Promise<void> {
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
  console.log("⏱️ Starting tickets refresh...");
  const issues = await searchAllTickets(env);
  console.log(`Fetched ${issues.length} issues with worklogs`);

  // Cache all tickets in KV for external_select typeahead
  const seenKeys = new Set<string>();
  const cachedTickets: CachedTicket[] = [];

  // Generic tickets first (priority in search results)
  for (const gt of jiraConfig.jira.genericTickets) {
    if (!seenKeys.has(gt.key)) {
      cachedTickets.push({ key: gt.key, summary: gt.summary });
      seenKeys.add(gt.key);
    }
  }

  // All project issues
  for (const issue of issues) {
    if (!seenKeys.has(issue.key)) {
      cachedTickets.push({ key: issue.key, summary: issue.summary });
      seenKeys.add(issue.key);
    }
  }

  await env.CACHE.put(CACHE_KEY_ALL_TICKETS, JSON.stringify(cachedTickets), {
    expirationTtl: TTL_ALL_TICKETS,
  });
  console.log(`Cached ${cachedTickets.length} tickets in KV for typeahead`);
}

// ─── Build accountId → email mapping from search results ───

/**
 * Builds a mapping of Jira accountId to email from the tickets' assignees
 * and worklog authors. Caches in KV for 24 hours.
 * Fresh emails always overwrite cached entries to self-heal stale mappings.
 */
export async function buildAccountIdEmailMap(
  env: Env,
  tickets: JiraTicket[],
): Promise<Map<string, string>> {
  const cached = await env.CACHE.get(CACHE_KEY_ACCOUNT_MAP, "json");
  const map = new Map<string, string>(
    cached ? Object.entries(cached as Record<string, string>) : [],
  );

  let updated = false;

  for (const ticket of tickets) {
    if (ticket.assigneeAccountId && ticket.assigneeEmail) {
      const prev = map.get(ticket.assigneeAccountId);
      if (prev !== ticket.assigneeEmail) {
        map.set(ticket.assigneeAccountId, ticket.assigneeEmail);
        updated = true;
      }
    }
    for (const wl of ticket.worklogs) {
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
