import type { Env } from "../types/index.ts";
import { loadConfig } from "../config.ts";
import { getTodayET, getCurrentHourET, isFriday, getWeekBoundaries } from "../utils/date.ts";
import { searchIssuesWithWorklogs, buildAccountIdEmailMap } from "../services/jira.ts";
import { lookupUserByEmail, sendDirectMessage } from "../services/slack.ts";
import { aggregateUserHours, aggregateWeeklyHours } from "../services/aggregator.ts";
import { buildDailyMessage, buildFridayMessage } from "../builders/message-builder.ts";

/**
 * Cron handler: runs on dual UTC triggers (20:00 and 21:00) Mon-Fri.
 * Only executes if the current ET hour matches the configured cronHourET (16 = 4PM).
 */
export async function handleScheduled(env: Env): Promise<void> {
  const config = loadConfig();
  const currentHourET = getCurrentHourET();

  // Only execute at the configured hour in ET (handles DST automatically)
  if (currentHourET !== config.tracking.cronHourET) {
    console.log(`Skipping: current ET hour is ${currentHourET}, configured is ${config.tracking.cronHourET}`);
    return;
  }

  console.log("⏱️ Starting daily hours check...");

  const today = getTodayET();
  const friday = isFriday(new Date());
  const { monday, friday: weekFriday } = getWeekBoundaries(new Date());

  // Fetch issues with worklogs — for today (and full week if Friday)
  const dateFrom = friday ? monday : today;
  const dateTo = friday ? weekFriday : today;

  const issues = await searchIssuesWithWorklogs(env, config.jira.boards, dateFrom, dateTo);
  console.log(`Fetched ${issues.length} issues with worklogs`);

  // Build accountId → email mapping
  const accountEmailMap = await buildAccountIdEmailMap(env, issues);

  // Aggregate daily hours per user
  const dailySummaries = aggregateUserHours(issues, accountEmailMap, config.users, today);

  // Aggregate weekly hours if Friday
  const weeklySummaries = friday
    ? aggregateWeeklyHours(issues, accountEmailMap, config.users, monday, weekFriday)
    : null;

  // Send messages to each user
  let sentCount = 0;
  for (const email of config.users) {
    const lowerEmail = email.toLowerCase();
    const dailySummary = dailySummaries.get(lowerEmail);
    if (!dailySummary) {
      console.error(`No summary found for ${email}`);
      continue;
    }

    // Resolve Slack user ID
    const slackUserId = await lookupUserByEmail(env, email);
    if (!slackUserId) {
      console.error(`Could not resolve Slack user for ${email}`);
      continue;
    }

    // Build message based on day of week
    let blocks;
    if (friday && weeklySummaries) {
      const weeklySummary = weeklySummaries.get(lowerEmail);
      if (weeklySummary) {
        blocks = buildFridayMessage(dailySummary, weeklySummary, config);
      } else {
        blocks = buildDailyMessage(dailySummary, config);
      }
    } else {
      blocks = buildDailyMessage(dailySummary, config);
    }

    const fallbackText = `Reporte de horas: ${dailySummary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`;
    const sent = await sendDirectMessage(env, slackUserId, blocks, fallbackText);

    if (sent) {
      sentCount++;
      console.log(`✅ Sent to ${email} (${dailySummary.totalHours.toFixed(1)}h today)`);
    } else {
      console.error(`❌ Failed to send to ${email}`);
    }
  }

  console.log(`Done: sent ${sentCount}/${config.users.length} notifications`);
}
