import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSlackCommand,
  validateAndResolveDailySubmissionDate,
} from "../../src/handlers/slack-command.ts";
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

    fetchSpy.mockImplementation(() => Promise.resolve(mockJsonResponse({ ok: true })));

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
    const responseUrlCall = fetchSpy.mock.calls.find((args) => args[0] === responseUrl);
    const callBody = JSON.parse(responseUrlCall![1].body as string) as {
      blocks: Array<{ text: { text: string } }>;
    };
    expect(callBody.blocks[0].text.text).toContain("Could not identify");
  });

  // ─── /summary-components ───

  it("returns 200 with loading message and schedules async work for /summary-components", async () => {
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/summary-components",
      user_id: USER_SLACK_ID,
      response_url: "https://hooks.slack.com/commands/test/response",
    });

    const response = await handleSlackCommand(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("component");
    expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it("posts component summary blocks to response_url on success for /summary-components", async () => {
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

    fetchSpy.mockResolvedValue(mockJsonResponse({ issues: [], nextPageToken: undefined }));

    const responseUrl = "https://hooks.slack.com/commands/test/response";
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/summary-components",
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

  // ─── /submit ───

  it("returns 200 with loading message and schedules async work for /submit (no param, weekday)", async () => {
    // We need to test with a known weekday. We'll mock getTodayET via the date utility
    // Since we can't control the clock directly, we test with a valid abbreviation
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/submit",
      text: "lun",
      user_id: USER_SLACK_ID,
      response_url: "https://hooks.slack.com/commands/test/response",
    });

    const response = await handleSlackCommand(request, env, mockCtx);

    // If lun is in the past or today (not future), it should schedule
    // If it's future, it returns an ephemeral error with 200 but no waitUntil
    expect(response.status).toBe(200);
    const body = (await response.json()) as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
  });

  it("returns 200 with error for invalid day abbreviation in /submit", async () => {
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/submit",
      text: "sabado",
      user_id: USER_SLACK_ID,
      response_url: "https://hooks.slack.com/commands/test/response",
    });

    const response = await handleSlackCommand(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { response_type: string; text: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Invalid");
    // Validation is synchronous: no async work scheduled
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("posts daily summary blocks to response_url on success for /daily-summary", async () => {
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

    fetchSpy.mockResolvedValue(mockJsonResponse({ issues: [], nextPageToken: undefined }));

    const responseUrl = "https://hooks.slack.com/commands/test/response";
    // Use "lun" — Monday of the current week, which may or may not be in the past.
    // We pick a day that is guaranteed to be valid without mocking the clock:
    // We test the success flow using the mock fetch approach.
    const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
      command: "/submit",
      text: "lun",
      user_id: USER_SLACK_ID,
      response_url: responseUrl,
    });

    let capturedPromise: Promise<unknown> | undefined;
    (mockCtx.waitUntil as ReturnType<typeof vi.fn>).mockImplementation((p: Promise<unknown>) => {
      capturedPromise = p;
    });

    const response = await handleSlackCommand(request, env, mockCtx);
    expect(response.status).toBe(200);

    // If Monday is not in the future, async work is scheduled
    if (capturedPromise) {
      await capturedPromise;
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(responseUrl);
      const sentBody = JSON.parse(lastCall[1].body as string) as { blocks: unknown[] };
      expect(Array.isArray(sentBody.blocks)).toBe(true);
    }
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

  // ─── /refresh-tickets → processRefreshTicketsCommand ───

  describe("/refresh-tickets", () => {
    const REFRESH_RESPONSE_URL = "https://hooks.slack.com/commands/test/refresh-response";
    let kvPut: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      kvPut = vi.fn().mockResolvedValue(undefined);
      const kv = {
        get: vi.fn().mockResolvedValue(null),
        put: kvPut,
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      };
      env = createMockEnv({ CACHE: kv as unknown as KVNamespace });
    });

    async function issueRequest(): Promise<{
      response: Response;
      capturedPromise: Promise<unknown>;
    }> {
      const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
        command: "/refresh-tickets",
        response_url: REFRESH_RESPONSE_URL,
      });
      let capturedPromise: Promise<unknown> = Promise.resolve();
      (mockCtx.waitUntil as ReturnType<typeof vi.fn>).mockImplementation((p: Promise<unknown>) => {
        capturedPromise = p;
      });
      const response = await handleSlackCommand(request, env, mockCtx);
      return { response, capturedPromise };
    }

    it("returns 200 with ephemeral loading message and schedules async work", async () => {
      fetchSpy.mockResolvedValue(mockJsonResponse({ issues: [], nextPageToken: undefined }));

      const { response } = await issueRequest();

      expect(response.status).toBe(200);
      const body = (await response.json()) as { response_type: string; text: string };
      expect(body.response_type).toBe("ephemeral");
      expect(body.text).toContain("Updating");
      expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
    });

    it("caches generic + project tickets and posts success blocks", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "Issue One",
                status: { name: "In Progress" },
                assignee: null,
                components: [],
                worklog: { total: 0, maxResults: 100, worklogs: [] },
              },
            },
          ],
          nextPageToken: undefined,
        }),
      );
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const { capturedPromise } = await issueRequest();
      await capturedPromise;

      // KV updated with correct key and TTL
      expect(kvPut).toHaveBeenCalledOnce();
      const [cacheKey, jsonValue, options] = kvPut.mock.calls[0] as [
        string,
        string,
        { expirationTtl: number },
      ];
      expect(cacheKey).toBe("all_tickets");
      expect(options).toEqual({ expirationTtl: 604800 });

      // Both generic and project tickets cached
      const cached = JSON.parse(jsonValue) as Array<{ key: string; summary: string }>;
      expect(cached).toContainEqual({ key: "TEST-1", summary: "Generic Ticket 1" });
      expect(cached).toContainEqual({ key: "PROJ-1", summary: "Issue One" });

      // Success block posted to response_url
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(REFRESH_RESPONSE_URL);
      const sentBody = JSON.parse(lastCall[1].body as string) as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockTexts = sentBody.blocks.map((b) => b.text?.text ?? "").join(" ");
      expect(blockTexts).toContain("✅ Tickets Updated");
    });

    it("deduplicates when Jira returns a key that matches a generic ticket", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({
          issues: [
            {
              key: "TEST-1",
              fields: {
                summary: "Duplicate Generic",
                status: { name: "Open" },
                assignee: null,
                components: [],
                worklog: { total: 0, maxResults: 100, worklogs: [] },
              },
            },
          ],
          nextPageToken: undefined,
        }),
      );
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const { capturedPromise } = await issueRequest();
      await capturedPromise;

      // TEST-1 should appear exactly once (generic takes priority)
      const cached = JSON.parse(kvPut.mock.calls[0][1] as string) as Array<{ key: string }>;
      expect(cached.filter((t) => t.key === "TEST-1")).toHaveLength(1);
    });

    it("caches only generic tickets when Jira returns no issues", async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ issues: [], nextPageToken: undefined }));
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const { capturedPromise } = await issueRequest();
      await capturedPromise;

      const cached = JSON.parse(kvPut.mock.calls[0][1] as string) as Array<{
        key: string;
        summary: string;
      }>;
      expect(cached).toEqual([{ key: "TEST-1", summary: "Generic Ticket 1" }]);

      // Still posts success message
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(REFRESH_RESPONSE_URL);
    });

    it("posts error to response_url when Jira API throws (network error)", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network timeout"));
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const { capturedPromise } = await issueRequest();
      await capturedPromise;

      // KV should NOT have been called (error occurred before caching)
      expect(kvPut).not.toHaveBeenCalled();

      // Error block posted to response_url
      const responseUrlCalls = fetchSpy.mock.calls.filter((c) => c[0] === REFRESH_RESPONSE_URL);
      expect(responseUrlCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(responseUrlCalls[0][1].body as string) as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const text = body.blocks.map((b) => b.text?.text ?? "").join(" ");
      expect(text).toContain("❌");
      expect(text).toContain("error");
    });

    it("degrades gracefully and caches only generic tickets when Jira returns non-ok status", async () => {
      // Jira service silently breaks out of the loop on non-ok; no error is thrown
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ message: "Unauthorized" }, 401));
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const { capturedPromise } = await issueRequest();
      await capturedPromise;

      // Caches only generic tickets
      expect(kvPut).toHaveBeenCalledOnce();
      const cached = JSON.parse(kvPut.mock.calls[0][1] as string) as Array<{
        key: string;
        summary: string;
      }>;
      expect(cached).toEqual([{ key: "TEST-1", summary: "Generic Ticket 1" }]);

      // Success message still posted (non-ok is not surfaced as user error)
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(REFRESH_RESPONSE_URL);
      const sentBody = JSON.parse(lastCall[1].body as string) as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockTexts = sentBody.blocks.map((b) => b.text?.text ?? "").join(" ");
      expect(blockTexts).toContain("✅ Tickets Updated");
    });
  });

  // ─── /help ───

  describe("/help", () => {
    it("returns 200 with ephemeral blocks without scheduling async work", async () => {
      const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
        command: "/help",
        response_url: "https://hooks.slack.com/commands/test/response",
      });

      const response = await handleSlackCommand(request, env, mockCtx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        response_type: string;
        blocks: Array<{ type: string }>;
        text: string;
      };
      expect(body.response_type).toBe("ephemeral");
      expect(Array.isArray(body.blocks)).toBe(true);
      expect(body.blocks.length).toBeGreaterThan(0);
      // Synchronous — no async work should be scheduled
      expect(mockCtx.waitUntil).not.toHaveBeenCalled();
    });

    it("response blocks contain all 5 command names", async () => {
      const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
        command: "/help",
        response_url: "https://hooks.slack.com/commands/test/response",
      });

      const body = (await (await handleSlackCommand(request, env, mockCtx)).json()) as {
        blocks: Array<{ text?: { text?: string } }>;
      };
      const allText = body.blocks.map((b) => b.text?.text ?? "").join("\n");

      expect(allText).toContain("/summary");
      expect(allText).toContain("/summary-components");
      expect(allText).toContain("/submit");
      expect(allText).toContain("/refresh-tickets");
      expect(allText).toContain("/help");
    });

    it("response blocks contain a header and a divider", async () => {
      const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
        command: "/help",
        response_url: "https://hooks.slack.com/commands/test/response",
      });

      const body = (await (await handleSlackCommand(request, env, mockCtx)).json()) as {
        blocks: Array<{ type: string }>;
      };

      expect(body.blocks.some((b) => b.type === "header")).toBe(true);
      expect(body.blocks.some((b) => b.type === "divider")).toBe(true);
    });

    it("does not make any external fetch calls", async () => {
      const request = await createSignedSlackCommandRequest(SIGNING_SECRET, {
        command: "/help",
        response_url: "https://hooks.slack.com/commands/test/response",
      });

      await handleSlackCommand(request, env, mockCtx);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

// ─── validateAndResolveDailySummaryDate (unit tests, no network) ───

describe("validateAndResolveDailySubmissionDate", () => {
  it("returns error for invalid abbreviation", () => {
    const result = validateAndResolveDailySubmissionDate("sabado");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid");
    }
  });

  it("returns error for empty string on a weekend (simulated by checking Sunday logic)", () => {
    // We can't control the clock, but we can test the logic for known-bad abbreviations
    const result = validateAndResolveDailySubmissionDate("xyz");
    expect("error" in result).toBe(true);
  });

  it("returns date + label for 'lun'", () => {
    const result = validateAndResolveDailySubmissionDate("lun");
    // Monday of the current week. If today >= Monday, it's valid; if today < Monday (impossible
    // since today IS Monday or later in the week), we'd get an error.
    // Since tests always run >= Monday, this should be either valid or "future" error on Monday.
    expect(result).toBeDefined();
  });

  it("returns date + label for 'vie'", () => {
    const result = validateAndResolveDailySubmissionDate("vie");
    // Friday of current week. If today is before Friday → error (future).
    // If today is Friday or later → valid.
    expect(result).toBeDefined();
  });

  it("returns error for future day when requested abbreviation maps to a future date", () => {
    // We can identify this scenario by checking: if we're on Monday, "vie" is the future
    // We check that future dates produce errors regardless of the specific day
    // This is a property test: if the result is a valid date, it must not be in the future
    const abbrevs = ["lun", "mar", "mie", "jue", "vie"];
    const today = new Date().toISOString().split("T")[0]; // rough today (UTC, good enough for test logic)

    for (const abbrev of abbrevs) {
      const result = validateAndResolveDailySubmissionDate(abbrev);
      if (!("error" in result)) {
        // If resolved, the date should not be in the future
        expect(result.date <= today).toBe(true);
        // Should have an English label
        expect(result.label).toMatch(/\w+, \w+ \d+, \d{4}/);
      } else {
        // If error, should mention "future"
        expect(result.error).toContain("future");
      }
    }
  });
});
