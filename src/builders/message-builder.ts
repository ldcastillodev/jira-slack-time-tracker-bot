import type {
  SlackBlock,
  SlackOption,
  SlackElement,
  UserHoursSummary,
  WeeklyBreakdown,
  TrackerConfig,
  JiraConfig,
  ExistingSelection,
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
      text: `🔔 Te faltan *${remaining.toFixed(1)}h* para llegar a ${config.tracking.dailyTarget}h. ¡Carga tus horas directamente desde aquí!\n_Puedes usar hasta ${effectiveSlotCount} ranuras. Las que dejes vacías serán ignoradas._`,
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
      text: { type: "mrkdwn", text: `📝 *Ranura ${i + 1}*` },
    });

    // Ticket selector — external_select with typeahead
    const ticketAccessory: SlackElement = {
      type: "external_select",
      action_id: `select_ticket_${i}`,
      placeholder: { type: "plain_text", text: "Buscar ticket...", emoji: true },
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
      placeholder: { type: "plain_text", text: "Elegir horas...", emoji: true },
      options: hoursOptions,
    };
    if (existing?.hoursOption) {
      hoursAccessory.initial_option = existing.hoursOption;
    }

    blocks.push({
      type: "section",
      block_id: `hours_block_${i}`,
      text: { type: "mrkdwn", text: "*Horas:*" },
      accessory: hoursAccessory,
    });
  }

  // Action buttons: Submit + Add Slot (if under max)
  const actionElements: SlackElement[] = [
    {
      type: "button",
      action_id: "submit_hours",
      text: { type: "plain_text", text: "✅ Cargar horas", emoji: true },
      style: "primary",
      value: targetDate,
    },
  ];

  if (effectiveSlotCount < MAX_SLOT_COUNT) {
    actionElements.push({
      type: "button",
      action_id: "add_slot",
      text: { type: "plain_text", text: "➕ Agregar ticket", emoji: true },
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
  jiraConfig: JiraConfig,
  slotCount?: number,
  existingSelections?: ExistingSelection[],
): SlackBlock[] {
  const blocks = buildHoursBreakdown(summary, config.tracking.dailyTarget);

  if (summary.totalHours < config.tracking.dailyTarget) {
    blocks.push(...buildInteractiveSection(summary, config, targetDate, jiraConfig, slotCount, existingSelections));
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
