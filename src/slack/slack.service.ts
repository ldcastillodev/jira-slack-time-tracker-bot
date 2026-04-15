import { Injectable } from "@nestjs/common";
import { RequestContextService } from "../context/request-context.service.ts";
import type { SlackBlock } from "../common/types/index.ts";
import { CACHE_KEY_SLACK_USER_PREFIX, TTL_SLACK_USER } from "../common/constants/constants.ts";

@Injectable()
export class SlackService {
  constructor(private readonly requestContext: RequestContextService) {}

  // ─── Lookup Slack User by Email (KV-cached) ───

  async lookupUserByEmail(email: string): Promise<string | null> {
    const env = this.requestContext.env;
    const kvKey = `${CACHE_KEY_SLACK_USER_PREFIX}${email}`;

    const cached = await env.CACHE.get(kvKey);
    if (cached) return cached;

    const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });

    if (!resp.ok) {
      console.error(`Slack lookupByEmail failed for ${email}: ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { ok: boolean; user?: { id: string }; error?: string };
    if (!data.ok || !data.user) {
      console.error(`Slack lookupByEmail error for ${email}: ${data.error}`);
      return null;
    }

    await env.CACHE.put(kvKey, data.user.id, { expirationTtl: TTL_SLACK_USER });
    return data.user.id;
  }

  // ─── Send Direct Message ───

  async sendDirectMessage(
    slackUserId: string,
    blocks: SlackBlock[],
    text: string,
  ): Promise<boolean> {
    const env = this.requestContext.env;
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: slackUserId,
        text,
        blocks,
      }),
    });

    if (!resp.ok) {
      console.error(`Slack postMessage failed: ${resp.status}`);
      return false;
    }

    const data = (await resp.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error(`Slack postMessage error: ${data.error}`);
      return false;
    }

    return true;
  }

  // ─── Update Message via response_url ───

  async updateMessageViaResponseUrl(
    responseUrl: string,
    blocks: SlackBlock[],
    text: string,
    replaceOriginalMessage: boolean,
  ): Promise<void> {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: replaceOriginalMessage,
        response_type: "ephemeral",
        text,
        blocks,
      }),
    });
  }

  // ─── Resolve Email from Slack User ID (KV-cached reverse lookup) ───

  async resolveEmailFromSlackId(
    slackUserId: string,
    configuredEmails: string[],
  ): Promise<string | null> {
    const env = this.requestContext.env;

    for (const email of configuredEmails) {
      const cached = await env.CACHE.get(`${CACHE_KEY_SLACK_USER_PREFIX}${email}`);
      if (cached === slackUserId) {
        return email;
      }
    }

    for (const email of configuredEmails) {
      const resolvedSlackUserId = await this.lookupUserByEmail(email);
      if (resolvedSlackUserId === slackUserId) {
        return email;
      }
    }

    return null;
  }
}
