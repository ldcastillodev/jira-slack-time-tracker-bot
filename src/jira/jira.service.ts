import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../context/request-context.service.ts";
import { ConfigService } from "../config/config.service.ts";
import type {
  JiraSearchResponse,
  JiraSearchTicket,
  JiraTicket,
  JiraWorklog,
  JiraRawWorklog,
  JiraWorklogResponse,
  GenericTicket,
  CachedTicket,
} from "../common/types/index.ts";
import {
  CACHE_KEY_ACCOUNT_MAP,
  CACHE_KEY_ALL_TICKETS,
  GENERIC_JIRA_TICKET_FIELDS,
  JIRA_TICKET_FIELDS,
  TTL_ACCOUNT_MAP,
  TTL_ALL_TICKETS,
} from "../common/constants/constants.ts";
import { getWeekBoundaries } from "../common/utils/date.ts";

@Injectable()
export class JiraService {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Helpers ───

  private authHeader(email?: string, token?: string): string {
    const env = this.requestContext.env;
    const userEmail = email ?? env.JIRA_USER_EMAIL;
    const apiToken = token ?? env.JIRA_API_TOKEN;
    return "Basic " + btoa(`${userEmail}:${apiToken}`);
  }

  private baseHeaders(email?: string, token?: string): Record<string, string> {
    return {
      Authorization: this.authHeader(email, token),
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ─── Search tickets with Worklogs ───

  async searchAllTicketsWithWorklogs(): Promise<JiraTicket[]> {
    const env = this.requestContext.env;
    const jiraConfig = this.configService.jiraConfig;
    const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
    const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
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
      const searchHeaders = this.baseHeaders();
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

    const results: JiraTicket[] = [];
    for (const raw of allTickets) {
      const worklogs = await this.resolveWorklogs(raw);
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

  async searchAllTickets(): Promise<GenericTicket[]> {
    const env = this.requestContext.env;
    const jiraConfig = this.configService.jiraConfig;
    const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
    const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
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
      const searchHeaders = this.baseHeaders();
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

    const results: GenericTicket[] = [];
    for (const raw of allTickets) {
      results.push({
        key: raw.key,
        summary: raw.fields.summary,
      });
    }

    return results;
  }

  async searchTicketsForUser(email: string): Promise<JiraTicket[]> {
    const env = this.requestContext.env;
    const jiraConfig = this.configService.jiraConfig;
    const users = this.configService.users;
    const boardList = jiraConfig.jira.boards.map((b) => `"${b}"`).join(", ");
    const componentList = jiraConfig.jira.projectComponents.map((c) => `"${c.name}"`).join(", ");
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
      const searchHeaders = this.baseHeaders(email, users[email]);
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

    const results: JiraTicket[] = [];
    for (const raw of allTickets) {
      const worklogs = await this.resolveWorklogs(raw);
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

  private async resolveWorklogs(ticket: JiraSearchTicket): Promise<JiraWorklog[]> {
    const wl = ticket.fields.worklog;
    if (wl && wl.total <= wl.maxResults) {
      return wl.worklogs.map((w) => this.mapRawWorklog(w, ticket.key, ticket.fields.summary));
    }
    return this.fetchAllWorklogsForTicket(ticket.key, ticket.fields.summary);
  }

  // ─── Fetch Worklogs for a Single Ticket ───

  private async fetchAllWorklogsForTicket(
    ticketKey: string,
    ticketSummary: string,
  ): Promise<JiraWorklog[]> {
    const env = this.requestContext.env;
    const all: JiraWorklog[] = [];
    let startAt = 0;

    do {
      const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/worklog?startAt=${startAt}&maxResults=1000`;
      const resp = await fetch(url, {
        method: "GET",
        headers: this.baseHeaders(),
      });

      if (!resp.ok) {
        console.error(`Worklog fetch failed for ${ticketKey}: ${resp.status}`);
        break;
      }

      const data = (await resp.json()) as JiraWorklogResponse;
      const { monday, friday: weekFriday } = getWeekBoundaries(new Date());
      const weeklyWorklogs = data.worklogs.filter((w) => {
        return w.started.substring(0, 10) >= monday && w.started.substring(0, 10) <= weekFriday;
      });

      all.push(...weeklyWorklogs.map((w) => this.mapRawWorklog(w, ticketKey, ticketSummary)));

      if (startAt + data.maxResults >= data.total) break;
      startAt += data.maxResults;
    } while (true);

    return all;
  }

  private mapRawWorklog(w: JiraRawWorklog, ticketKey: string, ticketSummary: string): JiraWorklog {
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

  async postWorklog(
    ticketKey: string,
    dateStr: string,
    timeSpentSeconds: number,
    email: string,
  ): Promise<boolean> {
    const env = this.requestContext.env;
    const users = this.configService.users;
    const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}/worklog`;
    const body = {
      started: `${dateStr}T12:00:00.000+0000`,
      timeSpentSeconds,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: this.baseHeaders(email, users[email]),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Post worklog failed for ${ticketKey}: ${resp.status} - ${text}`);
      return false;
    }

    return true;
  }

  // ─── Fetch Ticket Details ───

  async fetchTicketSummary(ticketKey: string): Promise<string> {
    const env = this.requestContext.env;
    const url = `${env.JIRA_BASE_URL}/rest/api/3/issue/${ticketKey}?fields=summary`;
    const resp = await fetch(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });

    if (!resp.ok) return ticketKey;

    const data = (await resp.json()) as { fields: { summary: string } };
    return data.fields.summary;
  }

  async refreshJiraTicketsCache(): Promise<void> {
    const env = this.requestContext.env;
    const jiraConfig = this.configService.jiraConfig;
    console.log("⏱️ Starting tickets refresh...");
    const issues = await this.searchAllTickets();
    console.log(`Fetched ${issues.length} issues with worklogs`);

    const seenKeys = new Set<string>();
    const cachedTickets: CachedTicket[] = [];

    for (const gt of jiraConfig.jira.genericTickets) {
      if (!seenKeys.has(gt.key)) {
        cachedTickets.push({ key: gt.key, summary: gt.summary });
        seenKeys.add(gt.key);
      }
    }

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

  // ─── Build accountId → email mapping ───

  async buildAccountIdEmailMap(tickets: JiraTicket[]): Promise<Map<string, string>> {
    const env = this.requestContext.env;
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
}
