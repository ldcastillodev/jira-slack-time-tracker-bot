import { defineConfig } from "vitest/config";
import { cloudflareTest, cloudflarePool } from "@cloudflare/vitest-pool-workers";
import path from "node:path";

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
      JIRA_CONFIG: JSON.stringify({
        jira: {
          boards: ["TEST"],
          genericTickets: [{ key: "TEST-1", summary: "Generic Ticket 1" }],
          projectComponents: [{ name: "Component1" }],
        },
      }),
    },
    kvNamespaces: ["CACHE"],
  },
} as const;

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  resolve: {
    alias: {
      "@nestjs/common": path.resolve(__dirname, "tests/__mocks__/nestjs-common.ts"),
      "@nestjs/core": path.resolve(__dirname, "tests/__mocks__/nestjs-core.ts"),
      "reflect-metadata": path.resolve(__dirname, "tests/__mocks__/reflect-metadata.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    pool: cloudflarePool(workersOptions),
  },
});
