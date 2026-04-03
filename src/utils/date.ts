const ET_TIMEZONE = "America/New_York";

/** Returns today's date string (yyyy-MM-dd) in ET timezone. */
export function getTodayET(): string {
  return formatDateForJira(new Date());
}

/** Formats a Date to yyyy-MM-dd in ET timezone. */
export function formatDateForJira(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** Returns true if the given date (interpreted in ET) is a Friday. */
export function isFriday(date: Date): boolean {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    weekday: "short",
  }).format(date);
  return dayName === "Fri";
}

/** Returns the current hour (0-23) in ET timezone. */
export function getCurrentHourET(): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return parseInt(hourStr, 10);
}

/**
 * Returns the Monday 00:00 and Friday 23:59:59 of the current week in ET,
 * as yyyy-MM-dd strings.
 */
export function getWeekBoundaries(date: Date): { monday: string; friday: string } {
  const etDateStr = formatDateForJira(date);
  const [y, m, d] = etDateStr.split("-").map(Number);
  const localDate = new Date(y, m - 1, d);

  const dayOfWeek = localDate.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(localDate);
  monday.setDate(localDate.getDate() - diffToMon);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  return {
    monday: fmtLocal(monday),
    friday: fmtLocal(friday),
  };
}

/** Formats a local Date as yyyy-MM-dd without timezone conversion. */
function fmtLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns an ISO 8601 string for the Jira worklog `started` field.
 * Uses 12:00:00 noon on the given date in ET.
 */
export function toJiraStartedFormat(dateStr: string): string {
  return `${dateStr}T12:00:00.000+0000`;
}

/** Parses a yyyy-MM-dd string into epoch millis (midnight UTC). */
export function dateStringToEpochMs(dateStr: string): number {
  return new Date(dateStr + "T00:00:00Z").getTime();
}

/**
 * Returns true if two yyyy-MM-dd date strings fall within the same
 * ISO calendar week (Monday–Sunday).
 */
export function isSameCalendarWeek(dateA: string, dateB: string): boolean {
  const getISOWeek = (str: string): { year: number; week: number } => {
    const [y, m, d] = str.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    // Adjust to nearest Thursday (ISO week algorithm)
    const dayOfWeek = date.getUTCDay() || 7; // Mon=1 … Sun=7
    date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return { year: date.getUTCFullYear(), week };
  };

  const a = getISOWeek(dateA);
  const b = getISOWeek(dateB);
  return a.year === b.year && a.week === b.week;
}
