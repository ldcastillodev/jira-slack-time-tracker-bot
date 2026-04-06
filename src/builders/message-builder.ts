import type {
  SlackBlock,
  SlackOption,
  UserHoursSummary,
  WeeklyBreakdown,
  TrackerConfig,
  JiraConfig,
} from "../types/index.ts";

// ─── Day Abbreviations ───
const DAY_NAMES: Record<number, string> = {
  0: "Dom",
  1: "Lun",
  2: "Mar",
  3: "Mié",
  4: "Jue",
  5: "Vie",
  6: "Sáb",
};

function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return DAY_NAMES[dt.getDay()] ?? dateStr;
}

// ─── Core Message: Regla General (always included) ───

function buildHoursBreakdown(summary: UserHoursSummary, dailyTarget: number): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "⏱️ Reporte de Horas Diarias", emoji: true },
  });

  // Greeting + Total
  const status =
    summary.totalHours >= dailyTarget
      ? `✅ *${summary.totalHours.toFixed(1)}h* / ${dailyTarget}h — ¡Completo!`
      : `⏳ *${summary.totalHours.toFixed(1)}h* / ${dailyTarget}h — Faltan *${(dailyTarget - summary.totalHours).toFixed(1)}h*`;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `👋 Hola *${summary.displayName.split(" ")[0]}*,\n\n${status}`,
    },
  });

  blocks.push({ type: "divider" });

  // Per-ticket breakdown
  if (summary.workedTickets.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No hay horas registradas hoy._" },
    });
  } else {
    let breakdown = "*Desglose por ticket:*\n";
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

// ─── Scenario A: Interactive (under daily target) — 3 pre-rendered slots ───

const SLOT_COUNT = 3;

function buildInteractiveSection(
  summary: UserHoursSummary,
  config: TrackerConfig,
  targetDate: string,
  jiraConfig: JiraConfig,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const remaining = config.tracking.dailyTarget - summary.totalHours;

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔔 Te faltan *${remaining.toFixed(1)}h* para llegar a ${config.tracking.dailyTarget}h. ¡Carga tus horas directamente desde aquí!\n_Puedes usar hasta ${SLOT_COUNT} ranuras. Las que dejes vacías serán ignoradas._`,
    },
  });

  // Build ticket options (shared across all slots)
  const ticketOptions: SlackOption[] = [];
  const seenKeys = new Set<string>();

  for (const gt of jiraConfig.jira.genericTickets) {
    if (!seenKeys.has(gt.key)) {
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${gt.key} - ${gt.summary}`, 75), emoji: true },
        value: gt.key,
      });
      seenKeys.add(gt.key);
    }
  }

  for (const tk of summary.ticketKeys) {
    if (!seenKeys.has(tk.key)) {
      const ticket = summary.workedTickets.find((t) => t.key === tk.key);
      const label = ticket ? ticket.summary : tk.summary;
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${tk.key} - ${label}`, 75), emoji: true },
        value: tk.key,
      });
      seenKeys.add(tk.key);
    }
  }

  for (const t of summary.workedTickets) {
    if (!seenKeys.has(t.key)) {
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${t.key} - ${t.summary}`, 75), emoji: true },
        value: t.key,
      });
      seenKeys.add(t.key);
    }
  }

  // Hours options (shared across all slots)
  const hoursOptions: SlackOption[] = [];
  const maxHours = Math.min(remaining, config.tracking.dailyTarget);
  for (let h = 0.5; h <= maxHours; h += 0.5) {
    hoursOptions.push({
      text: { type: "plain_text", text: `${h.toFixed(1)}h`, emoji: true },
      value: h.toFixed(1),
    });
  }

  // Fallback options
  if (ticketOptions.length === 0) {
    ticketOptions.push({
      text: { type: "plain_text", text: "No hay tickets disponibles", emoji: true },
      value: "none",
    });
  }
  if (hoursOptions.length === 0) {
    hoursOptions.push({
      text: { type: "plain_text", text: "0.5h", emoji: true },
      value: "0.5",
    });
  }

  // Render 3 slots
  for (let i = 0; i < SLOT_COUNT; i++) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `📝 *Ranura ${i + 1}*` },
    });

    blocks.push({
      type: "section",
      block_id: `ticket_block_${i}`,
      text: { type: "mrkdwn", text: "*Ticket:*" },
      accessory: {
        type: "static_select",
        action_id: `select_ticket_${i}`,
        placeholder: { type: "plain_text", text: "Elegir ticket...", emoji: true },
        options: ticketOptions,
      },
    });

    blocks.push({
      type: "section",
      block_id: `hours_block_${i}`,
      text: { type: "mrkdwn", text: "*Horas:*" },
      accessory: {
        type: "static_select",
        action_id: `select_hours_${i}`,
        placeholder: { type: "plain_text", text: "Elegir horas...", emoji: true },
        options: hoursOptions,
      },
    });
  }

  // Single submit button with targetDate encoded in value
  blocks.push({
    type: "actions",
    block_id: "submit_block",
    elements: [
      {
        type: "button",
        action_id: "submit_hours",
        text: { type: "plain_text", text: "✅ Cargar horas", emoji: true },
        style: "primary",
        value: targetDate,
      },
    ],
  });

  return blocks;
}

// ─── Weekly Summary ───

function buildWeeklySummaryBlocks(
  weekly: WeeklyBreakdown,
  weeklyTarget: number
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  blocks.push({ type: "divider" });
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "📊 Resumen Semanal", emoji: true },
  });

  const weekStatus =
    weekly.weekTotal >= weeklyTarget
      ? `✅ *${weekly.weekTotal.toFixed(1)}h* / ${weeklyTarget}h — ¡Objetivo cumplido!`
      : `⚠️ *${weekly.weekTotal.toFixed(1)}h* / ${weeklyTarget}h — Faltan *${(weeklyTarget - weekly.weekTotal).toFixed(1)}h*`;

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: weekStatus },
  });

  // Per-day breakdown
  let dayBreakdown = "*Desglose por día:*\n";
  for (const day of weekly.days) {
    const icon = day.totalHours >= 8 ? "✅" : day.totalHours > 0 ? "⏳" : "❌";
    dayBreakdown += `${icon} *${dayLabel(day.date)}* (${day.date}): *${day.totalHours.toFixed(1)}h*`;
    if (day.tickets.length > 0) {
      dayBreakdown += "\n";
      for (const t of day.tickets) {
        dayBreakdown += `      • \`${t.key}\` \`(${t.summary})\` — ${t.hours.toFixed(1)}h\n`;
      }
    } else {
      dayBreakdown += " — _Sin horas_\n";
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
  dailyTarget: number
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const lines = entries
    .map((e) => `• *${e.hours.toFixed(1)}h* en \`${e.ticketKey}\``)
    .join("\n");

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `✅ *¡Horas cargadas exitosamente!*\n${lines}`,
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
        text: `⏳ Aún te faltan *${(dailyTarget - updatedSummary.totalHours).toFixed(1)}h*. Recibirás un nuevo mensaje para seguir cargando.`,
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
 */
export function buildDailyMessage(
  summary: UserHoursSummary,
  config: TrackerConfig,
  targetDate: string,
  jiraConfig: JiraConfig
): SlackBlock[] {
  const blocks = buildHoursBreakdown(summary, config.tracking.dailyTarget);

  if (summary.totalHours < config.tracking.dailyTarget) {
    blocks.push(...buildInteractiveSection(summary, config, targetDate, jiraConfig));
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

// ─── Helpers ───

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}
