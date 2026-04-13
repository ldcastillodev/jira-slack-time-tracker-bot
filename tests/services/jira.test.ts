import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchAllTicketsWithWorklogs,
  searchAllTickets,
  refreshJiraTicketsCache,
  searchTicketsForUser,
  buildAccountIdEmailMap,
  postWorklog,
  fetchTicketSummary,
} from "../../src/services/jira.ts";
import { createMockEnv, createMockJiraTicket, mockJsonResponse } from "../setup.ts";
import type { Env, JiraSearchResponse } from "../../src/types/index.ts";
import { CACHE_KEY_ALL_TICKETS } from "../../src/constants/constants.ts";

describe("jira service", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = createMockEnv();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("searchAllTicketsWithWorklogs", () => {
    it("fetches tickets and normalizes them", async () => {
      const mockResponse: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-100",
            fields: {
              summary: "Test Issue",
              status: { name: "In Progress" },
              assignee: {
                accountId: "acc-123",
                emailAddress: "user1@example.com",
                displayName: "User One",
              },
              worklog: {
                total: 1,
                maxResults: 20,
                worklogs: [
                  {
                    id: "wl-1",
                    author: {
                      accountId: "acc-123",
                      emailAddress: "user1@example.com",
                      displayName: "User One",
                    },
                    started: "2026-04-08T12:00:00.000+0000",
                    timeSpentSeconds: 3600,
                  },
                ],
              },
            },
          },
        ],
      };

      fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockResponse));

      const tickets = await searchAllTicketsWithWorklogs(env);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].key).toBe("TEST-100");
      expect(tickets[0].summary).toBe("Test Issue");
      expect(tickets[0].assigneeAccountId).toBe("acc-123");
      expect(tickets[0].worklogs).toHaveLength(1);
      expect(tickets[0].worklogs[0].timeSpentSeconds).toBe(3600);
    });

    it("handles paginated results", async () => {
      const page1: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-1",
            fields: {
              summary: "Issue 1",
              status: { name: "Done" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
        nextPageToken: "page2",
      };

      const page2: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-2",
            fields: {
              summary: "Issue 2",
              status: { name: "To Do" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };

      fetchSpy
        .mockResolvedValueOnce(mockJsonResponse(page1))
        .mockResolvedValueOnce(mockJsonResponse(page2));

      const tickets = await searchAllTicketsWithWorklogs(env);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(tickets).toHaveLength(2);
      expect(tickets[0].key).toBe("TEST-1");
      expect(tickets[1].key).toBe("TEST-2");
    });

    it("handles API errors gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      const tickets = await searchAllTicketsWithWorklogs(env);
      expect(tickets).toHaveLength(0);
    });

    it("sends correct Basic auth header", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [] } as JiraSearchResponse));

      await searchAllTicketsWithWorklogs(env);

      const callArgs = fetchSpy.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      const expectedAuth = "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
      expect(headers["Authorization"]).toBe(expectedAuth);
    });
  });

  describe("searchTicketsForUser", () => {
    it("fetches tickets and normalizes them for a specific user", async () => {
      const mockResponse: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-200",
            fields: {
              summary: "User Ticket",
              status: { name: "In Progress" },
              assignee: {
                accountId: "acc-123",
                emailAddress: "user1@example.com",
                displayName: "User One",
              },
              worklog: {
                total: 1,
                maxResults: 20,
                worklogs: [
                  {
                    id: "wl-2",
                    author: {
                      accountId: "acc-123",
                      emailAddress: "user1@example.com",
                      displayName: "User One",
                    },
                    started: "2026-04-08T12:00:00.000+0000",
                    timeSpentSeconds: 7200,
                  },
                ],
              },
            },
          },
        ],
      };

      fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockResponse));

      const tickets = await searchTicketsForUser(env, "user1@example.com");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].key).toBe("TEST-200");
      expect(tickets[0].summary).toBe("User Ticket");
      expect(tickets[0].worklogs).toHaveLength(1);
      expect(tickets[0].worklogs[0].timeSpentSeconds).toBe(7200);
    });

    it("sends user-specific Basic auth header", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [] } as JiraSearchResponse));

      await searchTicketsForUser(env, "user1@example.com");

      const callArgs = fetchSpy.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      // Should use user1's credentials (from USERS env), not the service account
      const expectedAuth = "Basic " + btoa("user1@example.com:token1");
      expect(headers["Authorization"]).toBe(expectedAuth);
    });

    it("handles paginated results", async () => {
      const page1: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-3",
            fields: {
              summary: "Page 1 Ticket",
              status: { name: "Done" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
        nextPageToken: "page2",
      };

      const page2: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-4",
            fields: {
              summary: "Page 2 Ticket",
              status: { name: "To Do" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };

      fetchSpy
        .mockResolvedValueOnce(mockJsonResponse(page1))
        .mockResolvedValueOnce(mockJsonResponse(page2));

      const tickets = await searchTicketsForUser(env, "user1@example.com");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(tickets).toHaveLength(2);
      expect(tickets[0].key).toBe("TEST-3");
      expect(tickets[1].key).toBe("TEST-4");
    });

    it("handles API errors gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

      const tickets = await searchTicketsForUser(env, "user1@example.com");
      expect(tickets).toHaveLength(0);
    });
  });

  describe("postWorklog", () => {
    it("returns true on success", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ id: "wl-new" }, 201));

      const result = await postWorklog(env, "TEST-100", "2026-04-08", 3600, "user1@example.com");

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/issue/TEST-100/worklog");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.timeSpentSeconds).toBe(3600);
      expect(body.started).toBe("2026-04-08T12:00:00.000+0000");
    });

    it("returns false on API error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));

      const result = await postWorklog(env, "TEST-100", "2026-04-08", 3600, "user1@example.com");
      expect(result).toBe(false);
    });

    it("uses user-specific credentials", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ id: "wl-new" }, 201));

      await postWorklog(env, "TEST-100", "2026-04-08", 3600, "user1@example.com");

      const [, options] = fetchSpy.mock.calls[0];
      const headers = options.headers as Record<string, string>;
      const expectedAuth = "Basic " + btoa("user1@example.com:token1");
      expect(headers["Authorization"]).toBe(expectedAuth);
    });
  });

  describe("fetchTicketSummary", () => {
    it("returns the ticket summary on success", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ fields: { summary: "My Issue" } }));

      const summary = await fetchTicketSummary(env, "TEST-100");
      expect(summary).toBe("My Issue");
    });

    it("returns the ticket key as fallback on error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

      const summary = await fetchTicketSummary(env, "TEST-999");
      expect(summary).toBe("TEST-999");
    });
  });

  describe("buildAccountIdEmailMap", () => {
    it("builds map from issue assignees and worklog authors", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };

      const envWithKV = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      const issues = [
        createMockJiraTicket({
          assigneeAccountId: "acc-123",
          assigneeEmail: "user1@example.com",
          worklogs: [
            {
              id: "wl-1",
              ticketKey: "TEST-100",
              ticketSummary: "Test",
              authorAccountId: "acc-456",
              authorEmail: "user2@example.com",
              authorDisplayName: "User Two",
              started: "2026-04-08T10:00:00.000+0000",
              timeSpentSeconds: 3600,
            },
          ],
        }),
      ];

      const map = await buildAccountIdEmailMap(envWithKV, issues);

      expect(map.get("acc-123")).toBe("user1@example.com");
      expect(map.get("acc-456")).toBe("user2@example.com");
      expect(mockKV.put).toHaveBeenCalled();
    });

    it("merges with cached data from KV", async () => {
      const cachedData = { "acc-old": "old@example.com" };
      const mockKV = {
        get: vi.fn().mockResolvedValue(cachedData),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };

      const envWithKV = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      const issues = [
        createMockJiraTicket({
          assigneeAccountId: "acc-123",
          assigneeEmail: "user1@example.com",
          worklogs: [],
        }),
      ];

      const map = await buildAccountIdEmailMap(envWithKV, issues);

      expect(map.get("acc-old")).toBe("old@example.com");
      expect(map.get("acc-123")).toBe("user1@example.com");
    });
  });

  describe("searchAllTickets", () => {
    it("fetches all tickets and returns only key + summary", async () => {
      const mockResponse: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-50",
            fields: {
              summary: "All Tickets Issue",
              status: { name: "In Progress" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };

      fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockResponse));

      const tickets = await searchAllTickets(env);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].key).toBe("TEST-50");
      expect(tickets[0].summary).toBe("All Tickets Issue");
      // GenericTicket should only have key and summary
      expect(Object.keys(tickets[0])).toEqual(["key", "summary"]);
    });

    it("handles paginated results", async () => {
      const page1: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-10",
            fields: {
              summary: "Page 1",
              status: { name: "Done" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
        nextPageToken: "page2",
      };

      const page2: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-11",
            fields: {
              summary: "Page 2",
              status: { name: "To Do" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };

      fetchSpy
        .mockResolvedValueOnce(mockJsonResponse(page1))
        .mockResolvedValueOnce(mockJsonResponse(page2));

      const tickets = await searchAllTickets(env);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(tickets).toHaveLength(2);
      expect(tickets[0].key).toBe("TEST-10");
      expect(tickets[1].key).toBe("TEST-11");
    });

    it("handles API errors gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      const tickets = await searchAllTickets(env);
      expect(tickets).toHaveLength(0);
    });

    it("uses service account auth (no worklog filter in JQL)", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [] } as JiraSearchResponse));

      await searchAllTickets(env);

      const callArgs = fetchSpy.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      const expectedAuth = "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
      expect(headers["Authorization"]).toBe(expectedAuth);

      // JQL should NOT include worklogDate filter
      const body = JSON.parse(options.body as string) as { jql: string; fields: string[] };
      expect(body.jql).not.toContain("worklogDate");
    });

    it("requests only key and summary fields", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [] } as JiraSearchResponse));

      await searchAllTickets(env);

      const callArgs = fetchSpy.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const body = JSON.parse(options.body as string) as { jql: string; fields: string[] };
      expect(body.fields).toContain("key");
      expect(body.fields).toContain("summary");
    });
  });

  describe("refreshJiraTicketsCache", () => {
    it("fetches all tickets, merges with genericTickets, and caches in KV", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      const envWithKV = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      const mockResponse: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-99",
            fields: {
              summary: "Project Issue",
              status: { name: "In Progress" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockResponse));

      await refreshJiraTicketsCache(envWithKV);

      expect(mockKV.put).toHaveBeenCalledWith(
        CACHE_KEY_ALL_TICKETS,
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) }),
      );

      // Verify the cached payload contains both generic and project tickets
      const putCall = mockKV.put.mock.calls[0];
      const cachedTickets = JSON.parse(putCall[1] as string) as Array<{
        key: string;
        summary: string;
      }>;
      const keys = cachedTickets.map((t) => t.key);
      // Generic ticket from config (TEST-1) should come first
      expect(keys).toContain("TEST-1");
      expect(keys).toContain("TEST-99");
      expect(keys.indexOf("TEST-1")).toBeLessThan(keys.indexOf("TEST-99"));
    });

    it("deduplicates tickets (generic ticket key that also appears in project issues)", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      const envWithKV = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      // The env has genericTickets: [{ key: "TEST-1", summary: "Generic Ticket 1" }]
      // Return TEST-1 also as a project issue — it should only appear once in cache
      const mockResponse: JiraSearchResponse = {
        issues: [
          {
            key: "TEST-1",
            fields: {
              summary: "Generic Ticket 1",
              status: { name: "In Progress" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockResponse));

      await refreshJiraTicketsCache(envWithKV);

      const putCall = mockKV.put.mock.calls[0];
      const cachedTickets = JSON.parse(putCall[1] as string) as Array<{ key: string }>;
      const keys = cachedTickets.map((t) => t.key);
      // TEST-1 should appear exactly once
      expect(keys.filter((k) => k === "TEST-1")).toHaveLength(1);
    });

    it("handles fetch errors without throwing", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      const envWithKV = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      // Should still cache (with only generic tickets)
      await expect(refreshJiraTicketsCache(envWithKV)).resolves.toBeUndefined();
      expect(mockKV.put).toHaveBeenCalled();
    });
  });
});
