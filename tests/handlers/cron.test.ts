import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronHandler } from "../../src/cron/cron.handler.ts";
import { RequestContextService } from "../../src/context/request-context.service.ts";
import { ConfigService } from "../../src/config/config.service.ts";
import { JiraService } from "../../src/jira/jira.service.ts";
import { SlackService } from "../../src/slack/slack.service.ts";
import { AggregatorService } from "../../src/aggregator/aggregator.service.ts";
import { MessageBuilderService } from "../../src/builders/message-builder.service.ts";
import { runInContext } from "../../src/context/async-local-storage.ts";
import { createMockEnv, mockJsonResponse } from "../setup.ts";
import type { Env } from "../../src/common/types/index.ts";
import { CACHE_KEY_ALL_TICKETS } from "../../src/common/constants/constants.ts";

let cronHandler: CronHandler;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function setupCronHandler() {
  const rcs = new RequestContextService();
  const cs = new ConfigService(rcs);
  const js = new JiraService(rcs, cs);
  const ss = new SlackService(rcs);
  const as = new AggregatorService();
  const mbs = new MessageBuilderService();
  cronHandler = new CronHandler(cs, js, ss, as, mbs);
}

// Shims: preserve old call signatures
const handleScheduledSummary = (e: Env) =>
  runInContext(e, mockCtx, () => cronHandler.handleScheduledSummary());
const handleScheduledTicketsRefresh = (e: Env) =>
  runInContext(e, mockCtx, () => cronHandler.handleScheduledTicketsRefresh());

describe("handleScheduledSummary (cron handler)", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    setupCronHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips execution when current ET hour does not match cronHourET", async () => {
    env = createMockEnv();

    // Mock getCurrentHourET to return a non-matching hour
    const dateModule = await import("../../src/common/utils/date.ts");
    vi.spyOn(dateModule, "getCurrentHourET").mockReturnValue(10); // not 16

    await handleScheduledSummary(env);

    // Should not have made any fetch calls (no Jira/Slack API calls)
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("executes the full flow when ET hour matches", async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const dateModule = await import("../../src/common/utils/date.ts");
    vi.spyOn(dateModule, "getCurrentHourET").mockReturnValue(16);
    vi.spyOn(dateModule, "getTodayET").mockReturnValue("2026-04-08");
    vi.spyOn(dateModule, "isFriday").mockReturnValue(false);
    vi.spyOn(dateModule, "getWeekBoundaries").mockReturnValue({
      monday: "2026-04-06",
      friday: "2026-04-10",
    });

    // Mock Jira search (returns empty tickets)
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [], nextPageToken: undefined }));

    // Mock Slack lookupByEmail for user1 → returns user ID
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U111" } }));

    // Mock Slack postMessage for user1
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    // Mock Slack lookupByEmail for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U222" } }));

    // Mock Slack postMessage for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    await handleScheduledSummary(env);

    // Should have called Jira search + Slack lookups + messages
    expect(fetchSpy).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("passes the formatted dateLabel to buildDailyMessage", async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const dateModule = await import("../../src/common/utils/date.ts");
    vi.spyOn(dateModule, "getCurrentHourET").mockReturnValue(16);
    vi.spyOn(dateModule, "getTodayET").mockReturnValue("2026-04-08");
    vi.spyOn(dateModule, "isFriday").mockReturnValue(false);
    vi.spyOn(dateModule, "getWeekBoundaries").mockReturnValue({
      monday: "2026-04-06",
      friday: "2026-04-10",
    });

    const buildDailyMsgSpy = vi.spyOn(MessageBuilderService.prototype, "buildDailyMessage");

    // Mock Jira search (returns empty tickets)
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [], nextPageToken: undefined }));

    // Mock Slack lookupByEmail for user1
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U111" } }));
    // Mock Slack postMessage for user1
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    // Mock Slack lookupByEmail for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U222" } }));
    // Mock Slack postMessage for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    await handleScheduledSummary(env);

    // buildDailyMessage should have been called with dateLabel (7th argument)
    expect(buildDailyMsgSpy).toHaveBeenCalled();
    for (const call of buildDailyMsgSpy.mock.calls) {
      const dateLabel = call[6]; // 7th argument (0-indexed: 6)
      expect(dateLabel).toBeDefined();
      expect(typeof dateLabel).toBe("string");
      // Should be the Spanish long format for 2026-04-08 (miércoles 8 de abril de 2026)
      expect(dateLabel).toContain("abril");
      expect(dateLabel).toContain("2026");
    }

    vi.restoreAllMocks();
  });
});

describe("handleScheduledTicketsRefresh (cron handler)", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    setupCronHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches all Jira tickets and caches them in KV", async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({
        issues: [
          {
            key: "TEST-200",
            fields: {
              summary: "Refresh Issue",
              status: { name: "In Progress" },
              assignee: null,
              worklog: { total: 0, maxResults: 20, worklogs: [] },
            },
          },
        ],
      }),
    );

    await handleScheduledTicketsRefresh(env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockKV.put).toHaveBeenCalledWith(
      CACHE_KEY_ALL_TICKETS,
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );

    const cachedPayload = JSON.parse(mockKV.put.mock.calls[0][1] as string) as Array<{
      key: string;
    }>;
    const keys = cachedPayload.map((t) => t.key);
    expect(keys).toContain("TEST-200");
  });

  it("does not throw when Jira API returns an error", async () => {
    env = createMockEnv();
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    await expect(handleScheduledTicketsRefresh(env)).resolves.toBeUndefined();
  });
});
