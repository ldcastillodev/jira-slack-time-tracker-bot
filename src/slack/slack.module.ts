import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.ts";
import { JiraModule } from "../jira/jira.module.ts";
import { AggregatorModule } from "../aggregator/aggregator.module.ts";
import { BuilderModule } from "../builders/builder.module.ts";
import { SlackService } from "./slack.service.ts";
import { SlackCommandHandler } from "./handlers/slack-command.handler.ts";
import { SlackInteractionHandler } from "./handlers/slack-interaction.handler.ts";
import { SlackOptionsHandler } from "./handlers/slack-options.handler.ts";

@Module({
  imports: [ConfigModule, JiraModule, AggregatorModule, BuilderModule],
  providers: [SlackService, SlackCommandHandler, SlackInteractionHandler, SlackOptionsHandler],
  exports: [SlackService, SlackCommandHandler, SlackInteractionHandler, SlackOptionsHandler],
})
export class SlackModule {}
