import type {
  Env,
  JiraUsers,
  JiraConfig,
  SlackCommandPayload,
  SlackBlock,
} from "../types/index.ts";
import { verifySlackSignature } from "../utils/crypto.ts";
import {
  getWeekBoundaries,
  getTodayET,
  getDayOfWeekET,
  getDayOfWeekFromSpanishAbbrev,
  getDateForDayOfCurrentWeek,
  formatDateLong,
} from "../utils/date.ts";
import { loadConfig } from "../../config/config.ts";
import {
  buildAccountIdEmailMap,
  searchTicketsForUser,
  refreshJiraTicketsCache,
} from "../services/jira.ts";
import { updateMessageViaResponseUrl, resolveEmailFromSlackId } from "../services/slack.ts";
import {
  aggregateWeeklyHours,
  aggregateWeeklyHoursByComponent,
  aggregateUserHours,
} from "../services/aggregator.ts";
import {
  buildWeeklyMessage,
  buildWeeklyByComponentMessage,
  buildDailyMessage,
  buildHelpMessage,
} from "../builders/message-builder.ts";

/**
 * Handles Slack slash command webhooks.
 * Slack sends a form-urlencoded POST with individual fields (not a `payload` wrapper).
 *
 * Responds immediately with an ephemeral loading message (< 3s Slack limit),
 * then fulfils the request asynchronously via response_url.
 */
export async function handleSlackCommand(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();

  // Verify Slack signature
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  const valid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, signature, timestamp, rawBody);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Parse form body
  const params = new URLSearchParams(rawBody);
  const command = params.get("command");
  const userId = params.get("user_id");
  const responseUrl = params.get("response_url");

  if (!command || !userId || !responseUrl) {
    return new Response("Missing required fields", { status: 400 });
  }

  const payload: SlackCommandPayload = {
    command,
    text: params.get("text") ?? "",
    user_id: userId,
    user_name: params.get("user_name") ?? "",
    team_id: params.get("team_id") ?? "",
    channel_id: params.get("channel_id") ?? "",
    response_url: responseUrl,
    trigger_id: params.get("trigger_id") ?? "",
  };

  // Dispatch by command
  switch (command) {
    case "/summary":
      ctx.waitUntil(processSummaryCommand(payload.user_id, payload.response_url, env));
      return jsonResponse({
        response_type: "ephemeral",
        text: "⏳ Generating your weekly summary...",
      });

    case "/summary-components":
      ctx.waitUntil(processSummaryComponentsCommand(payload.user_id, payload.response_url, env));
      return jsonResponse({
        response_type: "ephemeral",
        text: "⏳ Generating your weekly summary by component...",
      });

    case "/submit": {
      const paramText = payload.text.trim().toLowerCase();
      const validation = validateAndResolveDailySubmissionDate(paramText);
      if ("error" in validation) {
        return jsonResponse({ response_type: "ephemeral", text: validation.error });
      }
      ctx.waitUntil(
        processDailySummaryCommand(
          payload.user_id,
          validation.date,
          validation.label,
          payload.response_url,
          env,
        ),
      );
      return jsonResponse({
        response_type: "ephemeral",
        text: "⏳ Preparing your form...",
      });
    }

    case "/refresh-tickets":
      ctx.waitUntil(processRefreshTicketsCommand(payload.response_url, env));
      return jsonResponse({
        response_type: "ephemeral",
        text: "⏳ Updating tickets...",
      });

    case "/help":
      return jsonResponse({
        response_type: "ephemeral",
        blocks: buildHelpMessage(),
        text: "📖 Help — Hours Bot",
      });

    default:
      return jsonResponse({
        response_type: "ephemeral",
        text: `⚠️ Unknown command: \`${command}\``,
      });
  }
}

// ─── Validation ───

type DailySummaryValidResult = { date: string; label: string };
type DailySummaryErrorResult = { error: string };

/**
 * Validates and resolves the target date for /submit.
 * Rules:
 * - No param + weekend → error
 * - No param + weekday → today
 * - Invalid abbrev → error
 * - Future day within current week → error
 * - Past/today day within current week → resolved date + Spanish label
 */
export function validateAndResolveDailySubmissionDate(
  paramText: string,
): DailySummaryValidResult | DailySummaryErrorResult {
  const todayET = getTodayET();
  const todayDayOfWeek = getDayOfWeekET(todayET);

  if (!paramText) {
    if (todayDayOfWeek > 5) {
      return {
        error:
          "⚠️ Today is a weekend. Use `/submit lun|mar|mie|jue|vie` to log hours for a weekday of the current week.",
      };
    }
    return { date: todayET, label: formatDateLong(todayET) };
  }

  const dayOfWeek = getDayOfWeekFromSpanishAbbrev(paramText);
  if (dayOfWeek === null) {
    return {
      error: `⚠️ Invalid day: \`${paramText}\`. Use one of: \`lun\`, \`mar\`, \`mie\`, \`jue\`, \`vie\`.`,
    };
  }

  const targetDate = getDateForDayOfCurrentWeek(dayOfWeek);

  if (targetDate > todayET) {
    return {
      error: `⚠️ You can't request a future day. \`${paramText}\` falls on *${formatDateLong(targetDate)}*.`,
    };
  }

  return { date: targetDate, label: formatDateLong(targetDate) };
}

// ─── Async processors ───

/**
 * Fetches the user's weekly hour summary from Jira and posts it to the response_url.
 * Runs asynchronously (via ctx.waitUntil) to stay within Slack's 3-second limit.
 */
async function processSummaryCommand(
  slackUserId: string,
  responseUrl: string,
  env: Env,
): Promise<void> {
  try {
    // Resolve user email from Slack ID
    const users = JSON.parse(env.USERS) as JiraUsers;
    const userEmails = Object.keys(users);
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, userEmails);

    if (!userEmail) {
      await sendCommandError(
        responseUrl,
        "⚠️ Could not identify your user. Contact the administrator.",
      );
      return;
    }

    const config = loadConfig();

    // Fetch Jira issues for this user in the current week
    const issues = await searchTicketsForUser(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);

    // Get current week boundaries
    const today = new Date();
    const { monday, friday } = getWeekBoundaries(today);

    // Aggregate weekly hours
    const weeklyMap = aggregateWeeklyHours(issues, accountEmailMap, [userEmail], monday, friday);
    const weeklySummary = weeklyMap.get(userEmail.toLowerCase());

    if (!weeklySummary) {
      await sendCommandError(responseUrl, "⚠️ No hour data found for this week.");
      return;
    }

    // Build and send the weekly summary blocks
    const blocks = buildWeeklyMessage(weeklySummary, config);
    const { monday: weekMonday, friday: weekFriday } = getWeekBoundaries(new Date());

    await updateMessageViaResponseUrl(
      responseUrl,
      blocks,
      `Weekly summary (${weekMonday} – ${weekFriday}): ${weeklySummary.weekTotal.toFixed(1)}h / ${config.tracking.weeklyTarget}h`,
      true,
    );
  } catch (err) {
    console.error("processSummaryCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ An error occurred while fetching your summary. Please try again later.",
    );
  }
}

/**
 * Fetches the user's weekly hours grouped by Jira component and posts to response_url.
 * Runs asynchronously (via ctx.waitUntil) to stay within Slack's 3-second limit.
 */
async function processSummaryComponentsCommand(
  slackUserId: string,
  responseUrl: string,
  env: Env,
): Promise<void> {
  try {
    const users = JSON.parse(env.USERS) as JiraUsers;
    const userEmails = Object.keys(users);
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, userEmails);

    if (!userEmail) {
      await sendCommandError(
        responseUrl,
        "⚠️ Could not identify your user. Contact the administrator.",
      );
      return;
    }

    const config = loadConfig();
    const issues = await searchTicketsForUser(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);

    const { monday, friday } = getWeekBoundaries(new Date());

    const breakdown = aggregateWeeklyHoursByComponent(
      issues,
      accountEmailMap,
      userEmail,
      monday,
      friday,
    );

    const blocks = buildWeeklyByComponentMessage(breakdown, config, monday, friday);

    await updateMessageViaResponseUrl(
      responseUrl,
      blocks,
      `Weekly summary by component (${monday} – ${friday}): ${breakdown.components.length} component(s)`,
      true,
    );
  } catch (err) {
    console.error("processSummaryComponentsCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ An error occurred while fetching your component summary. Please try again later.",
    );
  }
}

/**
 * Fetches the daily hour summary for a specific date and posts it to response_url.
 * Runs asynchronously (via ctx.waitUntil) to stay within Slack's 3-second limit.
 */
async function processDailySummaryCommand(
  slackUserId: string,
  targetDate: string,
  dateLabel: string,
  responseUrl: string,
  env: Env,
): Promise<void> {
  try {
    const users = JSON.parse(env.USERS) as JiraUsers;
    const userEmails = Object.keys(users);
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, userEmails);

    if (!userEmail) {
      await sendCommandError(
        responseUrl,
        "⚠️ Could not identify your user. Contact the administrator.",
      );
      return;
    }

    const config = loadConfig();
    const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;

    const issues = await searchTicketsForUser(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);

    const summaries = aggregateUserHours(issues, accountEmailMap, targetDate, [userEmail]);
    const summary = summaries.get(userEmail.toLowerCase());

    if (!summary) {
      await sendCommandError(responseUrl, "⚠️ No hour data found for this day.");
      return;
    }

    const blocks = buildDailyMessage(
      summary,
      config,
      targetDate,
      jiraConfig,
      undefined,
      undefined,
      dateLabel,
    );

    await updateMessageViaResponseUrl(
      responseUrl,
      blocks,
      `Summary for ${dateLabel}: ${summary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`,
      true,
    );
  } catch (err) {
    console.error("processDailySummaryCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ An error occurred while fetching your daily summary. Please try again later.",
    );
  }
}

async function processRefreshTicketsCommand(responseUrl: string, env: Env): Promise<void> {
  try {
    await refreshJiraTicketsCache(env);

    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: { type: "plain_text", text: "✅ Tickets Updated", emoji: true },
      },
    ];

    await updateMessageViaResponseUrl(responseUrl, blocks, "✅ Tickets Updated", true);
  } catch (err) {
    console.error("processRefreshTicketsCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ An error occurred while updating tickets. Please try again later.",
    );
  }
}

// ─── Helpers ───

function sendCommandError(responseUrl: string, message: string): Promise<void> {
  return updateMessageViaResponseUrl(
    responseUrl,
    [{ type: "section", text: { type: "mrkdwn", text: message } }],
    message.replace(/[*_`]/g, ""),
    true,
  );
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
