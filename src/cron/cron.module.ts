import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.ts";
import { JiraModule } from "../jira/jira.module.ts";
import { SlackModule } from "../slack/slack.module.ts";
import { AggregatorModule } from "../aggregator/aggregator.module.ts";
import { BuilderModule } from "../builders/builder.module.ts";
import { CronHandler } from "./cron.handler.ts";

@Module({
  imports: [ConfigModule, JiraModule, SlackModule, AggregatorModule, BuilderModule],
  providers: [CronHandler],
  exports: [CronHandler],
})
export class CronModule {}
