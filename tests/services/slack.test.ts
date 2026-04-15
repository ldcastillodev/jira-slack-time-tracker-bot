import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackService } from "../../src/slack/slack.service.ts";
import { RequestContextService } from "../../src/context/request-context.service.ts";
import { runInContext } from "../../src/context/async-local-storage.ts";
import { createMockEnv, mockJsonResponse } from "../setup.ts";
import type { Env, SlackBlock } from "../../src/common/types/index.ts";

describe("slack service", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let slackService: SlackService;

  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  // Shims: preserve old call signatures, delegate to class methods via ALS
  const lookupUserByEmail = (e: Env, email: string) =>
    runInContext(e, mockCtx, () => slackService.lookupUserByEmail(email));
  const resolveEmailFromSlackId = (e: Env, slackUserId: string, emails: string[]) =>
    runInContext(e, mockCtx, () => slackService.resolveEmailFromSlackId(slackUserId, emails));
  const sendDirectMessage = (e: Env, slackUserId: string, blocks: SlackBlock[], text: string) =>
    runInContext(e, mockCtx, () => slackService.sendDirectMessage(slackUserId, blocks, text));
  const updateMessageViaResponseUrl = (
    url: string,
    blocks: SlackBlock[],
    text: string,
    replace: boolean,
  ) => slackService.updateMessageViaResponseUrl(url, blocks, text, replace);

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rcs = new RequestContextService();
    slackService = new SlackService(rcs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("lookupUserByEmail", () => {
    it("returns cached user ID from KV", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue("U12345"),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      const result = await lookupUserByEmail(env, "user1@example.com");
      expect(result).toBe("U12345");
      expect(fetchSpy).not.toHaveBeenCalled(); // should not call Slack API
    });

    it("calls Slack API on cache miss and caches the result", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U99999" } }));

      const result = await lookupUserByEmail(env, "user1@example.com");

      expect(result).toBe("U99999");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain("users.lookupByEmail");
      expect(url).toContain("user1%40example.com");
      expect((options.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer xoxb-test-token",
      );

      // Verify KV cache was updated
      expect(mockKV.put).toHaveBeenCalledWith(
        "slack_user:user1@example.com",
        "U99999",
        expect.objectContaining({ expirationTtl: expect.any(Number) }),
      );
    });

    it("returns null when Slack API returns error", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: false, error: "users_not_found" }));

      const result = await lookupUserByEmail(env, "unknown@example.com");
      expect(result).toBeNull();
    });

    it("returns null when Slack API HTTP error", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const result = await lookupUserByEmail(env, "user1@example.com");
      expect(result).toBeNull();
    });
  });

  describe("resolveEmailFromSlackId", () => {
    it("returns the cached email without calling Slack API", async () => {
      const mockKV = {
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === "slack_user:user2@example.com") {
            return "U12345";
          }

          return null;
        }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      const result = await resolveEmailFromSlackId(env, "U12345", [
        "user1@example.com",
        "user2@example.com",
      ]);

      expect(result).toBe("user2@example.com");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("falls back to Slack lookup when KV misses", async () => {
      const mockKV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

      fetchSpy
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U11111" } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, user: { id: "U12345" } }));

      const result = await resolveEmailFromSlackId(env, "U12345", [
        "user1@example.com",
        "user2@example.com",
      ]);

      expect(result).toBe("user2@example.com");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(mockKV.put).toHaveBeenCalledTimes(2);
    });
  });

  describe("sendDirectMessage", () => {
    beforeEach(() => {
      env = createMockEnv();
    });

    it("sends message and returns true on success", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      const blocks = [{ type: "section", text: { type: "mrkdwn" as const, text: "Hello" } }];
      const result = await sendDirectMessage(env, "U12345", blocks, "Hello");

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.channel).toBe("U12345");
      expect(body.text).toBe("Hello");
      expect(body.blocks).toEqual(blocks);
    });

    it("returns false when Slack API returns ok: false", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: false, error: "channel_not_found" }));

      const result = await sendDirectMessage(env, "U12345", [], "test");
      expect(result).toBe(false);
    });

    it("returns false on HTTP error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const result = await sendDirectMessage(env, "U12345", [], "test");
      expect(result).toBe(false);
    });
  });

  describe("updateMessageViaResponseUrl", () => {
    it("sends POST to response_url with correct payload", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const blocks = [{ type: "section", text: { type: "mrkdwn" as const, text: "Updated" } }];
      await updateMessageViaResponseUrl(
        "https://hooks.slack.com/test",
        blocks,
        "Updated text",
        true,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://hooks.slack.com/test");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.replace_original).toBe(true);
      expect(body.response_type).toBe("ephemeral");
      expect(body.text).toBe("Updated text");
      expect(body.blocks).toEqual(blocks);
    });

    it("sends replace_original: false when specified", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await updateMessageViaResponseUrl("https://hooks.slack.com/test", [], "text", false);

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.replace_original).toBe(false);
    });
  });
});
