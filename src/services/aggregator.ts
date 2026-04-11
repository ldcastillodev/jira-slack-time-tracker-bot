import type {
  JiraIssue,
  UserHoursSummary,
  WeeklyBreakdown,
  ComponentBreakdown,
  WeeklyByComponentBreakdown,
} from "../types/index.ts";

/**
 * Aggregates daily hours. Configured users are pre-loaded (to show 0 hours if inactive),
 * and any other user found in worklogs or as assignees will be added dynamically.
 *
 * @param issues  - All fetched Jira issues (with their worklogs)
 * @param accountEmailMap - Mapping of Jira accountId → email
 * @param targetDate - yyyy-MM-dd string for the day to aggregate
 * @param userEmails - Optional list of emails to pre-populate with 0 hours
 */
export function aggregateUserHours(
  issues: JiraIssue[],
  accountEmailMap: Map<string, string>,
  targetDate: string,
  userEmails?: string[],
): Map<string, UserHoursSummary> {
  const summaries = new Map<string, UserHoursSummary>();
  // Helper: Find the summary of a user or create it if it doesn't exist.
  const getOrCreateSummary = (email: string) => {
    const lowerEmail = email.toLowerCase();
    if (!summaries.has(lowerEmail)) {
      summaries.set(lowerEmail, {
        email: email,
        displayName: email.split(".")[0].charAt(0).toUpperCase() + email.split(".")[0].slice(1),
        totalHours: 0,
        workedTickets: [],
        ticketKeys: [],
      });
    }
    return summaries.get(lowerEmail)!;
  };

  // 1. Pre-populate configured users with 0 hours so they always have an entry
  if (userEmails) {
    for (const email of userEmails) {
      getOrCreateSummary(email);
    }
  }

  // 2. Add data by iterating over the tickets
  for (const issue of issues) {
    // A. Track the assignee of the ticket
    if (issue.assigneeAccountId) {
      const assigneeEmail = accountEmailMap.get(issue.assigneeAccountId);
      if (assigneeEmail) {
        // Create dynamically if not existed in userEmails
        const summary = getOrCreateSummary(assigneeEmail);
        summary.ticketKeys.push({ key: issue.key, summary: issue.summary, hours: 0 });
      }
    }

    // B. Track all users who logged worklogs
    for (const wl of issue.worklogs) {
      // Filter: only worklogs on the target date
      if (!wl.started.startsWith(targetDate)) continue;
      // Find the email of the author (removed emailSet restriction)
      const authorEmail = wl.authorEmail ?? accountEmailMap.get(wl.authorAccountId);
      if (!authorEmail) continue;

      // Find which user this worklog belongs to
      const summary = getOrCreateSummary(authorEmail);
      const hours = wl.timeSpentSeconds / 3600;

      // Find or create the ticket entry
      const existing = summary.workedTickets.find((t) => t.key === issue.key);
      if (existing) {
        existing.hours += hours;
      } else {
        summary.workedTickets.push({
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
 * Configured users are pre-loaded (showing 0 hours if inactive),
 * and any other user found in worklogs within the date range will be added dynamically.
 */
export function aggregateWeeklyHours(
  issues: JiraIssue[],
  accountEmailMap: Map<string, string>,
  userEmails: string[],
  weekMonday: string,
  weekFriday: string,
): Map<string, WeeklyBreakdown> {
  // Build list of weekdays (Monday to Friday)
  const weekDates = getWeekDates(weekMonday, weekFriday);
  const breakdowns = new Map<string, WeeklyBreakdown>();

  // Helper: find the weekly breakdown of a user or initialize it if not exists
  const getOrCreateBreakdown = (email: string, displayName?: string | null) => {
    const lowerEmail = email.toLowerCase();
    if (!breakdowns.has(lowerEmail)) {
      breakdowns.set(lowerEmail, {
        email: email,
        displayName: displayName || email.split("@")[0],
        weekTotal: 0,
        days: weekDates.map((date) => ({
          date,
          totalHours: 0,
          tickets: [],
        })),
      });
    }
    return breakdowns.get(lowerEmail)!;
  };

  // 1. Initialize configured users by default
  for (const email of userEmails) {
    getOrCreateBreakdown(email);
  }

  // 2. Add data by iterating over the tickets and their worklogs
  for (const issue of issues) {
    for (const wl of issue.worklogs) {
      const wlDate = wl.started.substring(0, 10);
      // Filter: only process worklogs that fall within this week
      if (wlDate < weekMonday || wlDate > weekFriday) continue;

      // Find the email of the author (removed emailSet restriction)
      const authorEmail = wl.authorEmail ?? accountEmailMap.get(wl.authorAccountId);
      if (!authorEmail) continue;

      // find the user summary or create it if not exists
      const breakdown = getOrCreateBreakdown(authorEmail, wl.authorDisplayName);
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
        // sum hours if the ticket already exists that day, or add it
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

/**
 * Aggregates the weekly hours of a single user grouped by Jira component.
 * Each worklog is attributed to the FIRST component of its issue.
 * Issues with no components use the label "Sin Componente".
 */
export function aggregateWeeklyHoursByComponent(
  issues: JiraIssue[],
  accountEmailMap: Map<string, string>,
  userEmail: string,
  weekMonday: string,
  weekFriday: string,
): WeeklyByComponentBreakdown {
  const weekDates = getWeekDates(weekMonday, weekFriday);
  const componentMap = new Map<string, ComponentBreakdown>();
  let displayName = userEmail.split("@")[0];

  const getOrCreateComponent = (name: string): ComponentBreakdown => {
    if (!componentMap.has(name)) {
      componentMap.set(name, {
        componentName: name,
        weekTotal: 0,
        days: weekDates.map((date) => ({ date, totalHours: 0, tickets: [] })),
      });
    }
    return componentMap.get(name)!;
  };

  for (const issue of issues) {
    const componentName = issue.components[0] ?? "Sin Componente";

    for (const wl of issue.worklogs) {
      const wlDate = wl.started.substring(0, 10);
      if (wlDate < weekMonday || wlDate > weekFriday) continue;

      const authorEmail = wl.authorEmail ?? accountEmailMap.get(wl.authorAccountId);
      if (!authorEmail || authorEmail.toLowerCase() !== userEmail.toLowerCase()) continue;

      if (wl.authorDisplayName) displayName = wl.authorDisplayName;

      const comp = getOrCreateComponent(componentName);
      const hours = wl.timeSpentSeconds / 3600;
      comp.weekTotal += hours;

      const dayEntry = comp.days.find((d) => d.date === wlDate);
      if (dayEntry) {
        dayEntry.totalHours += hours;
        const existing = dayEntry.tickets.find((t) => t.key === issue.key);
        if (existing) {
          existing.hours += hours;
        } else {
          dayEntry.tickets.push({ key: issue.key, summary: issue.summary, hours });
        }
      }
    }
  }

  return {
    email: userEmail,
    displayName,
    components: Array.from(componentMap.values()),
  };
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
