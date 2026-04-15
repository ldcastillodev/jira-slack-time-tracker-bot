import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../../context/request-context.service.ts";
import { runInContext } from "../../context/async-local-storage.ts";
import { ConfigService } from "../../config/config.service.ts";
import { JiraService } from "../../jira/jira.service.ts";
import { SlackService } from "../slack.service.ts";
import { AggregatorService } from "../../aggregator/aggregator.service.ts";
import { MessageBuilderService } from "../../builders/message-builder.service.ts";
import { verifySlackSignature } from "../../common/utils/crypto.ts";
import { getTodayET, isSameCalendarWeek } from "../../common/utils/date.ts";
import type {
  SlackInteractionPayload,
  SlotEntry,
  ExistingSelection,
} from "../../common/types/index.ts";

@Injectable()
export class SlackInteractionHandler {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly configService: ConfigService,
    private readonly jiraService: JiraService,
    private readonly slackService: SlackService,
    private readonly aggregatorService: AggregatorService,
    private readonly messageBuilderService: MessageBuilderService,
  ) {}

  async handleSlackInteraction(request: Request): Promise<Response> {
    const env = this.requestContext.env;
    const ctx = this.requestContext.ctx;
    const rawBody = await request.text();

    const signature = request.headers.get("x-slack-signature") ?? "";
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

    const valid = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      signature,
      timestamp,
      rawBody,
    );
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get("payload");
    if (!payloadStr) {
      return new Response("Missing payload", { status: 400 });
    }

    const payload: SlackInteractionPayload = JSON.parse(payloadStr);

    const action = payload.actions?.[0];
    if (!action) {
      return new Response("OK", { status: 200 });
    }

    const actionId = action.action_id;

    if (actionId.startsWith("select_ticket_") || actionId.startsWith("select_hours_")) {
      return new Response("", { status: 200 });
    }

    if (actionId === "submit_hours") {
      ctx.waitUntil(runInContext(env, ctx, () => this.processSubmitHours(payload)));
      return new Response(
        JSON.stringify({
          replace_original: true,
          text: "⏳ Procesando carga de horas...",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "⏳ *Procesando carga de horas...* Por favor espera.",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (actionId === "add_slot") {
      ctx.waitUntil(runInContext(env, ctx, () => this.processAddSlot(payload)));
      return new Response("", { status: 200 });
    }

    console.log(`Unknown action_id: ${actionId}`);
    return new Response("", { status: 200 });
  }

  private async processSubmitHours(payload: SlackInteractionPayload): Promise<void> {
    const config = this.configService.config;
    const responseUrl = payload.response_url;

    try {
      // ── 1. Parse targetDate from button value ──
      const action = payload.actions?.[0];
      const targetDate = action?.value;
      if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        await this.sendError(
          responseUrl,
          "⚠️ Fecha objetivo inválida. Por favor intenta de nuevo.",
        );
        return;
      }

      // ── 2. Week-boundary check ──
      const currentDateET = getTodayET();
      if (!isSameCalendarWeek(currentDateET, targetDate)) {
        await this.slackService.updateMessageViaResponseUrl(
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
        await this.sendError(
          responseUrl,
          "No se encontraron selecciones. Por favor intenta de nuevo.",
        );
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
            await this.sendError(
              responseUrl,
              `⚠️ Ranura ${i + 1}: selección inválida. Por favor revisa y vuelve a intentar.`,
            );
            return;
          }
          validSlots.push({ ticketKey, hours });
        } else if (hasTicket || hasHours) {
          partialSlots.push(i + 1);
        }
        i++;
      }

      // ── 4. Reject partial data ──
      if (partialSlots.length > 0) {
        const slotList = partialSlots.join(", ");
        await this.sendError(
          responseUrl,
          `⚠️ La(s) ranura(s) *${slotList}* tiene(n) datos incompletos. Debes seleccionar *ticket y horas* en cada ranura que uses, o dejar ambas vacías.`,
        );
        return;
      }

      // ── 5. At least one valid slot ──
      if (validSlots.length === 0) {
        await this.sendError(
          responseUrl,
          "⚠️ No seleccionaste ningún ticket ni horas. Completa al menos una ranura.",
        );
        return;
      }

      // ── 6. Duplicate ticket check ──
      const ticketKeys = validSlots.map((s) => s.ticketKey);
      const uniqueKeys = new Set(ticketKeys);
      if (uniqueKeys.size !== ticketKeys.length) {
        await this.sendError(
          responseUrl,
          "⚠️ No puedes seleccionar el mismo ticket en más de una ranura.",
        );
        return;
      }

      // ── 7. Pre-check: submitted total vs daily target ──
      const submittedTotal = validSlots.reduce((sum, s) => sum + s.hours, 0);
      if (submittedTotal > config.tracking.dailyTarget) {
        await this.sendError(
          responseUrl,
          `⚠️ El total enviado (*${submittedTotal.toFixed(1)}h*) supera el límite diario de ${config.tracking.dailyTarget}h.`,
        );
        return;
      }

      // ── 8. Resolve user email ──
      const slackUserId = payload.user.id;
      const userEmails = this.configService.userEmails;
      const userEmail = await this.slackService.resolveEmailFromSlackId(slackUserId, userEmails);
      if (!userEmail) {
        await this.sendError(
          responseUrl,
          "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
        );
        return;
      }

      // ── 9. Fetch fresh Jira data (stale-data guard) ──
      const jiraConfig = this.configService.jiraConfig;
      const issues = await this.jiraService.searchTicketsForUser(userEmail);
      const accountEmailMap = await this.jiraService.buildAccountIdEmailMap(issues);
      const summaries = this.aggregatorService.aggregateUserHours(
        issues,
        accountEmailMap,
        targetDate,
        [userEmail],
      );
      const currentSummary = summaries.get(userEmail.toLowerCase());
      const currentTotal = currentSummary?.totalHours ?? 0;

      if (currentTotal + submittedTotal > config.tracking.dailyTarget) {
        const remaining = Math.max(0, config.tracking.dailyTarget - currentTotal);

        const freshSummary = currentSummary ?? {
          email: userEmail,
          displayName: userEmail.split("@")[0],
          totalHours: currentTotal,
          workedTickets: [],
          ticketKeys: [],
        };
        const freshBlocks = this.messageBuilderService.buildDailyMessage(
          freshSummary,
          config,
          targetDate,
          jiraConfig,
        );

        const warningBlock = {
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `⚠️ *Datos desactualizados.* Ya tienes *${currentTotal.toFixed(1)}h* cargadas para el ${targetDate}. Solo puedes agregar *${remaining.toFixed(1)}h* más.\n_Se ha actualizado el mensaje con tu saldo real._`,
          },
        };

        await this.slackService.updateMessageViaResponseUrl(
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
        const ok = await this.jiraService.postWorklog(
          slot.ticketKey,
          targetDate,
          timeSpentSeconds,
          userEmail,
        );
        if (ok) {
          succeeded.push(slot);
        } else {
          failed.push(slot.ticketKey);
        }
      }

      if (succeeded.length === 0) {
        await this.sendError(
          responseUrl,
          "❌ Error al cargar horas en Jira. Por favor intenta de nuevo o carga manualmente.",
        );
        return;
      }

      // ── 11. Structured audit log ──
      console.log(
        JSON.stringify({
          event: "worklog_submitted",
          user: userEmail,
          date: targetDate,
          tickets: succeeded.map((s) => ({ key: s.ticketKey, hours: s.hours })),
          failedTickets: failed,
          totalHoursSubmitted: succeeded.reduce((sum, s) => sum + s.hours, 0),
          timestamp: new Date().toISOString(),
        }),
      );

      // ── 13. Build confirmation ──
      const updatedIssues = await this.jiraService.searchTicketsForUser(userEmail);
      const updatedAccountMap = await this.jiraService.buildAccountIdEmailMap(updatedIssues);
      const updatedSummaries = this.aggregatorService.aggregateUserHours(
        updatedIssues,
        updatedAccountMap,
        targetDate,
        [userEmail],
      );
      const updatedSummary = updatedSummaries.get(userEmail.toLowerCase());

      if (!updatedSummary) {
        await this.sendError(
          responseUrl,
          "✅ Horas cargadas, pero no se pudo actualizar el resumen.",
        );
        return;
      }

      const confirmBlocks = this.messageBuilderService.buildConfirmationMessage(
        succeeded,
        updatedSummary,
        config.tracking.dailyTarget,
      );

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
        const followUpBlocks = this.messageBuilderService.buildDailyMessage(
          updatedSummary,
          config,
          targetDate,
          jiraConfig,
        );
        const followUpText = `Te faltan ${(config.tracking.dailyTarget - updatedSummary.totalHours).toFixed(1)}h para completar tu día.`;
        const followUpSent = await this.slackService.sendDirectMessage(
          slackUserId,
          followUpBlocks,
          followUpText,
        );

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
      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        confirmBlocks,
        `✅ ${totalAdded.toFixed(1)}h cargadas en ${succeeded.length} ticket(s). Total: ${updatedSummary.totalHours.toFixed(1)}h`,
        true,
      );
    } catch (err) {
      console.error("Error processing submit_hours:", err);
      await this.sendError(
        responseUrl,
        "❌ Ocurrió un error inesperado. Por favor intenta de nuevo.",
      );
    }
  }

  private async processAddSlot(payload: SlackInteractionPayload): Promise<void> {
    const config = this.configService.config;
    const responseUrl = payload.response_url;

    try {
      const action = payload.actions?.[0];
      const buttonValue = action?.value ?? "";
      const [slotCountStr, targetDate] = buttonValue.split(":");

      const currentSlotCount = parseInt(slotCountStr, 10);
      if (isNaN(currentSlotCount) || !targetDate) {
        await this.sendError(
          responseUrl,
          "⚠️ Error al agregar ranura. Por favor intenta de nuevo.",
        );
        return;
      }

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

      const jiraConfig = this.configService.jiraConfig;
      const userEmails = this.configService.userEmails;
      const slackUserId = payload.user.id;
      const userEmail = await this.slackService.resolveEmailFromSlackId(slackUserId, userEmails);

      if (!userEmail) {
        await this.sendError(
          responseUrl,
          "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
        );
        return;
      }

      const issues = await this.jiraService.searchTicketsForUser(userEmail);
      const accountEmailMap = await this.jiraService.buildAccountIdEmailMap(issues);
      const summaries = this.aggregatorService.aggregateUserHours(
        issues,
        accountEmailMap,
        targetDate,
        [userEmail],
      );
      const summary = summaries.get(userEmail.toLowerCase());

      if (!summary) {
        await this.sendError(responseUrl, "⚠️ No se encontraron datos. Intenta de nuevo.");
        return;
      }

      const newSlotCount = currentSlotCount + 1;
      const freshBlocks = this.messageBuilderService.buildDailyMessage(
        summary,
        config,
        targetDate,
        jiraConfig,
        newSlotCount,
        existingSelections,
      );

      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        freshBlocks,
        `Agregada ranura ${newSlotCount}. Total: ${summary.totalHours.toFixed(1)}h`,
        true,
      );
    } catch (err) {
      console.error("Error processing add_slot:", err);
      await this.sendError(
        responseUrl,
        "❌ Ocurrió un error al agregar la ranura. Por favor intenta de nuevo.",
      );
    }
  }

  private async sendError(responseUrl: string, message: string): Promise<void> {
    await this.slackService.updateMessageViaResponseUrl(
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
}
