import type {
  JiraIssue,
  JiraWorklog,
  UserHoursSummary,
  TicketHours,
  WeeklyBreakdown,
  DailyBreakdown,
} from "../types/index.ts";
import { formatDateForJira } from "../utils/date.ts";

/**
 * Aggregates daily hours for each configured user from the given issues/worklogs.
 *
 * @param issues  - All fetched Jira issues (with their worklogs)
 * @param accountEmailMap - Mapping of Jira accountId → email
 * @param userEmails - The configured user emails to aggregate for
 * @param targetDate - yyyy-MM-dd string for the day to aggregate
 */
export function aggregateUserHours(
  issues: JiraIssue[],
  accountEmailMap: Map<string, string>,
  userEmails: string[],
  targetDate: string
): Map<string, UserHoursSummary> {
  const emailSet = new Set(userEmails.map((e) => e.toLowerCase()));

  // Reverse map: email → accountIds (a user may have multiple accounts, unlikely but safe)
  const emailToAccountIds = new Map<string, Set<string>>();
  for (const [accId, email] of accountEmailMap) {
    const lower = email.toLowerCase();
    if (!emailToAccountIds.has(lower)) emailToAccountIds.set(lower, new Set());
    emailToAccountIds.get(lower)!.add(accId);
  }

  // Initialize summaries for all configured users
  const summaries = new Map<string, UserHoursSummary>();
  for (const email of userEmails) {
    summaries.set(email.toLowerCase(), {
      email,
      displayName: email.split("@")[0],
      totalHours: 0,
      tickets: [],
      assignedTicketKeys: [],
    });
  }

  // Aggregate worklogs
  for (const issue of issues) {
    // Track assigned tickets per user
    if (issue.assigneeAccountId) {
      const assigneeEmail = accountEmailMap.get(issue.assigneeAccountId)?.toLowerCase();
      if (assigneeEmail && summaries.has(assigneeEmail)) {
        summaries.get(assigneeEmail)!.assignedTicketKeys.push(issue.key);
      }
    }

    for (const wl of issue.worklogs) {
      // Filter: only worklogs on the target date
      if (!wl.started.startsWith(targetDate)) continue;

      // Find which user this worklog belongs to
      const authorEmail =
        wl.authorEmail?.toLowerCase() ?? accountEmailMap.get(wl.authorAccountId)?.toLowerCase();
      if (!authorEmail || !emailSet.has(authorEmail)) continue;

      const summary = summaries.get(authorEmail)!;
      const hours = wl.timeSpentSeconds / 3600;

      // Find or create the ticket entry
      const existing = summary.tickets.find((t) => t.key === issue.key);
      if (existing) {
        existing.hours += hours;
      } else {
        summary.tickets.push({
          key: issue.key,
          summary: issue.summary,
          hours,
        });
      }

      // Update display name if we have a better one
      if (wl.authorDisplayName && summary.displayName === summary.email.split("@")[0]) {
        summary.displayName = wl.authorDisplayName;
      }

      summary.totalHours += hours;
    }
  }

  return summaries;
}

/**
 * Aggregates weekly hours for each configured user.
 * Returns per-user breakdown by day (Monday through Friday).
 */
export function aggregateWeeklyHours(
  issues: JiraIssue[],
  accountEmailMap: Map<string, string>,
  userEmails: string[],
  weekMonday: string,
  weekFriday: string
): Map<string, WeeklyBreakdown> {
  const emailSet = new Set(userEmails.map((e) => e.toLowerCase()));

  // Build list of weekdays (Monday to Friday)
  const weekDates = getWeekDates(weekMonday, weekFriday);

  // Initialize weekly breakdowns
  const breakdowns = new Map<string, WeeklyBreakdown>();
  for (const email of userEmails) {
    breakdowns.set(email.toLowerCase(), {
      email,
      displayName: email.split("@")[0],
      weekTotal: 0,
      days: weekDates.map((date) => ({
        date,
        totalHours: 0,
        tickets: [],
      })),
    });
  }

  for (const issue of issues) {
    for (const wl of issue.worklogs) {
      const wlDate = wl.started.substring(0, 10); // yyyy-MM-dd
      if (wlDate < weekMonday || wlDate > weekFriday) continue;

      const authorEmail =
        wl.authorEmail?.toLowerCase() ?? accountEmailMap.get(wl.authorAccountId)?.toLowerCase();
      if (!authorEmail || !emailSet.has(authorEmail)) continue;

      const breakdown = breakdowns.get(authorEmail)!;
      const hours = wl.timeSpentSeconds / 3600;
      breakdown.weekTotal += hours;

      // Update display name
      if (wl.authorDisplayName && breakdown.displayName === breakdown.email.split("@")[0]) {
        breakdown.displayName = wl.authorDisplayName;
      }

      // Find the day entry
      const dayEntry = breakdown.days.find((d) => d.date === wlDate);
      if (dayEntry) {
        dayEntry.totalHours += hours;
        const existing = dayEntry.tickets.find((t) => t.key === issue.key);
        if (existing) {
          existing.hours += hours;
        } else {
          dayEntry.tickets.push({
            key: issue.key,
            summary: issue.summary,
            hours,
          });
        }
      }
    }
  }

  return breakdowns;
}

/** Generates a list of date strings from monday to friday. */
function getWeekDates(monday: string, friday: string): string[] {
  const dates: string[] = [];
  const [y, m, d] = monday.split("-").map(Number);
  const start = new Date(y, m - 1, d);

  for (let i = 0; i < 5; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    dates.push(ds);
    if (ds === friday) break;
  }

  return dates;
}
