import type {
  SlackBlock,
  SlackOption,
  UserHoursSummary,
  WeeklyBreakdown,
  TrackerConfig,
  GenericTicket,
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
  if (summary.tickets.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No hay horas registradas hoy._" },
    });
  } else {
    let breakdown = "*Desglose por ticket:*\n";
    for (const t of summary.tickets) {
      breakdown += `• \`${t.key}\` ${t.summary} — *${t.hours.toFixed(1)}h*\n`;
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: breakdown },
    });
  }

  return blocks;
}

// ─── Scenario A: Interactive (under daily target) ───

function buildInteractiveSection(
  summary: UserHoursSummary,
  config: TrackerConfig
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const remaining = config.tracking.dailyTarget - summary.totalHours;

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔔 Te faltan *${remaining.toFixed(1)}h* para llegar a ${config.tracking.dailyTarget}h. ¡Carga tus horas directamente desde aquí!`,
    },
  });

  // Ticket selector options: user's assigned tickets + generic tickets
  const ticketOptions: SlackOption[] = [];
  const seenKeys = new Set<string>();

  // Add generic tickets first
  for (const gt of config.jira.genericTickets) {
    if (!seenKeys.has(gt.key)) {
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${gt.key} - ${gt.label}`, 75), emoji: true },
        value: gt.key,
      });
      seenKeys.add(gt.key);
    }
  }

  // Add user's assigned tickets
  for (const key of summary.assignedTicketKeys) {
    if (!seenKeys.has(key)) {
      const ticket = summary.tickets.find((t) => t.key === key);
      const label = ticket ? ticket.summary : key;
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${key} - ${label}`, 75), emoji: true },
        value: key,
      });
      seenKeys.add(key);
    }
  }

  // Also include tickets with worklogs today that aren't already in the list
  for (const t of summary.tickets) {
    if (!seenKeys.has(t.key)) {
      ticketOptions.push({
        text: { type: "plain_text", text: truncate(`${t.key} - ${t.summary}`, 75), emoji: true },
        value: t.key,
      });
      seenKeys.add(t.key);
    }
  }

  // Hours selector: 0.5 increments up to remaining hours (max 8h)
  const hoursOptions: SlackOption[] = [];
  const maxHours = Math.min(remaining, config.tracking.dailyTarget);
  for (let h = 0.5; h <= maxHours; h += 0.5) {
    hoursOptions.push({
      text: { type: "plain_text", text: `${h.toFixed(1)}h`, emoji: true },
      value: h.toFixed(1),
    });
  }

  // Ensure we have at least one option for each selector
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

  // Ticket dropdown
  blocks.push({
    type: "section",
    block_id: "ticket_block",
    text: { type: "mrkdwn", text: "*Selecciona un ticket:*" },
    accessory: {
      type: "static_select",
      action_id: "select_ticket",
      placeholder: { type: "plain_text", text: "Elegir ticket...", emoji: true },
      options: ticketOptions,
    },
  });

  // Hours dropdown
  blocks.push({
    type: "section",
    block_id: "hours_block",
    text: { type: "mrkdwn", text: "*Selecciona las horas:*" },
    accessory: {
      type: "static_select",
      action_id: "select_hours",
      placeholder: { type: "plain_text", text: "Elegir horas...", emoji: true },
      options: hoursOptions,
    },
  });

  // Submit button
  blocks.push({
    type: "actions",
    block_id: "submit_block",
    elements: [
      {
        type: "button",
        action_id: "submit_hours",
        text: { type: "plain_text", text: "✅ Cargar horas", emoji: true },
        style: "primary",
        value: "submit",
      },
    ],
  });

  return blocks;
}

// ─── Friday: Weekly Summary ───

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
        dayBreakdown += `      • \`${t.key}\` — ${t.hours.toFixed(1)}h\n`;
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
  ticketKey: string,
  hoursAdded: number,
  updatedSummary: UserHoursSummary,
  dailyTarget: number
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `✅ *¡Horas cargadas exitosamente!*\nSe registraron *${hoursAdded.toFixed(1)}h* en \`${ticketKey}\`.`,
    },
  });

  blocks.push({ type: "divider" });

  // Show updated breakdown
  const updatedBlocks = buildHoursBreakdown(updatedSummary, dailyTarget);
  // Skip the header from the updated breakdown (first block)
  blocks.push(...updatedBlocks.slice(1));

  // If still under target, add interactive section again
  if (updatedSummary.totalHours < dailyTarget) {
    // We don't add the interactive section here because config isn't available.
    // The handler will add it.
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
  config: TrackerConfig
): SlackBlock[] {
  const blocks = buildHoursBreakdown(summary, config.tracking.dailyTarget);

  if (summary.totalHours < config.tracking.dailyTarget) {
    blocks.push(...buildInteractiveSection(summary, config));
  }

  return blocks;
}

/**
 * Builds the Friday message: daily report + weekly summary.
 */
export function buildFridayMessage(
  dailySummary: UserHoursSummary,
  weeklySummary: WeeklyBreakdown,
  config: TrackerConfig
): SlackBlock[] {
  const blocks = buildDailyMessage(dailySummary, config);
  blocks.push(...buildWeeklySummaryBlocks(weeklySummary, config.tracking.weeklyTarget));
  return blocks;
}

// ─── Helpers ───

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}
