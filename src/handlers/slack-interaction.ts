import type { Env, SlackInteractionPayload } from "../types/index.ts";
import { verifySlackSignature } from "../utils/crypto.ts";
import { getTodayET } from "../utils/date.ts";
import { loadConfig } from "../config.ts";
import {
  searchIssuesWithWorklogs,
  buildAccountIdEmailMap,
  postWorklog,
} from "../services/jira.ts";
import { updateMessageViaResponseUrl } from "../services/slack.ts";
import { aggregateUserHours } from "../services/aggregator.ts";
import { buildConfirmationMessage } from "../builders/message-builder.ts";

/**
 * Handles Slack interactive component webhooks.
 * Slack sends a form-urlencoded POST with a `payload` field containing JSON.
 */
export async function handleSlackInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Read raw body for signature verification
  const rawBody = await request.text();

  // Verify Slack signature
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  const valid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, signature, timestamp, rawBody);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Parse the payload
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return new Response("Missing payload", { status: 400 });
  }

  const payload: SlackInteractionPayload = JSON.parse(payloadStr);

  // Route by action
  const action = payload.actions?.[0];
  if (!action) {
    return new Response("OK", { status: 200 });
  }

  switch (action.action_id) {
    case "select_ticket":
    case "select_hours":
      // No-op: Slack preserves the selection state in the message.
      return new Response("", { status: 200 });

    case "submit_hours":
      // Process async to respond within 3 seconds
      ctx.waitUntil(processSubmitHours(payload, env));
      return new Response("", { status: 200 });

    default:
      console.log(`Unknown action_id: ${action.action_id}`);
      return new Response("", { status: 200 });
  }
}

/**
 * Processes the "submit_hours" action:
 * 1. Extracts ticket + hours from state
 * 2. Re-validates current hours from Jira (server-side)
 * 3. Posts worklog to Jira
 * 4. Sends updated message via response_url
 */
async function processSubmitHours(
  payload: SlackInteractionPayload,
  env: Env
): Promise<void> {
  const config = loadConfig();
  const responseUrl = payload.response_url;

  try {
    // Extract selections from Slack state
    const state = payload.state?.values;
    if (!state) {
      await sendError(responseUrl, "No se encontraron selecciones. Por favor intenta de nuevo.");
      return;
    }

    const ticketSelection = state["ticket_block"]?.["select_ticket"]?.selected_option;
    const hoursSelection = state["hours_block"]?.["select_hours"]?.selected_option;

    if (!ticketSelection || !hoursSelection) {
      await sendError(responseUrl, "⚠️ Debes seleccionar un ticket y las horas antes de enviar.");
      return;
    }

    const ticketKey = ticketSelection.value;
    const hoursToAdd = parseFloat(hoursSelection.value);

    if (ticketKey === "none" || isNaN(hoursToAdd) || hoursToAdd <= 0) {
      await sendError(responseUrl, "⚠️ Selección inválida. Por favor intenta de nuevo.");
      return;
    }

    // Resolve the user's email from Slack user ID
    // We need to find which configured user this Slack user is
    const slackUserId = payload.user.id;
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, config.users);
    if (!userEmail) {
      await sendError(responseUrl, "⚠️ No se pudo identificar tu usuario. Contacta al administrador.");
      return;
    }

    // Server-side re-validation: fetch current hours from Jira
    const today = getTodayET();
    const issues = await searchIssuesWithWorklogs(env, config.jira.boards, today, today);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);
    const summaries = aggregateUserHours(issues, accountEmailMap, [userEmail], today);
    const currentSummary = summaries.get(userEmail.toLowerCase());
    const currentTotal = currentSummary?.totalHours ?? 0;

    // Validate: would this exceed the daily target?
    if (currentTotal + hoursToAdd > config.tracking.dailyTarget) {
      const remaining = Math.max(0, config.tracking.dailyTarget - currentTotal);
      await sendError(
        responseUrl,
        `⚠️ No se puede cargar *${hoursToAdd.toFixed(1)}h* porque ya tienes *${currentTotal.toFixed(1)}h* hoy.\n` +
          `Solo puedes cargar hasta *${remaining.toFixed(1)}h* más.`
      );
      return;
    }

    // Post worklog to Jira
    const timeSpentSeconds = hoursToAdd * 3600;
    const success = await postWorklog(env, ticketKey, today, timeSpentSeconds);

    if (!success) {
      await sendError(responseUrl, "❌ Error al cargar horas en Jira. Por favor intenta de nuevo o carga manualmente.");
      return;
    }

    // Re-fetch updated hours for the confirmation message
    const updatedIssues = await searchIssuesWithWorklogs(env, config.jira.boards, today, today);
    const updatedAccountMap = await buildAccountIdEmailMap(env, updatedIssues);
    const updatedSummaries = aggregateUserHours(updatedIssues, updatedAccountMap, [userEmail], today);
    const updatedSummary = updatedSummaries.get(userEmail.toLowerCase());

    if (!updatedSummary) {
      await sendError(responseUrl, "✅ Horas cargadas, pero no se pudo actualizar el resumen.");
      return;
    }

    // Build and send confirmation message
    const confirmBlocks = buildConfirmationMessage(
      ticketKey,
      hoursToAdd,
      updatedSummary,
      config.tracking.dailyTarget
    );

    await updateMessageViaResponseUrl(
      responseUrl,
      confirmBlocks,
      `✅ ${hoursToAdd.toFixed(1)}h cargadas en ${ticketKey}. Total: ${updatedSummary.totalHours.toFixed(1)}h`
    );
  } catch (err) {
    console.error("Error processing submit_hours:", err);
    await sendError(responseUrl, "❌ Ocurrió un error inesperado. Por favor intenta de nuevo.");
  }
}

/**
 * Resolves a configured user's email from their Slack user ID.
 * Checks the KV cache for reverse mappings.
 */
async function resolveEmailFromSlackId(
  env: Env,
  slackUserId: string,
  configuredEmails: string[]
): Promise<string | null> {
  // Check KV cache for each email → slackId mapping
  for (const email of configuredEmails) {
    const cached = await env.CACHE.get(`slack_user:${email}`);
    if (cached === slackUserId) {
      return email;
    }
  }
  return null;
}

async function sendError(responseUrl: string, message: string): Promise<void> {
  await updateMessageViaResponseUrl(
    responseUrl,
    [
      {
        type: "section",
        text: { type: "mrkdwn", text: message },
      },
    ],
    message.replace(/[*_`]/g, "")
  );
}
