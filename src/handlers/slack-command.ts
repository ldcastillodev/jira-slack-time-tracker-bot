import type { Env, JiraUsers, SlackCommandPayload } from "../types/index.ts";
import { verifySlackSignature } from "../utils/crypto.ts";
import { getWeekBoundaries } from "../utils/date.ts";
import { loadConfig } from "../config.ts";
import { searchIssuesWithWorklogs, buildAccountIdEmailMap } from "../services/jira.ts";
import { updateMessageViaResponseUrl, resolveEmailFromSlackId } from "../services/slack.ts";
import { aggregateWeeklyHours } from "../services/aggregator.ts";
import { buildWeeklyMessage } from "../builders/message-builder.ts";

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

    default:
      return jsonResponse({
        response_type: "ephemeral",
        text: `⚠️ Comando desconocido: \`${command}\``,
      });
  }
}

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
