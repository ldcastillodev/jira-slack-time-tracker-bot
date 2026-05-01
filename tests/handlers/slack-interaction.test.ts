import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSlackInteraction } from "../../src/handlers/slack-interaction.ts";
import { createMockEnv, createMockSlackPayload, createSignedSlackRequest } from "../setup.ts";
import type { Env } from "../../src/types/index.ts";

describe("handleSlackInteraction", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const signingSecret = "test-signing-secret";

  const mockCtx = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      // Execute the promise to ensure it runs in tests
      p.catch(() => {});
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    env = createMockEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 for invalid Slack signature", async () => {
    const payload = createMockSlackPayload();
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;

    const request = new Request("http://localhost/slack/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("returns 400 for missing payload", async () => {
    const body = "no_payload=true";
    const timestamp = String(Math.floor(Date.now() / 1000));

    // We need a valid signature for this body
    const { generateSlackSignature } = await import("../setup.ts");
    const signature = await generateSlackSignature(signingSecret, timestamp, body);

    const request = new Request("http://localhost/slack/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("returns 200 for unknown action", async () => {
    const payload = createMockSlackPayload({}, { action_id: "unknown_action" });

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(200);
  });

  it("returns 200 for no-op ticket selector actions", async () => {
    const payload = createMockSlackPayload({}, { action_id: "select_ticket_0" });

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(200);
  });

  it("returns 200 for no-op hours selector actions", async () => {
    const payload = createMockSlackPayload({}, { action_id: "select_hours_0" });

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(200);
  });

  it("returns 200 with JSON 'Procesando...' body and schedules submit_hours via waitUntil", async () => {
    const payload = createMockSlackPayload(
      {
        state: {
          values: {
            ticket_block_0: {
              select_ticket_0: {
                type: "external_select",
                selected_option: {
                  text: { type: "plain_text", text: "TEST-100" },
                  value: "TEST-100",
                },
              },
            },
            hours_block_0: {
              select_hours_0: {
                type: "static_select",
                selected_option: {
                  text: { type: "plain_text", text: "2.0h" },
                  value: "2.0",
                },
              },
            },
          },
        },
      },
      { action_id: "submit_hours", value: "2026-04-08" },
    );

    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as {
      replace_original: boolean;
      text: string;
      blocks: unknown[];
    };
    expect(body.replace_original).toBe(true);
    expect(body.text).toContain("Processing");
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);

    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });

  it("returns 200 and processes add_slot via waitUntil", async () => {
    const payload = createMockSlackPayload({}, { action_id: "add_slot", value: "3:2026-04-08" });

    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(mockCtx.waitUntil).toHaveBeenCalled();
  });

  it("returns 200 for payload with no actions", async () => {
    const payload = createMockSlackPayload({ actions: [] });

    const request = await createSignedSlackRequest(signingSecret, payload);
    const response = await handleSlackInteraction(request, env, mockCtx);
    expect(response.status).toBe(200);
  });
});
