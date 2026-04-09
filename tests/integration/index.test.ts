import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index.ts";
import { createMockEnv, createSignedSlackRequest, createMockSlackPayload } from "../setup.ts";
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
      // Stub fetch to prevent real API calls from cron handler
      const { vi } = await import("vitest");
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ issues: [] }), { status: 200 }));
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
});
