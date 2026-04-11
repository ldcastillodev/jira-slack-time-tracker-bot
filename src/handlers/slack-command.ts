import type { Env, JiraUsers, JiraConfig, SlackCommandPayload } from "../types/index.ts";
import { verifySlackSignature } from "../utils/crypto.ts";
import {
  getWeekBoundaries,
  getTodayET,
  getDayOfWeekET,
  getDayOfWeekFromSpanishAbbrev,
  getDateForDayOfCurrentWeek,
  formatDateSpanishLong,
} from "../utils/date.ts";
import { loadConfig } from "../../config/config.ts";
import { searchIssuesWithWorklogs, buildAccountIdEmailMap } from "../services/jira.ts";
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
        text: "⏳ Generando tu resumen semanal...",
      });

    case "/summary-components":
      ctx.waitUntil(processSummaryComponentsCommand(payload.user_id, payload.response_url, env));
      return jsonResponse({
        response_type: "ephemeral",
        text: "⏳ Generando tu resumen semanal por componente...",
      });

    case "/daily-summary": {
      const paramText = payload.text.trim().toLowerCase();
      const validation = validateAndResolveDailySummaryDate(paramText);
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
        text: "⏳ Generando tu resumen diario...",
      });
    }

    default:
      return jsonResponse({
        response_type: "ephemeral",
        text: `⚠️ Comando desconocido: \`${command}\``,
      });
  }
}

// ─── Validation ───

type DailySummaryValidResult = { date: string; label: string };
type DailySummaryErrorResult = { error: string };

/**
 * Validates and resolves the target date for /daily-summary.
 * Rules:
 * - No param + weekend → error
 * - No param + weekday → today
 * - Invalid abbrev → error
 * - Future day within current week → error
 * - Past/today day within current week → resolved date + Spanish label
 */
export function validateAndResolveDailySummaryDate(
  paramText: string,
): DailySummaryValidResult | DailySummaryErrorResult {
  const todayET = getTodayET();
  const todayDayOfWeek = getDayOfWeekET(todayET);

  if (!paramText) {
    if (todayDayOfWeek > 5) {
      return {
        error:
          "⚠️ Hoy es fin de semana. Usa `/daily-summary lun|mar|mie|jue|vie` para consultar un día de la semana en curso.",
      };
    }
    return { date: todayET, label: formatDateSpanishLong(todayET) };
  }

  const dayOfWeek = getDayOfWeekFromSpanishAbbrev(paramText);
  if (dayOfWeek === null) {
    return {
      error: `⚠️ Día inválido: \`${paramText}\`. Usa uno de: \`lun\`, \`mar\`, \`mie\`, \`jue\`, \`vie\`.`,
    };
  }

  const targetDate = getDateForDayOfCurrentWeek(dayOfWeek);

  if (targetDate > todayET) {
    return {
      error: `⚠️ No puedes consultar días futuros. \`${paramText}\` corresponde al *${formatDateSpanishLong(targetDate)}*.`,
    };
  }

  return { date: targetDate, label: formatDateSpanishLong(targetDate) };
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
        "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
      );
      return;
    }

    const config = loadConfig();

    // Fetch Jira issues for this user in the current week
    const issues = await searchIssuesWithWorklogs(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);

    // Get current week boundaries
    const today = new Date();
    const { monday, friday } = getWeekBoundaries(today);

    // Aggregate weekly hours
    const weeklyMap = aggregateWeeklyHours(issues, accountEmailMap, [userEmail], monday, friday);
    const weeklySummary = weeklyMap.get(userEmail.toLowerCase());

    if (!weeklySummary) {
      await sendCommandError(responseUrl, "⚠️ No se encontraron datos de horas para esta semana.");
      return;
    }

    // Build and send the weekly summary blocks
    const blocks = buildWeeklyMessage(weeklySummary, config);
    const { monday: weekMonday, friday: weekFriday } = getWeekBoundaries(new Date());

    await updateMessageViaResponseUrl(
      responseUrl,
      blocks,
      `Resumen semanal (${weekMonday} – ${weekFriday}): ${weeklySummary.weekTotal.toFixed(1)}h / ${config.tracking.weeklyTarget}h`,
      true,
    );
  } catch (err) {
    console.error("processSummaryCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ Ocurrió un error al obtener tu resumen. Por favor intenta de nuevo más tarde.",
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
        "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
      );
      return;
    }

    const config = loadConfig();
    const issues = await searchIssuesWithWorklogs(env, userEmail);
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
      `Resumen semanal por componente (${monday} – ${friday}): ${breakdown.components.length} componente(s)`,
      true,
    );
  } catch (err) {
    console.error("processSummaryComponentsCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ Ocurrió un error al obtener tu resumen por componente. Por favor intenta de nuevo más tarde.",
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
        "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
      );
      return;
    }

    const config = loadConfig();
    const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;

    const issues = await searchIssuesWithWorklogs(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);

    const summaries = aggregateUserHours(issues, accountEmailMap, targetDate, [userEmail]);
    const summary = summaries.get(userEmail.toLowerCase());

    if (!summary) {
      await sendCommandError(responseUrl, "⚠️ No se encontraron datos de horas para este día.");
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
      `Resumen del ${dateLabel}: ${summary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`,
      true,
    );
  } catch (err) {
    console.error("processDailySummaryCommand error:", err);
    await sendCommandError(
      responseUrl,
      "❌ Ocurrió un error al obtener tu resumen diario. Por favor intenta de nuevo más tarde.",
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
