import { describe, it, expect } from "vitest";
import { aggregateUserHours, aggregateWeeklyHours } from "../../src/services/aggregator.ts";
import { createMockJiraIssue, createMockWorklog } from "../setup.ts";
import type { JiraIssue } from "../../src/types/index.ts";

describe("aggregateUserHours", () => {
  const targetDate = "2026-04-08";
  const accountEmailMap = new Map([
    ["acc-123", "user1@example.com"],
    ["acc-456", "user2@example.com"],
  ]);

  it("returns 0 hours for users with no worklogs", () => {
    const issues: JiraIssue[] = [];
    const result = aggregateUserHours(issues, accountEmailMap, targetDate, ["user1@example.com"]);

    const summary = result.get("user1@example.com");
    expect(summary).toBeDefined();
    expect(summary!.totalHours).toBe(0);
    expect(summary!.workedTickets).toHaveLength(0);
  });

  it("aggregates hours from multiple worklogs on the target date", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        key: "TEST-100",
        worklogs: [
          createMockWorklog({
            started: "2026-04-08T10:00:00.000+0000",
            timeSpentSeconds: 3600, // 1h
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
          createMockWorklog({
            id: "wl-2",
            started: "2026-04-08T14:00:00.000+0000",
            timeSpentSeconds: 7200, // 2h
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateUserHours(issues, accountEmailMap, targetDate, ["user1@example.com"]);

    const summary = result.get("user1@example.com");
    expect(summary).toBeDefined();
    expect(summary!.totalHours).toBe(3);
    expect(summary!.workedTickets).toHaveLength(1);
    expect(summary!.workedTickets[0].hours).toBe(3);
  });

  it("aggregates hours across multiple tickets", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        key: "TEST-100",
        worklogs: [
          createMockWorklog({
            started: "2026-04-08T10:00:00.000+0000",
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
      createMockJiraIssue({
        key: "TEST-200",
        summary: "Another Issue",
        worklogs: [
          createMockWorklog({
            id: "wl-3",
            issueKey: "TEST-200",
            started: "2026-04-08T14:00:00.000+0000",
            timeSpentSeconds: 7200,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateUserHours(issues, accountEmailMap, targetDate, ["user1@example.com"]);

    const summary = result.get("user1@example.com");
    expect(summary!.totalHours).toBe(3);
    expect(summary!.workedTickets).toHaveLength(2);
  });

  it("filters out worklogs from other dates", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        worklogs: [
          createMockWorklog({
            started: "2026-04-07T10:00:00.000+0000", // yesterday
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
          createMockWorklog({
            id: "wl-2",
            started: "2026-04-08T10:00:00.000+0000", // today
            timeSpentSeconds: 7200,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateUserHours(issues, accountEmailMap, targetDate, ["user1@example.com"]);

    const summary = result.get("user1@example.com");
    expect(summary!.totalHours).toBe(2); // Only the 2h from today
  });

  it("pre-populates configured users with 0 hours", () => {
    const issues: JiraIssue[] = [];
    const result = aggregateUserHours(issues, accountEmailMap, targetDate, [
      "user1@example.com",
      "user2@example.com",
    ]);

    expect(result.size).toBe(2);
    expect(result.get("user1@example.com")!.totalHours).toBe(0);
    expect(result.get("user2@example.com")!.totalHours).toBe(0);
  });

  it("dynamically adds unconfigured users found in worklogs", () => {
    const extraMap = new Map([...accountEmailMap, ["acc-789", "external@example.com"]]);

    const issues: JiraIssue[] = [
      createMockJiraIssue({
        worklogs: [
          createMockWorklog({
            started: "2026-04-08T10:00:00.000+0000",
            timeSpentSeconds: 3600,
            authorAccountId: "acc-789",
            authorEmail: "external@example.com",
            authorDisplayName: "External User",
          }),
        ],
      }),
    ];

    const result = aggregateUserHours(issues, extraMap, targetDate, ["user1@example.com"]);

    expect(result.has("external@example.com")).toBe(true);
    expect(result.get("external@example.com")!.totalHours).toBe(1);
  });

  it("resolves email from accountEmailMap when authorEmail is missing", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        worklogs: [
          createMockWorklog({
            started: "2026-04-08T10:00:00.000+0000",
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: undefined, // no email in worklog
          }),
        ],
      }),
    ];

    const result = aggregateUserHours(issues, accountEmailMap, targetDate, ["user1@example.com"]);

    const summary = result.get("user1@example.com");
    expect(summary!.totalHours).toBe(1);
  });
});

describe("aggregateWeeklyHours", () => {
  const accountEmailMap = new Map([["acc-123", "user1@example.com"]]);
  const weekMonday = "2026-04-06";
  const weekFriday = "2026-04-10";

  it("returns breakdown by day (Mon-Fri)", () => {
    const issues: JiraIssue[] = [];
    const result = aggregateWeeklyHours(
      issues,
      accountEmailMap,
      ["user1@example.com"],
      weekMonday,
      weekFriday,
    );

    const breakdown = result.get("user1@example.com");
    expect(breakdown).toBeDefined();
    expect(breakdown!.days).toHaveLength(5);
    expect(breakdown!.days[0].date).toBe("2026-04-06");
    expect(breakdown!.days[4].date).toBe("2026-04-10");
    expect(breakdown!.weekTotal).toBe(0);
  });

  it("accumulates hours per day correctly", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        worklogs: [
          createMockWorklog({
            started: "2026-04-06T10:00:00.000+0000", // Monday
            timeSpentSeconds: 14400, // 4h
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
          createMockWorklog({
            id: "wl-2",
            started: "2026-04-08T10:00:00.000+0000", // Wednesday
            timeSpentSeconds: 28800, // 8h
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateWeeklyHours(
      issues,
      accountEmailMap,
      ["user1@example.com"],
      weekMonday,
      weekFriday,
    );

    const breakdown = result.get("user1@example.com");
    expect(breakdown!.weekTotal).toBe(12);
    expect(breakdown!.days[0].totalHours).toBe(4); // Monday
    expect(breakdown!.days[1].totalHours).toBe(0); // Tuesday
    expect(breakdown!.days[2].totalHours).toBe(8); // Wednesday
  });

  it("ignores worklogs outside the week range", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        worklogs: [
          createMockWorklog({
            started: "2026-04-05T10:00:00.000+0000", // Sunday (before Monday)
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
          createMockWorklog({
            id: "wl-2",
            started: "2026-04-11T10:00:00.000+0000", // Saturday (after Friday)
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateWeeklyHours(
      issues,
      accountEmailMap,
      ["user1@example.com"],
      weekMonday,
      weekFriday,
    );

    const breakdown = result.get("user1@example.com");
    expect(breakdown!.weekTotal).toBe(0);
  });

  it("groups tickets within the same day", () => {
    const issues: JiraIssue[] = [
      createMockJiraIssue({
        key: "TEST-100",
        worklogs: [
          createMockWorklog({
            started: "2026-04-06T10:00:00.000+0000",
            timeSpentSeconds: 3600,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
      createMockJiraIssue({
        key: "TEST-200",
        summary: "Another Issue",
        worklogs: [
          createMockWorklog({
            id: "wl-3",
            issueKey: "TEST-200",
            started: "2026-04-06T14:00:00.000+0000",
            timeSpentSeconds: 7200,
            authorAccountId: "acc-123",
            authorEmail: "user1@example.com",
          }),
        ],
      }),
    ];

    const result = aggregateWeeklyHours(
      issues,
      accountEmailMap,
      ["user1@example.com"],
      weekMonday,
      weekFriday,
    );

    const breakdown = result.get("user1@example.com");
    const monday = breakdown!.days[0];
    expect(monday.totalHours).toBe(3);
    expect(monday.tickets).toHaveLength(2);
  });
});
