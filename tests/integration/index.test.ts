import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index.ts";
import {
  createMockEnv,
  createSignedSlackRequest,
  createMockSlackPayload,
  createSignedSlackCommandRequest,
} from "../setup.ts";
import type { Env } from "../../src/types/index.ts";

describe("Worker router (index.ts)", () => {
  let env: Env;
  const signingSecret = "test-signing-secret";

  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  beforeEach(() => {
    const mockKV = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });
  });

  describe("GET /health", () => {
    it("returns 200 OK", async () => {
      const request = new Request("http://localhost/health", { method: "GET" });
      const response = await worker.fetch(request, env, mockCtx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
    });
  });

  describe("POST /slack/interactions", () => {
    it("delegates to interaction handler", async () => {
      const payload = createMockSlackPayload({ actions: [] });
      const request = await createSignedSlackRequest(signingSecret, payload);
      const response = await worker.fetch(request, env, mockCtx);
      // Should return 200 (even for empty actions, handler returns OK)
      expect(response.status).toBe(200);
    });
  });

  describe("POST /slack/options", () => {
    it("delegates to options handler", async () => {
      const payload = {
        type: "block_suggestion",
        value: "",
        action_id: "select_ticket_0",
      };
      const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");
      const response = await worker.fetch(request, env, mockCtx);
      expect(response.status).toBe(200);
    });
  });

  describe("POST /trigger", () => {
    it("returns 200 Triggered", async () => {
      // Stub fetch to prevent real API calls from cron handler.
      // Use mockImplementation (not mockResolvedValue) so a fresh Response is
      // returned on every call — Response bodies can only be read once.
      const { vi } = await import("vitest");
      const fetchSpy = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ issues: [], nextPageToken: undefined }), { status: 200 }),
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      const request = new Request("http://localhost/trigger", { method: "POST" });
      const response = await worker.fetch(request, env, mockCtx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Triggered");

      vi.restoreAllMocks();
    });
  });

  describe("Unknown routes", () => {
    it("returns 404 for GET /unknown", async () => {
      const request = new Request("http://localhost/unknown", { method: "GET" });
      const response = await worker.fetch(request, env, mockCtx);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    });

    it("returns 404 for wrong method on known route", async () => {
      const request = new Request("http://localhost/health", { method: "POST" });
      const response = await worker.fetch(request, env, mockCtx);
      expect(response.status).toBe(404);
    });
  });

  describe("POST /slack/commands — /help command", () => {
    it("routes /help and returns ephemeral blocks", async () => {
      const request = await createSignedSlackCommandRequest(signingSecret, {
        command: "/help",
        response_url: "https://hooks.slack.com/commands/test/response",
      });

      const response = await worker.fetch(request, env, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = (await response.json()) as {
        response_type: string;
        blocks: Array<{ type: string }>;
        text: string;
      };
      expect(body.response_type).toBe("ephemeral");
      expect(Array.isArray(body.blocks)).toBe(true);
      expect(body.blocks.length).toBeGreaterThan(0);
      expect(body.blocks.some((b) => b.type === "header")).toBe(true);
    });

    it("returns 401 for an invalid Slack signature on /slack/commands", async () => {
      const request = new Request("http://localhost/slack/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=invalidsignature",
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: "command=%2Fhelp&user_id=U12345&response_url=https%3A%2F%2Fhooks.slack.com%2F",
      });

      const response = await worker.fetch(request, env, mockCtx);
      expect(response.status).toBe(401);
    });
  });
});
