import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../../context/request-context.service.ts";
import { ConfigService } from "../../config/config.service.ts";
import { verifySlackSignature } from "../../common/utils/crypto.ts";
import { CACHE_KEY_ALL_TICKETS } from "../../common/constants/constants.ts";
import type { CachedTicket, SlackOption, SlackOptionGroup } from "../../common/types/index.ts";

const MAX_OPTIONS = 100;

@Injectable()
export class SlackOptionsHandler {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly configService: ConfigService,
  ) {}

  async handleSlackOptions(request: Request): Promise<Response> {
    const env = this.requestContext.env;
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

    const payload = JSON.parse(payloadStr) as { type: string; value: string; action_id: string };

    if (payload.type !== "block_suggestion") {
      return new Response("OK", { status: 200 });
    }

    const query = (payload.value ?? "").trim().toLowerCase();
    const jiraConfig = this.configService.jiraConfig;

    const cachedRaw = await env.CACHE.get(CACHE_KEY_ALL_TICKETS);
    let allTickets: CachedTicket[];

    if (cachedRaw) {
      allTickets = JSON.parse(cachedRaw) as CachedTicket[];
    } else {
      allTickets = jiraConfig.jira.genericTickets.map((gt) => ({
        key: gt.key,
        summary: gt.summary,
      }));
    }

    const genericKeys = new Set(jiraConfig.jira.genericTickets.map((gt) => gt.key));

    const genericTickets: CachedTicket[] = [];
    const projectTickets: CachedTicket[] = [];

    for (const ticket of allTickets) {
      if (genericKeys.has(ticket.key)) {
        genericTickets.push(ticket);
      } else {
        projectTickets.push(ticket);
      }
    }

    const filterFn = (t: CachedTicket): boolean => {
      if (!query) return true;
      return t.key.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query);
    };

    const filteredGeneric = genericTickets.filter(filterFn);
    const filteredProject = projectTickets.filter(filterFn);

    const toOption = (t: CachedTicket): SlackOption => ({
      text: {
        type: "plain_text",
        text: this.truncate(`${t.key} - ${t.summary}`, 75),
        emoji: true,
      },
      value: t.key,
    });

    const optionGroups: SlackOptionGroup[] = [];
    let totalCount = 0;

    if (filteredGeneric.length > 0) {
      const genericOptions = filteredGeneric.slice(0, MAX_OPTIONS).map(toOption);
      totalCount += genericOptions.length;
      optionGroups.push({
        label: { type: "plain_text", text: "📌 Tickets Genéricos" },
        options: genericOptions,
      });
    }

    if (filteredProject.length > 0 && totalCount < MAX_OPTIONS) {
      const remaining = MAX_OPTIONS - totalCount;
      const projectOptions = filteredProject.slice(0, remaining).map(toOption);
      optionGroups.push({
        label: { type: "plain_text", text: "📋 Tickets de Proyecto" },
        options: projectOptions,
      });
    }

    if (optionGroups.length === 0) {
      return Response.json({ option_groups: [] });
    }

    return Response.json({ option_groups: optionGroups });
  }

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
  }
}
