import type { Env, JiraConfig, JiraUsers, SlackBlock, CachedTicket } from "../types/index.ts";
import { CACHE_KEY_ALL_TICKETS, TTL_ALL_TICKETS } from "../constants.ts";
import { loadConfig } from "../config.ts";
import { getTodayET, getCurrentHourET, isFriday, getWeekBoundaries } from "../utils/date.ts";
import { searchIssuesWithWorklogs, buildAccountIdEmailMap } from "../services/jira.ts";
import { lookupUserByEmail, sendDirectMessage } from "../services/slack.ts";
import { aggregateUserHours, aggregateWeeklyHours } from "../services/aggregator.ts";
import { buildDailyMessage, buildWeeklyMessage } from "../builders/message-builder.ts";

/**
 * Cron handler: runs on dual UTC triggers (20:00 and 21:00) Mon-Fri.
 * Only executes if the current ET hour matches the configured cronHourET (16 = 4PM).
 */
export async function handleScheduled(env: Env): Promise<void> {
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
  const friday = isFriday(new Date());
  const { monday, friday: weekFriday } = getWeekBoundaries(new Date());

  const issues = await searchIssuesWithWorklogs(env);
  console.log(`Fetched ${issues.length} issues with worklogs`);

  // Cache all tickets in KV for external_select typeahead
  const seenKeys = new Set<string>();
  const cachedTickets: CachedTicket[] = [];

  // Generic tickets first (priority in search results)
  for (const gt of jiraConfig.jira.genericTickets) {
    if (!seenKeys.has(gt.key)) {
      cachedTickets.push({ key: gt.key, summary: gt.summary });
      seenKeys.add(gt.key);
    }
  }

  // All project issues
  for (const issue of issues) {
    if (!seenKeys.has(issue.key)) {
      cachedTickets.push({ key: issue.key, summary: issue.summary });
      seenKeys.add(issue.key);
    }
  }

  await env.CACHE.put(CACHE_KEY_ALL_TICKETS, JSON.stringify(cachedTickets), {
    expirationTtl: TTL_ALL_TICKETS,
  });
  console.log(`Cached ${cachedTickets.length} tickets in KV for typeahead`);

  // Build accountId → email mapping
  const accountEmailMap = await buildAccountIdEmailMap(env, issues);

  // Aggregate daily hours per user
  const dailySummaries = aggregateUserHours(issues, accountEmailMap, today, userEmails);

  // Aggregate weekly hours if Friday
  const weeklySummaries = friday
    ? aggregateWeeklyHours(issues, accountEmailMap, userEmails, monday, weekFriday)
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
        blocks.push(...buildDailyMessage(dailySummary, config, today, jiraConfig));
        blocks.push(...buildWeeklyMessage(weeklySummary, config));
      }
    } else {
      blocks.push(...buildDailyMessage(dailySummary, config, today, jiraConfig));
    }

    const fallbackText = `Reporte de horas: ${dailySummary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`;
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
