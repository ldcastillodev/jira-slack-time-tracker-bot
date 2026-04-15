import { Injectable } from "@nestjs/common";
import type {
  JiraTicket,
  UserHoursSummary,
  WeeklyBreakdown,
  ComponentBreakdown,
  WeeklyByComponentBreakdown,
} from "../common/types/index.ts";

@Injectable()
export class AggregatorService {
  aggregateUserHours(
    tickets: JiraTicket[],
    accountEmailMap: Map<string, string>,
    targetDate: string,
    userEmails?: string[],
  ): Map<string, UserHoursSummary> {
    const summaries = new Map<string, UserHoursSummary>();

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

    if (userEmails) {
      for (const email of userEmails) {
        getOrCreateSummary(email);
      }
    }

    for (const ticket of tickets) {
      if (ticket.assigneeAccountId) {
        const assigneeEmail = accountEmailMap.get(ticket.assigneeAccountId);
        if (assigneeEmail) {
          const summary = getOrCreateSummary(assigneeEmail);
          summary.ticketKeys.push({ key: ticket.key, summary: ticket.summary, hours: 0 });
        }
      }

      for (const wl of ticket.worklogs) {
        if (!wl.started.startsWith(targetDate)) continue;
        const authorEmail = wl.authorEmail ?? accountEmailMap.get(wl.authorAccountId);
        if (!authorEmail) continue;

        const summary = getOrCreateSummary(authorEmail);
        const hours = wl.timeSpentSeconds / 3600;

        const existing = summary.workedTickets.find((t) => t.key === ticket.key);
        if (existing) {
          existing.hours += hours;
        } else {
          summary.workedTickets.push({
            key: ticket.key,
            summary: ticket.summary,
            hours,
          });
        }

        if (wl.authorDisplayName && summary.displayName === summary.email.split("@")[0]) {
          summary.displayName = wl.authorDisplayName;
        }

        summary.totalHours += hours;
      }
    }

    return summaries;
  }

  aggregateWeeklyHours(
    tickets: JiraTicket[],
    accountEmailMap: Map<string, string>,
    userEmails: string[],
    weekMonday: string,
    weekFriday: string,
  ): Map<string, WeeklyBreakdown> {
    const weekDates = this.getWeekDates(weekMonday, weekFriday);
    const breakdowns = new Map<string, WeeklyBreakdown>();

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

    for (const email of userEmails) {
      getOrCreateBreakdown(email);
    }

    for (const ticket of tickets) {
      for (const wl of ticket.worklogs) {
        const wlDate = wl.started.substring(0, 10);
        if (wlDate < weekMonday || wlDate > weekFriday) continue;

        const authorEmail = wl.authorEmail ?? accountEmailMap.get(wl.authorAccountId);
        if (!authorEmail) continue;

        const breakdown = getOrCreateBreakdown(authorEmail, wl.authorDisplayName);
        const hours = wl.timeSpentSeconds / 3600;
        breakdown.weekTotal += hours;

        if (wl.authorDisplayName && breakdown.displayName === breakdown.email.split("@")[0]) {
          breakdown.displayName = wl.authorDisplayName;
        }

        const dayEntry = breakdown.days.find((d) => d.date === wlDate);
        if (dayEntry) {
          dayEntry.totalHours += hours;
          const existing = dayEntry.tickets.find((t) => t.key === ticket.key);
          if (existing) {
            existing.hours += hours;
          } else {
            dayEntry.tickets.push({
              key: ticket.key,
              summary: ticket.summary,
              hours,
            });
          }
        }
      }
    }

    return breakdowns;
  }

  aggregateWeeklyHoursByComponent(
    tickets: JiraTicket[],
    accountEmailMap: Map<string, string>,
    userEmail: string,
    weekMonday: string,
    weekFriday: string,
  ): WeeklyByComponentBreakdown {
    const weekDates = this.getWeekDates(weekMonday, weekFriday);
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

    for (const ticket of tickets) {
      const componentName = ticket.components[0] ?? "Sin Componente";

      for (const wl of ticket.worklogs) {
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
          const existing = dayEntry.tickets.find((t) => t.key === ticket.key);
          if (existing) {
            existing.hours += hours;
          } else {
            dayEntry.tickets.push({ key: ticket.key, summary: ticket.summary, hours });
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

  private getWeekDates(monday: string, friday: string): string[] {
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
}
