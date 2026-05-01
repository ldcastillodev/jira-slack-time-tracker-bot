import type { Env, JiraConfig, JiraUsers, SlackBlock } from "../types/index.ts";
import { loadConfig } from "../../config/config.ts";
import {
  getTodayET,
  getCurrentHourET,
  isFriday,
  getWeekBoundaries,
  formatDateLong,
} from "../utils/date.ts";
import {
  buildAccountIdEmailMap,
  refreshJiraTicketsCache,
  searchAllTicketsWithWorklogs,
} from "../services/jira.ts";
import { lookupUserByEmail, sendDirectMessage } from "../services/slack.ts";
import { aggregateUserHours, aggregateWeeklyHours } from "../services/aggregator.ts";
import { buildDailyMessage, buildWeeklyMessage } from "../builders/message-builder.ts";

/**
 * Cron handler: runs on dual UTC triggers (20:00 and 21:00) Mon-Fri.
 * Only executes if the current ET hour matches the configured cronHourET (16 = 4PM).
 */
export async function handleScheduledSummary(env: Env): Promise<void> {
  const config = loadConfig();
  const currentHourET = getCurrentHourET();
  const users = JSON.parse(env.USERS) as JiraUsers;
  const userEmails = Object.keys(users);

  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;

  // Only execute at the configured hour in ET (handles DST automatically)
  if (currentHourET !== config.tracking.cronHourET) {
    console.log(
      `Skipping: current ET hour is ${currentHourET}, configured is ${config.tracking.cronHourET}`,
    );
    return;
  }

  console.log("⏱️ Starting daily hours check...");

  const today = getTodayET();
  const dateLabel = formatDateLong(today);
  const friday = isFriday(new Date());
  const { monday, friday: weekFriday } = getWeekBoundaries(new Date());

  const tickets = await searchAllTicketsWithWorklogs(env);
  console.log(`Fetched ${tickets.length} tickets with worklogs`);

  // Build accountId → email mapping
  const accountEmailMap = await buildAccountIdEmailMap(env, tickets);

  // Aggregate daily hours per user
  const dailySummaries = aggregateUserHours(tickets, accountEmailMap, today, userEmails);

  // Aggregate weekly hours if Friday
  const weeklySummaries = friday
    ? aggregateWeeklyHours(tickets, accountEmailMap, userEmails, monday, weekFriday)
    : null;

  // Send messages to each user
  let sentCount = 0;
  for (const email of userEmails) {
    const lowerEmail = email.toLowerCase();
    const dailySummary = dailySummaries.get(lowerEmail);
    if (!dailySummary) {
      console.error(`No summary found for ${email}`);
      continue;
    }
    console.log(`Daily summary for ${email}:`, `total hours today ${dailySummary?.totalHours}`);
    // Resolve Slack user ID
    const slackUserId = await lookupUserByEmail(env, email);
    if (!slackUserId) {
      console.error(`Could not resolve Slack user for ${email}`);
      continue;
    }

    // Build message based on day of week
    const blocks: SlackBlock[] = [];
    if (friday && weeklySummaries) {
      const weeklySummary = weeklySummaries.get(lowerEmail);
      if (weeklySummary) {
        blocks.push(
          ...buildDailyMessage(
            dailySummary,
            config,
            today,
            jiraConfig,
            undefined,
            undefined,
            dateLabel,
          ),
        );
        blocks.push(...buildWeeklyMessage(weeklySummary, config));
      }
    } else {
      blocks.push(
        ...buildDailyMessage(
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

    const fallbackText = `Hours report: ${dailySummary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`;
    const sent = await sendDirectMessage(env, slackUserId, blocks, fallbackText);

    if (sent) {
      sentCount++;
      console.log(`Sent to ${email} (${dailySummary.totalHours.toFixed(1)}h today)`);
    } else {
      console.error(`Failed to send to ${email}`);
    }
  }

  console.log(`Done: sent ${sentCount}/${userEmails.length} notifications`);
}

/**
 * Cron handler: runs once at day at 11 a.m. ET.
 */
export async function handleScheduledTicketsRefresh(env: Env): Promise<void> {
  try {
    await refreshJiraTicketsCache(env);
  } catch (error) {
    console.error("Failed to refresh Jira tickets cache:", error);
  }
}
