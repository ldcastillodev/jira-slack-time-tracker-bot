import { defineConfig } from "vitest/config";
import { cloudflareTest, cloudflarePool } from "@cloudflare/vitest-pool-workers";

const workersOptions = {
  wrangler: {
    configPath: "./wrangler.toml",
  },
  miniflare: {
    bindings: {
      JIRA_BASE_URL: "https://test.atlassian.net",
      JIRA_API_TOKEN: "test-jira-token",
      JIRA_USER_EMAIL: "test@example.com",
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_SIGNING_SECRET: "test-signing-secret",
      USERS: JSON.stringify({
        "user1@example.com": "token1",
        "user2@example.com": "token2",
      }),
    },
    kvNamespaces: ["CACHE"],
  },
} as const;

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  test: {
    include: ["tests/**/*.test.ts"],
    pool: cloudflarePool(workersOptions),
  },
});
