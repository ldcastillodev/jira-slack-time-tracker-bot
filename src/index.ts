import type { Env } from "./types/index.ts";
import { handleScheduled } from "./handlers/cron.ts";
import { handleSlackInteraction } from "./handlers/slack-interaction.ts";
import { handleSlackOptions } from "./handlers/slack-options.ts";

export default {
  /**
   * HTTP request handler — routes incoming requests.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    // Slack interactive components webhook
    if (url.pathname === "/slack/interactions" && request.method === "POST") {
      return handleSlackInteraction(request, env, ctx);
    }

    // Slack external_select options endpoint
    if (url.pathname === "/slack/options" && request.method === "POST") {
      return handleSlackOptions(request, env);
    }

    // Manual cron trigger (for testing)
    if (url.pathname === "/trigger" && request.method === "POST") {
      ctx.waitUntil(handleScheduled(env));
      return new Response("Triggered", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Cron trigger handler — fires on the configured schedule.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
