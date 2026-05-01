import type {
  SlackBlock,
  SlackOption,
  SlackElement,
  UserHoursSummary,
  WeeklyBreakdown,
  WeeklyByComponentBreakdown,
  TrackerConfig,
  JiraConfig,
  ExistingSelection,
} from "../types/index.ts";

// ─── Day Abbreviations ───
const DAY_NAMES: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return DAY_NAMES[dt.getDay()] ?? dateStr;
}

// ─── Core Message: Regla General (always included) ───

function buildHoursBreakdown(
  summary: UserHoursSummary,
  dailyTarget: number,
  dateLabel?: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "⏱️ Daily Hours Report", emoji: true },
  });

  // Greeting + Total
  const status =
    summary.totalHours >= dailyTarget
      ? `✅ *${summary.totalHours.toFixed(1)}h* / ${dailyTarget}h — Complete!`
      : `⏳ *${summary.totalHours.toFixed(1)}h* / ${dailyTarget}h — *${(dailyTarget - summary.totalHours).toFixed(1)}h* remaining`;

  const dateLine = dateLabel ? `\n📅 *${dateLabel}*` : "";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `👋 Hey *${summary.displayName}*${dateLine}\n\n${status}`,
    },
  });

  blocks.push({ type: "divider" });

  // Per-ticket breakdown
  if (summary.workedTickets.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No hours logged today._" },
    });
  } else {
    let breakdown = "*Breakdown by ticket:*\n";
    for (const t of summary.workedTickets) {
      breakdown += `• \`${t.key}\` ${t.summary} — *${t.hours.toFixed(1)}h*\n`;
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: breakdown },
    });
  }

  return blocks;
}

// ─── Scenario A: Interactive (under daily target) — dynamic slots with external_select ───

const DEFAULT_SLOT_COUNT = 3;
const MAX_SLOT_COUNT = 10;

function buildInteractiveSection(
  summary: UserHoursSummary,
  config: TrackerConfig,
  targetDate: string,
  _jiraConfig: JiraConfig,
  slotCount: number = DEFAULT_SLOT_COUNT,
  existingSelections: ExistingSelection[] = [],
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const remaining = config.tracking.dailyTarget - summary.totalHours;
  const effectiveSlotCount = Math.min(slotCount, MAX_SLOT_COUNT);

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔔 You're *${remaining.toFixed(1)}h* short of your ${config.tracking.dailyTarget}h target. Log your hours directly from here!`,
    },
  });

  // Hours options (shared across all slots)
  const hoursOptions: SlackOption[] = [];
  const maxHours = Math.min(remaining, config.tracking.dailyTarget);
  for (let h = 0.5; h <= maxHours; h += 0.5) {
    hoursOptions.push({
      text: { type: "plain_text", text: `${h.toFixed(1)}h`, emoji: true },
      value: h.toFixed(1),
    });
  }

  if (hoursOptions.length === 0) {
    hoursOptions.push({
      text: { type: "plain_text", text: "0.5h", emoji: true },
      value: "0.5",
    });
  }

  // Render N slots
  for (let i = 0; i < effectiveSlotCount; i++) {
    const existing = existingSelections[i];

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `📝 *Slot ${i + 1}*` },
    });

    // Ticket selector — external_select with typeahead
    const ticketAccessory: SlackElement = {
      type: "external_select",
      action_id: `select_ticket_${i}`,
      placeholder: { type: "plain_text", text: "Search ticket...", emoji: true },
      min_query_length: 0,
    };
    if (existing?.ticketOption) {
      ticketAccessory.initial_option = existing.ticketOption;
    }

    blocks.push({
      type: "section",
      block_id: `ticket_block_${i}`,
      text: { type: "mrkdwn", text: "*Ticket:*" },
      accessory: ticketAccessory,
    });

    // Hours selector — static_select (always <16 options)
    const hoursAccessory: SlackElement = {
      type: "static_select",
      action_id: `select_hours_${i}`,
      placeholder: { type: "plain_text", text: "Select hours...", emoji: true },
      options: hoursOptions,
    };
    if (existing?.hoursOption) {
      hoursAccessory.initial_option = existing.hoursOption;
    }

    blocks.push({
      type: "section",
      block_id: `hours_block_${i}`,
      text: { type: "mrkdwn", text: "*Hours:*" },
      accessory: hoursAccessory,
    });
  }

  // Action buttons: Submit + Add Slot (if under max)
  const actionElements: SlackElement[] = [
    {
      type: "button",
      action_id: "submit_hours",
      text: { type: "plain_text", text: "✅ Log hours", emoji: true },
      style: "primary",
      value: targetDate,
    },
  ];

  if (effectiveSlotCount < MAX_SLOT_COUNT) {
    actionElements.push({
      type: "button",
      action_id: "add_slot",
      text: { type: "plain_text", text: "➕ Add slot", emoji: true },
      value: `${effectiveSlotCount}:${targetDate}`,
    });
  }

  blocks.push({
    type: "actions",
    block_id: "submit_block",
    elements: actionElements,
  });

  return blocks;
}

// ─── Weekly Summary ───

function buildWeeklySummaryBlocks(weekly: WeeklyBreakdown, weeklyTarget: number): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  blocks.push({ type: "divider" });
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "📊 Weekly Summary", emoji: true },
  });

  const weekStatus =
    weekly.weekTotal >= weeklyTarget
      ? `✅ *${weekly.weekTotal.toFixed(1)}h* / ${weeklyTarget}h — Target met!`
      : `⚠️ *${weekly.weekTotal.toFixed(1)}h* / ${weeklyTarget}h — *${(weeklyTarget - weekly.weekTotal).toFixed(1)}h* remaining`;

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: weekStatus },
  });

  // Per-day breakdown
  let dayBreakdown = "*Breakdown by day:*\n";
  for (const day of weekly.days) {
    const icon = day.totalHours >= 8 ? "✅" : day.totalHours > 0 ? "⏳" : "❌";
    dayBreakdown += `${icon} *${dayLabel(day.date)}* (${day.date}): *${day.totalHours.toFixed(1)}h*`;
    if (day.tickets.length > 0) {
      dayBreakdown += "\n";
      for (const t of day.tickets) {
        dayBreakdown += `      • \`${t.key}\` ${t.summary} — ${t.hours.toFixed(1)}h\n`;
      }
    } else {
      dayBreakdown += " — _No hours_\n";
    }
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: dayBreakdown },
  });

  return blocks;
}

// ─── Confirmation Message (after worklog submission) ───

export function buildConfirmationMessage(
  entries: { ticketKey: string; hours: number }[],
  updatedSummary: UserHoursSummary,
  dailyTarget: number,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const lines = entries.map((e) => `• *${e.hours.toFixed(1)}h* en \`${e.ticketKey}\``).join("\n");

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `✅ *Hours logged successfully!*\n${lines}`,
    },
  });

  blocks.push({ type: "divider" });

  // Show updated breakdown
  const updatedBlocks = buildHoursBreakdown(updatedSummary, dailyTarget);
  // Skip the header from the updated breakdown (first block)
  blocks.push(...updatedBlocks.slice(1));

  // If still under target, inform user
  if (updatedSummary.totalHours < dailyTarget) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⏳ You still have *${(dailyTarget - updatedSummary.totalHours).toFixed(1)}h* remaining. A new message will be sent so you can continue logging.`,
      },
    });
  }

  return blocks;
}

// ─── Main Builders (public API) ───

/**
 * Builds the full daily message for a user.
 * - Scenario A (< dailyTarget): breakdown + interactive dropdown
 * - Scenario B (>= dailyTarget): breakdown only (informational)
 *
 * @param dateLabel - Optional long-form date label (e.g. "Friday, April 10, 2026")
 */
export function buildDailyMessage(
  summary: UserHoursSummary,
  config: TrackerConfig,
  targetDate: string,
  jiraConfig: JiraConfig,
  slotCount?: number,
  existingSelections?: ExistingSelection[],
  dateLabel?: string,
): SlackBlock[] {
  const blocks = buildHoursBreakdown(summary, config.tracking.dailyTarget, dateLabel);

  if (summary.totalHours < config.tracking.dailyTarget) {
    blocks.push(
      ...buildInteractiveSection(
        summary,
        config,
        targetDate,
        jiraConfig,
        slotCount,
        existingSelections,
      ),
    );
  }

  return blocks;
}

/**
 * Builds the weekly message: weekly summary.
 */
export function buildWeeklyMessage(
  weeklySummary: WeeklyBreakdown,
  config: TrackerConfig,
): SlackBlock[] {
  return [...buildWeeklySummaryBlocks(weeklySummary, config.tracking.weeklyTarget)];
}

/**
 * Builds a weekly summary grouped by Jira component for a single user.
 */
export function buildWeeklyByComponentMessage(
  breakdown: WeeklyByComponentBreakdown,
  _config: TrackerConfig,
  weekMonday: string,
  weekFriday: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "🧩 Weekly Summary by Component", emoji: true },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `👋 Hey *${breakdown.displayName}* | Week: ${weekMonday} – ${weekFriday}`,
    },
  });

  if (breakdown.components.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No hours logged this week._" },
    });
    return blocks;
  }

  for (const comp of breakdown.components) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔷 *${comp.componentName}* — *${comp.weekTotal.toFixed(1)}h*`,
      },
    });

    let dayBreakdown = "";
    for (const day of comp.days) {
      if (day.totalHours === 0) continue;
      const icon = day.totalHours >= 8 ? "✅" : "⏳";
      dayBreakdown += `${icon} *${dayLabel(day.date)}* (${day.date}): *${day.totalHours.toFixed(1)}h*\n`;
      for (const t of day.tickets) {
        dayBreakdown += `      • \`${t.key}\` ${t.summary} — ${t.hours.toFixed(1)}h\n`;
      }
    }

    if (dayBreakdown) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: dayBreakdown.trimEnd() },
      });
    }
  }

  return blocks;
}

// ─── Help Message ───

/**
 * Builds an ephemeral help message listing all available slash commands.
 * Returned synchronously — no external calls required.
 */
export function buildHelpMessage(): SlackBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "📖 Help — Hours Bot", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "I'm a time tracking bot integrated with *Jira* and *Slack*. Every weekday at 4 PM ET I send you a report with your hours for the day and let you log time directly from Slack.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Available commands:*",
          "",
          "• `/summary` — Shows your weekly hours summary (Mon–Fri vs 40h target).",
          "• `/summary-components` — Shows your weekly summary grouped by Jira component.",
          "• `/submit [lun|mar|mie|jue|vie]` — Requests a time entry for a specific day of the current week (default: today).",
          "• `/refresh-tickets` — Refreshes the Jira ticket cache for typeahead search.",
          "• `/help` — Shows this help message.",
        ].join("\n"),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Only you can see this message._",
      },
    },
  ];
}
