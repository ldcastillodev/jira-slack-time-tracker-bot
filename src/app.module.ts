import { Module } from "@nestjs/common";
import { ContextModule } from "./context/context.module.ts";
import { ConfigModule } from "./config/config.module.ts";
import { JiraModule } from "./jira/jira.module.ts";
import { SlackModule } from "./slack/slack.module.ts";
import { AggregatorModule } from "./aggregator/aggregator.module.ts";
import { BuilderModule } from "./builders/builder.module.ts";
import { CronModule } from "./cron/cron.module.ts";

@Module({
  imports: [
    ContextModule,
    ConfigModule,
    JiraModule,
    SlackModule,
    AggregatorModule,
    BuilderModule,
    CronModule,
  ],
})
export class AppModule {}
