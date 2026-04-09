import type {
  Env,
  JiraIssue,
  JiraWorklog,
  SlackInteractionPayload,
  SlackAction,
} from "../src/types/index.ts";

const ENCODER = new TextEncoder();

/**
 * Creates a mock Env object with test values.
 * KV namespace must be provided by the test (from miniflare bindings).
 */
export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE:
      overrides.CACHE ??
      ({
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace),
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_API_TOKEN: "test-jira-token",
    JIRA_USER_EMAIL: "test@example.com",
    JIRA_CONFIG: JSON.stringify({
      jira: {
        boards: ["TEST"],
        genericTickets: [{ key: "TEST-1", summary: "Generic Ticket 1" }],
        projectComponents: [{ name: "Component1" }],
      },
    }),
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    USERS: JSON.stringify({
      "user1@example.com": "token1",
      "user2@example.com": "token2",
    }),
    ...overrides,
  };
}

/**
 * Creates a mock JiraIssue with worklogs.
 */
export function createMockJiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "TEST-100",
    summary: "Test Issue",
    status: "In Progress",
    assigneeAccountId: "acc-123",
    assigneeEmail: "user1@example.com",
    assigneeDisplayName: "User One",
    worklogs: [],
    ...overrides,
  };
}

/**
 * Creates a mock JiraWorklog.
 */
export function createMockWorklog(overrides: Partial<JiraWorklog> = {}): JiraWorklog {
  return {
    id: "wl-1",
    issueKey: "TEST-100",
    issueSummary: "Test Issue",
    authorAccountId: "acc-123",
    authorEmail: "user1@example.com",
    authorDisplayName: "User One",
    started: "2026-04-08T12:00:00.000+0000",
    timeSpentSeconds: 3600,
    ...overrides,
  };
}

/**
 * Creates a mock SlackInteractionPayload.
 */
export function createMockSlackPayload(
  overrides: Partial<SlackInteractionPayload> = {},
  actionOverrides: Partial<SlackAction> = {},
): SlackInteractionPayload {
  return {
    type: "block_actions",
    user: {
      id: "U12345",
      username: "testuser",
      name: "Test User",
      team_id: "T12345",
    },
    trigger_id: "trigger-123",
    response_url: "https://hooks.slack.com/actions/test/response",
    actions: [
      {
        type: "button",
        action_id: "submit_hours",
        block_id: "submit_block",
        value: "2026-04-08",
        action_ts: "1234567890.123456",
        ...actionOverrides,
      },
    ],
    ...overrides,
  };
}

/**
 * Generates a valid Slack signature for testing.
 */
export async function generateSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const sigBasestring = `v0:${timestamp}:${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(sigBasestring));
  const hexDigest = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return `v0=${hexDigest}`;
}

/**
 * Creates a Slack interaction request with valid signature.
 */
export async function createSignedSlackRequest(
  signingSecret: string,
  payload: object,
  path: string = "/slack/interactions",
): Promise<Request> {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await generateSlackSignature(signingSecret, timestamp, body);

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/**
 * Helper to create a mock fetch response.
 */
export function mockJsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
