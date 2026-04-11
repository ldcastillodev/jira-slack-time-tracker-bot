import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleScheduled } from "../../src/handlers/cron.ts";
import { createMockEnv, mockJsonResponse } from "../setup.ts";
import type { Env } from "../../src/types/index.ts";

describe("handleScheduled (cron handler)", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips execution when current ET hour does not match cronHourET", async () => {
    env = createMockEnv();

    // Mock getCurrentHourET to return a non-matching hour
    const dateModule = await import("../../src/utils/date.ts");
    vi.spyOn(dateModule, "getCurrentHourET").mockReturnValue(10); // not 16

    await handleScheduled(env);

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

    const dateModule = await import("../../src/utils/date.ts");
    vi.spyOn(dateModule, "getCurrentHourET").mockReturnValue(16);
    vi.spyOn(dateModule, "getTodayET").mockReturnValue("2026-04-08");
    vi.spyOn(dateModule, "isFriday").mockReturnValue(false);
    vi.spyOn(dateModule, "getWeekBoundaries").mockReturnValue({
      monday: "2026-04-06",
      friday: "2026-04-10",
    });

    // Mock Jira search (returns empty tickets)
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ tickets: [] }));

    // Mock Slack lookupByEmail for user1 → returns user ID
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U111" } }));

    // Mock Slack postMessage for user1
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    // Mock Slack lookupByEmail for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U222" } }));

    // Mock Slack postMessage for user2
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    await handleScheduled(env);

    // Should have called Jira search + Slack lookups + messages
    expect(fetchSpy).toHaveBeenCalled();

    // Verify tickets were cached in KV
    expect(mockKV.put).toHaveBeenCalledWith(
      "all_tickets",
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );

    vi.restoreAllMocks();
  });
});
