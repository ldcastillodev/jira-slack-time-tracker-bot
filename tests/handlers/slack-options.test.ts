import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackOptionsHandler } from "../../src/slack/handlers/slack-options.handler.ts";
import { RequestContextService } from "../../src/context/request-context.service.ts";
import { ConfigService } from "../../src/config/config.service.ts";
import { runInContext } from "../../src/context/async-local-storage.ts";
import { createMockEnv, createSignedSlackRequest } from "../setup.ts";
import type { Env, CachedTicket } from "../../src/common/types/index.ts";

let optionsHandler: SlackOptionsHandler;

const dummyCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function setupHandler() {
  const rcs = new RequestContextService();
  const cs = new ConfigService(rcs);
  optionsHandler = new SlackOptionsHandler(rcs, cs);
}

// Shim: preserve old call signature (request, env)
const handleSlackOptions = (request: Request, e: Env) =>
  runInContext(e, dummyCtx, () => optionsHandler.handleSlackOptions(request));

describe("handleSlackOptions", () => {
  let env: Env;
  const signingSecret = "test-signing-secret";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setupHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 for invalid Slack signature", async () => {
    env = createMockEnv();

    const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_suggestion", value: "", action_id: "select_ticket_0" }))}`;
    const request = new Request("http://localhost/slack/options", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    const response = await handleSlackOptions(request, env);
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing payload", async () => {
    env = createMockEnv();

    const body = "no_payload=true";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { generateSlackSignature } = await import("../setup.ts");
    const signature = await generateSlackSignature(signingSecret, timestamp, body);

    const request = new Request("http://localhost/slack/options", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    const response = await handleSlackOptions(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 200 for non-block_suggestion type", async () => {
    env = createMockEnv();
    const payload = { type: "not_block_suggestion", value: "", action_id: "test" };
    const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");

    const response = await handleSlackOptions(request, env);
    expect(response.status).toBe(200);
  });

  it("returns filtered options from KV cache", async () => {
    const cachedTickets: CachedTicket[] = [
      { key: "TEST-1", summary: "Generic Ticket 1" },
      { key: "TEST-100", summary: "Feature Work" },
      { key: "TEST-200", summary: "Bug Fix" },
    ];

    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedTickets)),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const payload = {
      type: "block_suggestion",
      value: "Feature",
      action_id: "select_ticket_0",
    };
    const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");

    const response = await handleSlackOptions(request, env);
    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      option_groups: Array<{ label: { text: string }; options: Array<{ value: string }> }>;
    };
    expect(data.option_groups).toBeDefined();

    // Should only return tickets matching "Feature"
    const allOptions = data.option_groups.flatMap(
      (g: { options: Array<{ value: string }> }) => g.options,
    );
    expect(allOptions.length).toBe(1);
    expect(allOptions[0].value).toBe("TEST-100");
  });

  it("returns empty option_groups when no tickets match", async () => {
    const cachedTickets: CachedTicket[] = [{ key: "TEST-1", summary: "Generic Ticket 1" }];

    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedTickets)),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const payload = {
      type: "block_suggestion",
      value: "nonexistent",
      action_id: "select_ticket_0",
    };
    const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");

    const response = await handleSlackOptions(request, env);
    const data = (await response.json()) as { option_groups: unknown[] };
    expect(data.option_groups).toHaveLength(0);
  });

  it("falls back to generic tickets when KV cache is empty", async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const payload = {
      type: "block_suggestion",
      value: "",
      action_id: "select_ticket_0",
    };
    const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");

    const response = await handleSlackOptions(request, env);
    const data = (await response.json()) as { option_groups: Array<{ options: unknown[] }> };

    expect(data.option_groups.length).toBeGreaterThan(0);
    // Should contain at least the generic ticket from config
    const allOptions = data.option_groups.flatMap((g: { options: unknown[] }) => g.options);
    expect(allOptions.length).toBeGreaterThanOrEqual(1);
  });

  it("separates generic and project tickets into groups", async () => {
    const cachedTickets: CachedTicket[] = [
      { key: "TEST-1", summary: "Generic Ticket 1" }, // generic (matches config)
      { key: "TEST-100", summary: "Project Feature" }, // project
    ];

    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedTickets)),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    const payload = {
      type: "block_suggestion",
      value: "",
      action_id: "select_ticket_0",
    };
    const request = await createSignedSlackRequest(signingSecret, payload, "/slack/options");

    const response = await handleSlackOptions(request, env);
    const data = (await response.json()) as {
      option_groups: Array<{ label: { text: string }; options: unknown[] }>;
    };

    expect(data.option_groups).toHaveLength(2);
    expect(data.option_groups[0].label.text).toContain("Genéricos");
    expect(data.option_groups[1].label.text).toContain("Proyecto");
  });
});
