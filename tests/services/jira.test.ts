import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchIssuesWithWorklogs,
  buildAccountIdEmailMap,
  postWorklog,
  fetchIssueSummary,
} from "../../src/services/jira.ts";
import { createMockEnv, createMockJiraIssue, mockJsonResponse } from "../setup.ts";
import type { Env, JiraSearchResponse } from "../../src/types/index.ts";

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

  describe("searchIssuesWithWorklogs", () => {
    it("fetches issues and normalizes them", async () => {
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

      const issues = await searchIssuesWithWorklogs(env);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe("TEST-100");
      expect(issues[0].summary).toBe("Test Issue");
      expect(issues[0].assigneeAccountId).toBe("acc-123");
      expect(issues[0].worklogs).toHaveLength(1);
      expect(issues[0].worklogs[0].timeSpentSeconds).toBe(3600);
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

      const issues = await searchIssuesWithWorklogs(env);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(issues).toHaveLength(2);
      expect(issues[0].key).toBe("TEST-1");
      expect(issues[1].key).toBe("TEST-2");
    });

    it("handles API errors gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      const issues = await searchIssuesWithWorklogs(env);
      expect(issues).toHaveLength(0);
    });

    it("sends correct Basic auth header", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [] } as JiraSearchResponse));

      await searchIssuesWithWorklogs(env);

      const callArgs = fetchSpy.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      const expectedAuth = "Basic " + btoa(`${env.JIRA_USER_EMAIL}:${env.JIRA_API_TOKEN}`);
      expect(headers["Authorization"]).toBe(expectedAuth);
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

  describe("fetchIssueSummary", () => {
    it("returns the issue summary on success", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ fields: { summary: "My Issue" } }));

      const summary = await fetchIssueSummary(env, "TEST-100");
      expect(summary).toBe("My Issue");
    });

    it("returns the issue key as fallback on error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

      const summary = await fetchIssueSummary(env, "TEST-999");
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
        createMockJiraIssue({
          assigneeAccountId: "acc-123",
          assigneeEmail: "user1@example.com",
          worklogs: [
            {
              id: "wl-1",
              issueKey: "TEST-100",
              issueSummary: "Test",
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
        createMockJiraIssue({
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
});
