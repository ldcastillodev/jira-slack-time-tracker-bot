/**
 * Stub for @nestjs/core — provides a lightweight NestFactory
 * that wires up all services/handlers manually (no real NestJS DI).
 * Used only in the Cloudflare Workers test pool where the full
 * NestJS runtime cannot load due to CJS/ESM incompatibilities.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { RequestContextService } from "../../src/context/request-context.service.ts";
import { ConfigService } from "../../src/config/config.service.ts";
import { JiraService } from "../../src/jira/jira.service.ts";
import { SlackService } from "../../src/slack/slack.service.ts";
import { AggregatorService } from "../../src/aggregator/aggregator.service.ts";
import { MessageBuilderService } from "../../src/builders/message-builder.service.ts";
import { SlackCommandHandler } from "../../src/slack/handlers/slack-command.handler.ts";
import { SlackInteractionHandler } from "../../src/slack/handlers/slack-interaction.handler.ts";
import { SlackOptionsHandler } from "../../src/slack/handlers/slack-options.handler.ts";
import { CronHandler } from "../../src/cron/cron.handler.ts";

export type INestApplicationContext = {
  get: <T>(cls: new (...args: any[]) => T) => T;
};

export const NestFactory = {
  async createApplicationContext(_module: any, _options?: any): Promise<INestApplicationContext> {
    const rcs = new RequestContextService();
    const cs = new ConfigService(rcs);
    const js = new JiraService(rcs, cs);
    const ss = new SlackService(rcs);
    const agg = new AggregatorService();
    const mbs = new MessageBuilderService();

    const registry = new Map<any, any>();
    registry.set(SlackCommandHandler, new SlackCommandHandler(rcs, cs, js, ss, agg, mbs));
    registry.set(SlackInteractionHandler, new SlackInteractionHandler(rcs, cs, js, ss, agg, mbs));
    registry.set(SlackOptionsHandler, new SlackOptionsHandler(rcs, cs));
    registry.set(CronHandler, new CronHandler(cs, js, ss, agg, mbs));

    return {
      get: <T>(cls: new (...args: any[]) => T): T => {
        const instance = registry.get(cls);
        if (!instance) throw new Error(`No provider for ${cls.name}`);
        return instance as T;
      },
    };
  },
};
