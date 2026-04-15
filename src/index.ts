import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { INestApplicationContext } from "@nestjs/common";
import { AppModule } from "./app.module.ts";
import { runInContext } from "./context/async-local-storage.ts";
import { SlackCommandHandler } from "./slack/handlers/slack-command.handler.ts";
import { SlackInteractionHandler } from "./slack/handlers/slack-interaction.handler.ts";
import { SlackOptionsHandler } from "./slack/handlers/slack-options.handler.ts";
import { CronHandler } from "./cron/cron.handler.ts";
import type { Env } from "./common/types/index.ts";

// ─── Singleton NestJS Application Context ───
let appContext: INestApplicationContext | null = null;

async function bootstrap(): Promise<INestApplicationContext> {
  if (!appContext) {
    appContext = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
  }
  return appContext;
}

export default {
  /**
   * HTTP request handler — routes incoming requests.
   * Wraps each invocation in AsyncLocalStorage to make env/ctx
   * available to all @Injectable() services via RequestContextService.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = await bootstrap();

    return runInContext(env, ctx, async () => {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === "/health" && request.method === "GET") {
        return new Response("OK", { status: 200 });
      }

      // Slack interactive components webhook
      if (url.pathname === "/slack/interactions" && request.method === "POST") {
        const handler = app.get(SlackInteractionHandler);
        return handler.handleSlackInteraction(request);
      }

      // Slack external_select options endpoint
      if (url.pathname === "/slack/options" && request.method === "POST") {
        const handler = app.get(SlackOptionsHandler);
        return handler.handleSlackOptions(request);
      }

      // Slack slash commands endpoint
      if (url.pathname === "/slack/commands" && request.method === "POST") {
        const handler = app.get(SlackCommandHandler);
        return handler.handleSlackCommand(request);
      }

      // Manual cron trigger (for testing)
      if (url.pathname === "/trigger" && request.method === "POST") {
        const cronHandler = app.get(CronHandler);
        ctx.waitUntil(runInContext(env, ctx, () => cronHandler.handleScheduledSummary()));
        return new Response("Triggered", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });
  },

  /**
   * Cron trigger handler — fires on the configured schedule.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const app = await bootstrap();

    return runInContext(env, ctx, async () => {
      const cronHandler = app.get(CronHandler);

      switch (controller.cron) {
        // Casos para el reporte de horas (4 PM ET)
        case "0 20 * * 1-5":
        case "0 21 * * 1-5":
          await cronHandler.handleScheduledSummary();
          break;

        // Casos para el refresh de tickets (11 AM ET)
        case "0 15 * * *":
        case "0 16 * * *":
          await cronHandler.handleScheduledTicketsRefresh();
          break;

        default:
          console.warn(`Cron no reconocido: ${controller.cron}`);
      }
    });
  },
};
