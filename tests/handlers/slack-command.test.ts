import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSlackCommand } from "../../src/handlers/slack-command.ts";
import {
  createMockEnv,
  createSignedSlackCommandRequest,
  generateSlackSignature,
  mockJsonResponse,
} from "../setup.ts";
import type { Env } from "../../src/types/index.ts";

const SIGNING_SECRET = "test-signing-secret";
const USER_SLACK_ID = "U12345";
const USER_EMAIL = "user1@example.com";

const mockCtx = {
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("handleSlackCommand", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // KV resolves the Slack ID → email mapping
    const mockKV = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === `slack_user:${USER_EMAIL}`) return USER_SLACK_ID;
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    (mockCtx.waitUntil as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Security ───

  it("returns 401 for an invalid Slack signature", async () => {
    const body = "command=%2Fsummary&user_id=U12345&response_url=https%3A%2F%2Fhooks.slack.com";

    const request = new Request("http://localhost/slack/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalidsignature",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    const response = await handleSlackCommand(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("returns 401 for a replayed request (timestamp > 5 minutes old)", async () => {
    const body = "command=%2Fsummary&user_id=U12345&response_url=https%3A%2F%2Fhooks.slack.com";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = await generateSlackSignature(SIGNING_SECRET, staleTimestamp, body);

    const request = new Request("http://localhost/slack/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": staleTimestamp,
      },
      body,
    });

    const response = await handleSlackCommand(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  // ─── Validation ───

  it("returns 400 when required fields are missing", async () => {
    // Body with no command, user_id, or response_url
    const body = "text=";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSlackSignature(SIGNING_SECRET, timestamp, body);

    const request = new Request("http://localhost/slack/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    const response = await handleSlackCommand(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  // ─── Command Dispatcher ───

  it("returns 200 with loading message and schedules async work for /summary", async () => {
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/summary",
      user_id: USER_SLACK_ID,
      response_url: "https://hooks.slack.com/commands/test/response",
    });

    const response = await handleSlackCommand(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("⏳");

    // Async work was scheduled
    expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it("returns 200 with unknown-command ephemeral for unrecognised commands", async () => {
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/unknown",
      user_id: USER_SLACK_ID,
      response_url: "https://hooks.slack.com/commands/test/response",
    });

    const response = await handleSlackCommand(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("/unknown");

    // No async work for unknown commands
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });

  // ─── processSummaryCommand — error path ───

  it("posts a friendly error to response_url when user cannot be identified", async () => {
    // KV returns null for every key → email not resolvable
    const noMatchKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: noMatchKV as unknown as KVNamespace });

    fetchSpy.mockResolvedValue(mockJsonResponse({ ok: true }));

    const responseUrl = "https://hooks.slack.com/commands/test/response";
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/summary",
      user_id: "U_UNKNOWN",
      response_url: responseUrl,
    });

    // Capture the promise scheduled via waitUntil and await it
    let capturedPromise: Promise<unknown> | undefined;
    (mockCtx.waitUntil as ReturnType<typeof vi.fn>).mockImplementation((p: Promise<unknown>) => {
      capturedPromise = p;
    });

    await handleSlackCommand(request, env, mockCtx);
    await capturedPromise;

    // Should have called response_url with an error message
    expect(fetchSpy).toHaveBeenCalledWith(responseUrl, expect.objectContaining({ method: "POST" }));
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      blocks: Array<{ text: { text: string } }>;
    };
    expect(callBody.blocks[0].text.text).toContain("No se pudo identificar");
  });

  // ─── processSummaryCommand — success path ───

  it("posts weekly summary blocks to response_url on success", async () => {
    // KV resolves email from Slack ID
    const mockKV = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === `slack_user:${USER_EMAIL}`) return USER_SLACK_ID;
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    };
    env = createMockEnv({ CACHE: mockKV as unknown as KVNamespace });

    // Mock Jira API search
    fetchSpy.mockResolvedValue(
      mockJsonResponse({
        issues: [],
        nextPageToken: undefined,
      }),
    );

    const responseUrl = "https://hooks.slack.com/commands/test/response";
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/summary",
      user_id: USER_SLACK_ID,
      response_url: responseUrl,
    });

    let capturedPromise: Promise<unknown> | undefined;
    (mockCtx.waitUntil as ReturnType<typeof vi.fn>).mockImplementation((p: Promise<unknown>) => {
      capturedPromise = p;
    });

    const response = await handleSlackCommand(request, env, mockCtx);
    expect(response.status).toBe(200);

    await capturedPromise;

    // Final call to response_url should include blocks
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe(responseUrl);
    const sentBody = JSON.parse(lastCall[1].body as string) as {
      blocks: unknown[];
      replace_original: boolean;
    };
    expect(sentBody.replace_original).toBe(true);
    expect(Array.isArray(sentBody.blocks)).toBe(true);
    expect(sentBody.blocks.length).toBeGreaterThan(0);
  });
});
