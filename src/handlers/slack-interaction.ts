import type {
  Env,
  JiraConfig,
  JiraUsers,
  SlackInteractionPayload,
  SlotEntry,
  ExistingSelection,
} from "../types/index.ts";
import { verifySlackSignature } from "../utils/crypto.ts";
import { getTodayET, isSameCalendarWeek } from "../utils/date.ts";
import { loadConfig } from "../config.ts";
import { searchIssuesWithWorklogs, buildAccountIdEmailMap, postWorklog } from "../services/jira.ts";
import {
  sendDirectMessage,
  updateMessageViaResponseUrl,
  resolveEmailFromSlackId,
} from "../services/slack.ts";
import { aggregateUserHours } from "../services/aggregator.ts";
import { buildConfirmationMessage, buildDailyMessage } from "../builders/message-builder.ts";

/**
 * Handles Slack interactive component webhooks.
 * Slack sends a form-urlencoded POST with a `payload` field containing JSON.
 */
export async function handleSlackInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
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

  const actionId = action.action_id;

  // No-op for slot selectors (Slack preserves UI state)
  if (actionId.startsWith("select_ticket_") || actionId.startsWith("select_hours_")) {
    return new Response("", { status: 200 });
  }

  if (actionId === "submit_hours") {
    // Process async to respond within 3 seconds
    ctx.waitUntil(processSubmitHours(payload, env));
    return new Response("", { status: 200 });
  }

  if (actionId === "add_slot") {
    // Process async to respond within 3 seconds
    ctx.waitUntil(processAddSlot(payload, env));
    return new Response("", { status: 200 });
  }

  console.log(`Unknown action_id: ${actionId}`);
  return new Response("", { status: 200 });
}

/**
 * Processes the "submit_hours" action with multi-slot support:
 * 1. Parses targetDate from submit button value
 * 2. Validates week-boundary (same ISO calendar week)
 * 3. Parses 3 slots from state, rejects partial data
 * 4. Validates no duplicate tickets, sum within limits
 * 5. Re-validates current hours from Jira (stale-data guard)
 * 6. Posts worklogs to Jira
 * 7. Sends updated confirmation via response_url
 */
async function processSubmitHours(payload: SlackInteractionPayload, env: Env): Promise<void> {
  const config = loadConfig();
  const responseUrl = payload.response_url;

  try {
    // ── 1. Parse targetDate from button value ──
    const action = payload.actions?.[0];
    const targetDate = action?.value;
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      await sendError(responseUrl, "⚠️ Fecha objetivo inválida. Por favor intenta de nuevo.");
      return;
    }

    // ── 2. Week-boundary check ──
    const currentDateET = getTodayET();
    if (!isSameCalendarWeek(currentDateET, targetDate)) {
      await updateMessageViaResponseUrl(
        responseUrl,
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `⛔ *Período expirado.* Este mensaje era para el *${targetDate}* y ya no pertenece a la semana calendario actual.\nLas horas deben cargarse directamente en Jira.`,
            },
          },
        ],
        `Período expirado. Este mensaje era para el ${targetDate}.`,
        true,
      );
      return;
    }

    // ── 3. Parse slots dynamically from state ──
    const state = payload.state?.values;
    if (!state) {
      await sendError(responseUrl, "No se encontraron selecciones. Por favor intenta de nuevo.");
      return;
    }

    const validSlots: SlotEntry[] = [];
    const partialSlots: number[] = [];

    let i = 0;
    while (state[`ticket_block_${i}`] || state[`hours_block_${i}`]) {
      const ticketSel = state[`ticket_block_${i}`]?.[`select_ticket_${i}`]?.selected_option;
      const hoursSel = state[`hours_block_${i}`]?.[`select_hours_${i}`]?.selected_option;

      const hasTicket = !!ticketSel;
      const hasHours = !!hoursSel;

      if (hasTicket && hasHours) {
        const ticketKey = ticketSel!.value;
        const hours = parseFloat(hoursSel!.value);
        if (ticketKey === "none" || isNaN(hours) || hours <= 0) {
          await sendError(
            responseUrl,
            `⚠️ Ranura ${i + 1}: selección inválida. Por favor revisa y vuelve a intentar.`,
          );
          return;
        }
        validSlots.push({ ticketKey, hours });
      } else if (hasTicket || hasHours) {
        partialSlots.push(i + 1); // 1-based for display
      }
      // both empty → skip silently
      i++;
    }

    // ── 4. Reject partial data ──
    if (partialSlots.length > 0) {
      const slotList = partialSlots.join(", ");
      await sendError(
        responseUrl,
        `⚠️ La(s) ranura(s) *${slotList}* tiene(n) datos incompletos. Debes seleccionar *ticket y horas* en cada ranura que uses, o dejar ambas vacías.`,
      );
      return;
    }

    // ── 5. At least one valid slot ──
    if (validSlots.length === 0) {
      await sendError(
        responseUrl,
        "⚠️ No seleccionaste ningún ticket ni horas. Completa al menos una ranura.",
      );
      return;
    }

    // ── 6. Duplicate ticket check ──
    const ticketKeys = validSlots.map((s) => s.ticketKey);
    const uniqueKeys = new Set(ticketKeys);
    if (uniqueKeys.size !== ticketKeys.length) {
      await sendError(
        responseUrl,
        "⚠️ No puedes seleccionar el mismo ticket en más de una ranura.",
      );
      return;
    }

    // ── 7. Pre-check: submitted total vs daily target ──
    const submittedTotal = validSlots.reduce((sum, s) => sum + s.hours, 0);
    if (submittedTotal > config.tracking.dailyTarget) {
      await sendError(
        responseUrl,
        `⚠️ El total enviado (*${submittedTotal.toFixed(1)}h*) supera el límite diario de ${config.tracking.dailyTarget}h.`,
      );
      return;
    }

    // ── 8. Resolve user email ──
    const slackUserId = payload.user.id;
    const users = JSON.parse(env.USERS) as JiraUsers;
    const userEmails = Object.keys(users);
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, userEmails);
    if (!userEmail) {
      await sendError(
        responseUrl,
        "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
      );
      return;
    }

    // ── 9. Fetch fresh Jira data (stale-data guard) ──
    const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
    const issues = await searchIssuesWithWorklogs(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);
    const summaries = aggregateUserHours(issues, accountEmailMap, targetDate, [userEmail]);
    const currentSummary = summaries.get(userEmail.toLowerCase());
    const currentTotal = currentSummary?.totalHours ?? 0;

    if (currentTotal + submittedTotal > config.tracking.dailyTarget) {
      const remaining = Math.max(0, config.tracking.dailyTarget - currentTotal);

      // Build a fresh updated message showing real balance
      const freshSummary = currentSummary ?? {
        email: userEmail,
        displayName: userEmail.split("@")[0],
        totalHours: currentTotal,
        workedTickets: [],
        ticketKeys: [],
      };
      const freshBlocks = buildDailyMessage(freshSummary, config, targetDate, jiraConfig);

      // Prepend stale-data warning
      const warningBlock = {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `⚠️ *Datos desactualizados.* Ya tienes *${currentTotal.toFixed(1)}h* cargadas para el ${targetDate}. Solo puedes agregar *${remaining.toFixed(1)}h* más.\n_Se ha actualizado el mensaje con tu saldo real._`,
        },
      };

      await updateMessageViaResponseUrl(
        responseUrl,
        [warningBlock, { type: "divider" }, ...freshBlocks],
        `Datos desactualizados. Ya tienes ${currentTotal.toFixed(1)}h. Solo puedes agregar ${remaining.toFixed(1)}h más.`,
        true,
      );
      return;
    }

    // ── 10. Post worklogs to Jira ──
    const failed: string[] = [];
    const succeeded: { ticketKey: string; hours: number }[] = [];

    for (const slot of validSlots) {
      const timeSpentSeconds = slot.hours * 3600;
      const ok = await postWorklog(env, slot.ticketKey, targetDate, timeSpentSeconds, userEmail);
      if (ok) {
        succeeded.push(slot);
      } else {
        failed.push(slot.ticketKey);
      }
    }

    if (succeeded.length === 0) {
      await sendError(
        responseUrl,
        "❌ Error al cargar horas en Jira. Por favor intenta de nuevo o carga manualmente.",
      );
      return;
    }

    // ── 11. Build confirmation ──
    const updatedIssues = await searchIssuesWithWorklogs(env, userEmail);
    const updatedAccountMap = await buildAccountIdEmailMap(env, updatedIssues);
    const updatedSummaries = aggregateUserHours(updatedIssues, updatedAccountMap, targetDate, [
      userEmail,
    ]);
    const updatedSummary = updatedSummaries.get(userEmail.toLowerCase());

    if (!updatedSummary) {
      await sendError(responseUrl, "✅ Horas cargadas, pero no se pudo actualizar el resumen.");
      return;
    }

    const confirmBlocks = buildConfirmationMessage(
      succeeded,
      updatedSummary,
      config.tracking.dailyTarget,
    );

    // If some slots failed, append a warning
    if (failed.length > 0) {
      confirmBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ No se pudieron cargar horas en: ${failed.map((k) => `\`${k}\``).join(", ")}. Cárgalas manualmente en Jira.`,
        },
      });
    }

    if (updatedSummary.totalHours < config.tracking.dailyTarget) {
      const followUpBlocks = buildDailyMessage(updatedSummary, config, targetDate, jiraConfig);
      const followUpText = `Te faltan ${(config.tracking.dailyTarget - updatedSummary.totalHours).toFixed(1)}h para completar tu día.`;
      const followUpSent = await sendDirectMessage(env, slackUserId, followUpBlocks, followUpText);

      if (!followUpSent) {
        confirmBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "⚠️ No se pudo enviar el nuevo mensaje para seguir cargando horas.",
          },
        });
      }
    }

    const totalAdded = succeeded.reduce((s, e) => s + e.hours, 0);
    await updateMessageViaResponseUrl(
      responseUrl,
      confirmBlocks,
      `✅ ${totalAdded.toFixed(1)}h cargadas en ${succeeded.length} ticket(s). Total: ${updatedSummary.totalHours.toFixed(1)}h`,
      true,
    );
  } catch (err) {
    console.error("Error processing submit_hours:", err);
    await sendError(responseUrl, "❌ Ocurrió un error inesperado. Por favor intenta de nuevo.");
  }
}

/**
 * Processes the "add_slot" action:
 * 1. Parses current slot count and targetDate from button value
 * 2. Extracts existing selections from state
 * 3. Rebuilds the message with one additional slot, preserving selections
 */
async function processAddSlot(payload: SlackInteractionPayload, env: Env): Promise<void> {
  const config = loadConfig();
  const responseUrl = payload.response_url;

  try {
    const action = payload.actions?.[0];
    const buttonValue = action?.value ?? "";
    const [slotCountStr, targetDate] = buttonValue.split(":");

    const currentSlotCount = parseInt(slotCountStr, 10);
    if (isNaN(currentSlotCount) || !targetDate) {
      await sendError(responseUrl, "⚠️ Error al agregar ranura. Por favor intenta de nuevo.");
      return;
    }

    // Extract existing selections from state
    const state = payload.state?.values;
    const existingSelections: ExistingSelection[] = [];

    for (let i = 0; i < currentSlotCount; i++) {
      const ticketOption = state?.[`ticket_block_${i}`]?.[`select_ticket_${i}`]?.selected_option;
      const hoursOption = state?.[`hours_block_${i}`]?.[`select_hours_${i}`]?.selected_option;
      existingSelections.push({
        ticketOption: ticketOption ?? undefined,
        hoursOption: hoursOption ?? undefined,
      });
    }

    // Resolve user to get fresh summary
    const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;
    const users = JSON.parse(env.USERS) as JiraUsers;
    const userEmails = Object.keys(users);
    const slackUserId = payload.user.id;
    const userEmail = await resolveEmailFromSlackId(env, slackUserId, userEmails);

    if (!userEmail) {
      await sendError(
        responseUrl,
        "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
      );
      return;
    }

    // Fetch fresh data for the user
    const issues = await searchIssuesWithWorklogs(env, userEmail);
    const accountEmailMap = await buildAccountIdEmailMap(env, issues);
    const summaries = aggregateUserHours(issues, accountEmailMap, targetDate, [userEmail]);
    const summary = summaries.get(userEmail.toLowerCase());

    if (!summary) {
      await sendError(responseUrl, "⚠️ No se encontraron datos. Intenta de nuevo.");
      return;
    }

    // Build message with one more slot
    const newSlotCount = currentSlotCount + 1;
    const freshBlocks = buildDailyMessage(
      summary,
      config,
      targetDate,
      jiraConfig,
      newSlotCount,
      existingSelections,
    );

    await updateMessageViaResponseUrl(
      responseUrl,
      freshBlocks,
      `Agregada ranura ${newSlotCount}. Total: ${summary.totalHours.toFixed(1)}h`,
      true,
    );
  } catch (err) {
    console.error("Error processing add_slot:", err);
    await sendError(
      responseUrl,
      "❌ Ocurrió un error al agregar la ranura. Por favor intenta de nuevo.",
    );
  }
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
    message.replace(/[*_`]/g, ""),
    false,
  );
}
