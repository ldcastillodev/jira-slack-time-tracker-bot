import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../../context/request-context.service.ts";
import { runInContext } from "../../context/async-local-storage.ts";
import { ConfigService } from "../../config/config.service.ts";
import { JiraService } from "../../jira/jira.service.ts";
import { SlackService } from "../slack.service.ts";
import { AggregatorService } from "../../aggregator/aggregator.service.ts";
import { MessageBuilderService } from "../../builders/message-builder.service.ts";
import { verifySlackSignature } from "../../common/utils/crypto.ts";
import {
  getWeekBoundaries,
  getTodayET,
  getDayOfWeekET,
  getDayOfWeekFromSpanishAbbrev,
  getDateForDayOfCurrentWeek,
  formatDateSpanishLong,
} from "../../common/utils/date.ts";
import type { SlackCommandPayload, SlackBlock } from "../../common/types/index.ts";

type DailySummaryValidResult = { date: string; label: string };
type DailySummaryErrorResult = { error: string };

@Injectable()
export class SlackCommandHandler {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly configService: ConfigService,
    private readonly jiraService: JiraService,
    private readonly slackService: SlackService,
    private readonly aggregatorService: AggregatorService,
    private readonly messageBuilderService: MessageBuilderService,
  ) {}

  async handleSlackCommand(request: Request): Promise<Response> {
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

    switch (command) {
      case "/summary":
        ctx.waitUntil(
          runInContext(env, ctx, () =>
            this.processSummaryCommand(payload.user_id, payload.response_url),
          ),
        );
        return this.jsonResponse({
          response_type: "ephemeral",
          text: "⏳ Generando tu resumen semanal...",
        });

      case "/summary-components":
        ctx.waitUntil(
          runInContext(env, ctx, () =>
            this.processSummaryComponentsCommand(payload.user_id, payload.response_url),
          ),
        );
        return this.jsonResponse({
          response_type: "ephemeral",
          text: "⏳ Generando tu resumen semanal por componente...",
        });

      case "/submit": {
        const paramText = payload.text.trim().toLowerCase();
        const validation = this.validateAndResolveDailySubmissionDate(paramText);
        if ("error" in validation) {
          return this.jsonResponse({ response_type: "ephemeral", text: validation.error });
        }
        ctx.waitUntil(
          runInContext(env, ctx, () =>
            this.processDailySummaryCommand(
              payload.user_id,
              validation.date,
              validation.label,
              payload.response_url,
            ),
          ),
        );
        return this.jsonResponse({
          response_type: "ephemeral",
          text: "⏳ preparando tu formulario...",
        });
      }

      case "/refresh-tickets":
        ctx.waitUntil(
          runInContext(env, ctx, () => this.processRefreshTicketsCommand(payload.response_url)),
        );
        return this.jsonResponse({
          response_type: "ephemeral",
          text: "⏳ Actualizando tickets...",
        });

      case "/help":
        return this.jsonResponse({
          response_type: "ephemeral",
          blocks: this.messageBuilderService.buildHelpMessage(),
          text: "📖 Ayuda — Bot de Horas",
        });

      default:
        return this.jsonResponse({
          response_type: "ephemeral",
          text: `⚠️ Comando desconocido: \`${command}\``,
        });
    }
  }

  // ─── Validation ───

  validateAndResolveDailySubmissionDate(
    paramText: string,
  ): DailySummaryValidResult | DailySummaryErrorResult {
    const todayET = getTodayET();
    const todayDayOfWeek = getDayOfWeekET(todayET);

    if (!paramText) {
      if (todayDayOfWeek > 5) {
        return {
          error:
            "⚠️ Hoy es fin de semana. Usa `/submit lun|mar|mie|jue|vie` para cargar horas en un día de la semana en curso.",
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

  private async processSummaryCommand(slackUserId: string, responseUrl: string): Promise<void> {
    try {
      const userEmails = this.configService.userEmails;
      const userEmail = await this.slackService.resolveEmailFromSlackId(slackUserId, userEmails);

      if (!userEmail) {
        await this.sendCommandError(
          responseUrl,
          "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
        );
        return;
      }

      const config = this.configService.config;
      const issues = await this.jiraService.searchTicketsForUser(userEmail);
      const accountEmailMap = await this.jiraService.buildAccountIdEmailMap(issues);

      const today = new Date();
      const { monday, friday } = getWeekBoundaries(today);

      const weeklyMap = this.aggregatorService.aggregateWeeklyHours(
        issues,
        accountEmailMap,
        [userEmail],
        monday,
        friday,
      );
      const weeklySummary = weeklyMap.get(userEmail.toLowerCase());

      if (!weeklySummary) {
        await this.sendCommandError(
          responseUrl,
          "⚠️ No se encontraron datos de horas para esta semana.",
        );
        return;
      }

      const blocks = this.messageBuilderService.buildWeeklyMessage(weeklySummary, config);
      const { monday: weekMonday, friday: weekFriday } = getWeekBoundaries(new Date());

      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        blocks,
        `Resumen semanal (${weekMonday} – ${weekFriday}): ${weeklySummary.weekTotal.toFixed(1)}h / ${config.tracking.weeklyTarget}h`,
        true,
      );
    } catch (err) {
      console.error("processSummaryCommand error:", err);
      await this.sendCommandError(
        responseUrl,
        "❌ Ocurrió un error al obtener tu resumen. Por favor intenta de nuevo más tarde.",
      );
    }
  }

  private async processSummaryComponentsCommand(
    slackUserId: string,
    responseUrl: string,
  ): Promise<void> {
    try {
      const userEmails = this.configService.userEmails;
      const userEmail = await this.slackService.resolveEmailFromSlackId(slackUserId, userEmails);

      if (!userEmail) {
        await this.sendCommandError(
          responseUrl,
          "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
        );
        return;
      }

      const config = this.configService.config;
      const issues = await this.jiraService.searchTicketsForUser(userEmail);
      const accountEmailMap = await this.jiraService.buildAccountIdEmailMap(issues);

      const { monday, friday } = getWeekBoundaries(new Date());

      const breakdown = this.aggregatorService.aggregateWeeklyHoursByComponent(
        issues,
        accountEmailMap,
        userEmail,
        monday,
        friday,
      );

      const blocks = this.messageBuilderService.buildWeeklyByComponentMessage(
        breakdown,
        config,
        monday,
        friday,
      );

      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        blocks,
        `Resumen semanal por componente (${monday} – ${friday}): ${breakdown.components.length} componente(s)`,
        true,
      );
    } catch (err) {
      console.error("processSummaryComponentsCommand error:", err);
      await this.sendCommandError(
        responseUrl,
        "❌ Ocurrió un error al obtener tu resumen por componente. Por favor intenta de nuevo más tarde.",
      );
    }
  }

  private async processDailySummaryCommand(
    slackUserId: string,
    targetDate: string,
    dateLabel: string,
    responseUrl: string,
  ): Promise<void> {
    try {
      const userEmails = this.configService.userEmails;
      const userEmail = await this.slackService.resolveEmailFromSlackId(slackUserId, userEmails);

      if (!userEmail) {
        await this.sendCommandError(
          responseUrl,
          "⚠️ No se pudo identificar tu usuario. Contacta al administrador.",
        );
        return;
      }

      const config = this.configService.config;
      const jiraConfig = this.configService.jiraConfig;

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
        await this.sendCommandError(
          responseUrl,
          "⚠️ No se encontraron datos de horas para este día.",
        );
        return;
      }

      const blocks = this.messageBuilderService.buildDailyMessage(
        summary,
        config,
        targetDate,
        jiraConfig,
        undefined,
        undefined,
        dateLabel,
      );

      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        blocks,
        `Resumen del ${dateLabel}: ${summary.totalHours.toFixed(1)}h / ${config.tracking.dailyTarget}h`,
        true,
      );
    } catch (err) {
      console.error("processDailySummaryCommand error:", err);
      await this.sendCommandError(
        responseUrl,
        "❌ Ocurrió un error al obtener tu resumen diario. Por favor intenta de nuevo más tarde.",
      );
    }
  }

  private async processRefreshTicketsCommand(responseUrl: string): Promise<void> {
    try {
      await this.jiraService.refreshJiraTicketsCache();

      const blocks: SlackBlock[] = [
        {
          type: "section",
          text: { type: "plain_text", text: "✅ Tickets Actualizados", emoji: true },
        },
      ];

      await this.slackService.updateMessageViaResponseUrl(
        responseUrl,
        blocks,
        "✅ Tickets Actualizados",
        true,
      );
    } catch (err) {
      console.error("processRefreshTicketsCommand error:", err);
      await this.sendCommandError(
        responseUrl,
        "❌ Ocurrió un error al actualizar los tickets. Por favor intenta de nuevo más tarde.",
      );
    }
  }

  // ─── Helpers ───

  private sendCommandError(responseUrl: string, message: string): Promise<void> {
    return this.slackService.updateMessageViaResponseUrl(
      responseUrl,
      [{ type: "section", text: { type: "mrkdwn", text: message } }],
      message.replace(/[*_`]/g, ""),
      true,
    );
  }

  private jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
