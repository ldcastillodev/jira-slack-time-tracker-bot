import type { Env, SlackBlock } from "../types/index.ts";
import { CACHE_KEY_SLACK_USER_PREFIX, TTL_SLACK_USER } from "../constants/constants.ts";

// ─── Lookup Slack User by Email (KV-cached) ───

/**
 * Resolves a Slack user ID from an email address.
 * Results are cached in KV for 7 days.
 */
export async function lookupUserByEmail(env: Env, email: string): Promise<string | null> {
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

export async function sendDirectMessage(
  env: Env,
  slackUserId: string,
  blocks: SlackBlock[],
  text: string,
): Promise<boolean> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: slackUserId,
      text, // fallback for notifications
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

export async function updateMessageViaResponseUrl(
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

/**
 * Resolves a configured user's email from their Slack user ID.
 * Checks the KV cache first, then falls back to Slack lookups for configured emails.
 */
export async function resolveEmailFromSlackId(
  env: Env,
  slackUserId: string,
  configuredEmails: string[],
): Promise<string | null> {
  for (const email of configuredEmails) {
    const cached = await env.CACHE.get(`${CACHE_KEY_SLACK_USER_PREFIX}${email}`);
    if (cached === slackUserId) {
      return email;
    }
  }

  for (const email of configuredEmails) {
    const resolvedSlackUserId = await lookupUserByEmail(env, email);
    if (resolvedSlackUserId === slackUserId) {
      return email;
    }
  }

  return null;
}
