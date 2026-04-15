import { Injectable } from "@nestjs/common";
import { ConfigService } from "../config/config.service.ts";
import { JiraService } from "../jira/jira.service.ts";
import { SlackService } from "../slack/slack.service.ts";
import { AggregatorService } from "../aggregator/aggregator.service.ts";
import { MessageBuilderService } from "../builders/message-builder.service.ts";
import {
  getTodayET,
  getCurrentHourET,
  isFriday,
  getWeekBoundaries,
  formatDateSpanishLong,
} from "../common/utils/date.ts";
import type { SlackBlock } from "../common/types/index.ts";

@Injectable()
export class CronHandler {
  constructor(
    private readonly configService: ConfigService,
    private readonly jiraService: JiraService,
    private readonly slackService: SlackService,
    private readonly aggregatorService: AggregatorService,
    private readonly messageBuilderService: MessageBuilderService,
  ) {}

  async handleScheduledSummary(): Promise<void> {
    const config = this.configService.config;
    const currentHourET = getCurrentHourET();
    const userEmails = this.configService.userEmails;
    const jiraConfig = this.configService.jiraConfig;

    if (currentHourET !== config.tracking.cronHourET) {
      console.log(
        `Skipping: current ET hour is ${currentHourET}, configured is ${config.tracking.cronHourET}`,
      );
      return;
    }

    console.log("⏱️ Starting daily hours check...");

    const today = getTodayET();
    const dateLabel = formatDateSpanishLong(today);
    const friday = isFriday(new Date());
    const { monday, friday: weekFriday } = getWeekBoundaries(new Date());

    const tickets = await this.jiraService.searchAllTicketsWithWorklogs();
    console.log(`Fetched ${tickets.length} tickets with worklogs`);

    const accountEmailMap = await this.jiraService.buildAccountIdEmailMap(tickets);

    const dailySummaries = this.aggregatorService.aggregateUserHours(
      tickets,
      accountEmailMap,
      today,
      userEmails,
    );

    const weeklySummaries = friday
      ? this.aggregatorService.aggregateWeeklyHours(
          tickets,
          accountEmailMap,
          userEmails,
          monday,
          weekFriday,
        )
      : null;

    let sentCount = 0;
    for (const email of userEmails) {
      const lowerEmail = email.toLowerCase();
      const dailySummary = dailySummaries.get(lowerEmail);
      if (!dailySummary) {
        console.error(`No summary found for ${email}`);
        continue;
      }
      console.log(`Daily summary for ${email}:`, `total hours today ${dailySummary?.totalHours}`);

      const slackUserId = await this.slackService.lookupUserByEmail(email);
      if (!slackUserId) {
        console.error(`Could not resolve Slack user for ${email}`);
        continue;
      }

      const blocks: SlackBlock[] = [];
      if (friday && weeklySummaries) {
        const weeklySummary = weeklySummaries.get(lowerEmail);
        if (weeklySummary) {
          blocks.push(
            ...this.messageBuilderService.buildDailyMessage(
              dailySummary,
              config,
              today,
              jiraConfig,
              undefined,
              undefined,
              dateLabel,
            ),
          );
          blocks.push(...this.messageBuilderService.buildWeeklyMessage(weeklySummary, config));
        }
      } else {
        blocks.push(
          ...this.messageBuilderService.buildDailyMessage(
            dailySummary,
            config,
            today,
            jiraConfig,
            undefined,
            undefined,
            dateLabel,
          ),
        );
      }

      const fallbackText = `Reporte de horas: ${dailySummary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`;
      const sent = await this.slackService.sendDirectMessage(slackUserId, blocks, fallbackText);

      if (sent) {
        sentCount++;
        console.log(`Sent to ${email} (${dailySummary.totalHours.toFixed(1)}h today)`);
      } else {
        console.error(`Failed to send to ${email}`);
      }
    }

    console.log(`Done: sent ${sentCount}/${userEmails.length} notifications`);
  }

  async handleScheduledTicketsRefresh(): Promise<void> {
    try {
      await this.jiraService.refreshJiraTicketsCache();
    } catch (error) {
      console.error("Failed to refresh Jira tickets cache:", error);
    }
  }
}
