import type { Env } from "./types/index.ts";
import { handleScheduledSummary, handleScheduledTicketsRefresh } from "./handlers/cron.ts";
import { handleSlackInteraction } from "./handlers/slack-interaction.ts";
import { handleSlackOptions } from "./handlers/slack-options.ts";
import { handleSlackCommand } from "./handlers/slack-command.ts";

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

    // Slack slash commands endpoint
    if (url.pathname === "/slack/commands" && request.method === "POST") {
      return handleSlackCommand(request, env, ctx);
    }

    // Manual cron trigger (for testing)
    if (url.pathname === "/trigger" && request.method === "POST") {
      ctx.waitUntil(handleScheduledSummary(env));
      return new Response("Triggered", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Cron trigger handler — fires on the configured schedule.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      // Casos para el reporte de horas (4 PM ET)
      case "0 20 * * 2-6":
      case "0 21 * * 2-6":
        await handleScheduledSummary(env);
        break;

      // Casos para el refresh de tickets (11 AM ET)
      case "0 15 * * *":
      case "0 16 * * *":
        await handleScheduledTicketsRefresh(env);
        break;

      default:
        console.warn(`Cron no reconocido: ${controller.cron}`);
    }
  },
};
