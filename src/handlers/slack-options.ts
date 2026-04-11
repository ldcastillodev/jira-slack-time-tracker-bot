import type {
  Env,
  CachedTicket,
  JiraConfig,
  SlackOption,
  SlackOptionGroup,
} from "../types/index.ts";
import { CACHE_KEY_ALL_TICKETS } from "../constants/constants.ts";
import { verifySlackSignature } from "../utils/crypto.ts";

const MAX_OPTIONS = 100;

/**
 * Handles Slack `block_suggestion` payloads for external_select typeahead.
 * Reads cached tickets from KV and filters by the user's query string.
 */
export async function handleSlackOptions(request: Request, env: Env): Promise<Response> {
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

  const payload = JSON.parse(payloadStr) as { type: string; value: string; action_id: string };

  if (payload.type !== "block_suggestion") {
    return new Response("OK", { status: 200 });
  }

  const query = (payload.value ?? "").trim().toLowerCase();
  const jiraConfig = JSON.parse(env.JIRA_CONFIG) as JiraConfig;

  // Read cached tickets from KV
  const cachedRaw = await env.CACHE.get(CACHE_KEY_ALL_TICKETS);
  let allTickets: CachedTicket[];

  if (cachedRaw) {
    allTickets = JSON.parse(cachedRaw) as CachedTicket[];
  } else {
    // Fallback: use generic tickets from config
    allTickets = jiraConfig.jira.genericTickets.map((gt) => ({
      key: gt.key,
      summary: gt.summary,
    }));
  }

  // Separate generic tickets from project tickets
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

  // Filter by query
  const filterFn = (t: CachedTicket): boolean => {
    if (!query) return true;
    return t.key.toLowerCase().includes(query) || t.summary.toLowerCase().includes(query);
  };

  const filteredGeneric = genericTickets.filter(filterFn);
  const filteredProject = projectTickets.filter(filterFn);

  // Build option groups
  const toOption = (t: CachedTicket): SlackOption => ({
    text: { type: "plain_text", text: truncate(`${t.key} - ${t.summary}`, 75), emoji: true },
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

  // If no results, return empty (Slack will show "No results")
  if (optionGroups.length === 0) {
    return Response.json({ option_groups: [] });
  }

  return Response.json({ option_groups: optionGroups });
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}
