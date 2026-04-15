import { describe, it, expect } from "vitest";
import { MessageBuilderService } from "../../src/builders/message-builder.service.ts";
import type {
  UserHoursSummary,
  WeeklyBreakdown,
  WeeklyByComponentBreakdown,
  TrackerConfig,
  JiraConfig,
} from "../../src/common/types/index.ts";

const builder = new MessageBuilderService();

const config: TrackerConfig = {
  tracking: {
    dailyTarget: 8,
    weeklyTarget: 40,
    timezone: "America/New_York",
    cronHourET: 16,
  },
};

const jiraConfig: JiraConfig = {
  jira: {
    boards: ["TEST"],
    genericTickets: [{ key: "TEST-1", summary: "Generic" }],
    projectComponents: [{ name: "Component1" }],
  },
};

describe("buildDailyMessage", () => {
  it("includes interactive section when under daily target (Scenario A)", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 4,
      workedTickets: [{ key: "TEST-100", summary: "Test", hours: 4 }],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig);

    // Should have header, greeting, divider, breakdown, then interactive section
    expect(blocks.length).toBeGreaterThan(5);

    // Should contain submit button
    const actionsBlock = blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.elements).toBeDefined();

    const submitBtn = actionsBlock!.elements!.find((e) => e.action_id === "submit_hours");
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.value).toBe("2026-04-08");
  });

  it("does NOT include interactive section when at daily target (Scenario B)", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 8,
      workedTickets: [{ key: "TEST-100", summary: "Test", hours: 8 }],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig);

    const actionsBlock = blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeUndefined();
  });

  it("does NOT include interactive section when OVER daily target", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 9,
      workedTickets: [{ key: "TEST-100", summary: "Test", hours: 9 }],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig);

    const actionsBlock = blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeUndefined();
  });

  it("renders the correct number of slots", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 2,
      workedTickets: [],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig, 5);

    // Count ticket_block_N sections
    const ticketBlocks = blocks.filter((b) => b.block_id && b.block_id.startsWith("ticket_block_"));
    expect(ticketBlocks).toHaveLength(5);
  });

  it("preserves existing selections when provided", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 2,
      workedTickets: [],
      ticketKeys: [],
    };

    const existingSelections = [
      {
        ticketOption: {
          text: { type: "plain_text" as const, text: "TEST-100 - Test" },
          value: "TEST-100",
        },
        hoursOption: {
          text: { type: "plain_text" as const, text: "2.0h" },
          value: "2.0",
        },
      },
    ];

    const blocks = builder.buildDailyMessage(
      summary,
      config,
      "2026-04-08",
      jiraConfig,
      3,
      existingSelections,
    );

    // First ticket block should have initial_option set
    const ticketBlock = blocks.find((b) => b.block_id === "ticket_block_0");
    expect(ticketBlock).toBeDefined();
    expect(ticketBlock!.accessory?.initial_option?.value).toBe("TEST-100");
  });

  it("shows user greeting with first name", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "Carlos Castillo",
      totalHours: 0,
      workedTickets: [],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig);

    const greetingBlock = blocks.find(
      (b) => b.text?.type === "mrkdwn" && b.text.text.includes("Hola"),
    );
    expect(greetingBlock).toBeDefined();
    expect(greetingBlock!.text!.text).toContain("Carlos");
  });

  it("shows ticket breakdown when worklogs exist", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 4,
      workedTickets: [
        { key: "TEST-100", summary: "Feature A", hours: 2 },
        { key: "TEST-200", summary: "Feature B", hours: 2 },
      ],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-08", jiraConfig);

    const breakdownBlock = blocks.find((b) => b.text?.text?.includes("TEST-100"));
    expect(breakdownBlock).toBeDefined();
    expect(breakdownBlock!.text!.text).toContain("TEST-200");
  });
});

describe("buildWeeklyMessage", () => {
  it("renders weekly summary with status", () => {
    const weekly: WeeklyBreakdown = {
      email: "user1@example.com",
      displayName: "User One",
      weekTotal: 32,
      days: [
        { date: "2026-04-06", totalHours: 8, tickets: [] },
        { date: "2026-04-07", totalHours: 8, tickets: [] },
        { date: "2026-04-08", totalHours: 8, tickets: [] },
        { date: "2026-04-09", totalHours: 8, tickets: [] },
        { date: "2026-04-10", totalHours: 0, tickets: [] },
      ],
    };

    const blocks = builder.buildWeeklyMessage(weekly, config);

    expect(blocks.length).toBeGreaterThan(0);

    // Should have header
    const header = blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();
    expect(header!.text!.text).toContain("Semanal");

    // Should show the weekly total
    const statusBlock = blocks.find((b) => b.text?.text?.includes("32.0h"));
    expect(statusBlock).toBeDefined();
  });

  it("shows complete status when weekly target is met", () => {
    const weekly: WeeklyBreakdown = {
      email: "user1@example.com",
      displayName: "User One",
      weekTotal: 40,
      days: [
        { date: "2026-04-06", totalHours: 8, tickets: [] },
        { date: "2026-04-07", totalHours: 8, tickets: [] },
        { date: "2026-04-08", totalHours: 8, tickets: [] },
        { date: "2026-04-09", totalHours: 8, tickets: [] },
        { date: "2026-04-10", totalHours: 8, tickets: [] },
      ],
    };

    const blocks = builder.buildWeeklyMessage(weekly, config);

    const statusBlock = blocks.find((b) => b.text?.text?.includes("✅"));
    expect(statusBlock).toBeDefined();
  });
});

describe("buildConfirmationMessage", () => {
  it("shows success message with logged entries", () => {
    const entries = [
      { ticketKey: "TEST-100", hours: 2 },
      { ticketKey: "TEST-200", hours: 3 },
    ];
    const updatedSummary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 7,
      workedTickets: [
        { key: "TEST-100", summary: "Feature A", hours: 4 },
        { key: "TEST-200", summary: "Feature B", hours: 3 },
      ],
      ticketKeys: [],
    };

    const blocks = builder.buildConfirmationMessage(entries, updatedSummary, 8);

    expect(blocks.length).toBeGreaterThan(0);

    const confirmBlock = blocks.find((b) => b.text?.text?.includes("exitosamente"));
    expect(confirmBlock).toBeDefined();
    expect(confirmBlock!.text!.text).toContain("TEST-100");
    expect(confirmBlock!.text!.text).toContain("TEST-200");
  });

  it("includes remaining hours notice when under daily target", () => {
    const entries = [{ ticketKey: "TEST-100", hours: 2 }];
    const updatedSummary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 5,
      workedTickets: [{ key: "TEST-100", summary: "Feature A", hours: 5 }],
      ticketKeys: [],
    };

    const blocks = builder.buildConfirmationMessage(entries, updatedSummary, 8);

    const remainingBlock = blocks.find((b) => b.text?.text?.includes("3.0h"));
    expect(remainingBlock).toBeDefined();
  });

  it("does not show remaining hours when at daily target", () => {
    const entries = [{ ticketKey: "TEST-100", hours: 4 }];
    const updatedSummary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 8,
      workedTickets: [{ key: "TEST-100", summary: "Feature A", hours: 8 }],
      ticketKeys: [],
    };

    const blocks = builder.buildConfirmationMessage(entries, updatedSummary, 8);

    const remainingBlock = blocks.find((b) => b.text?.text?.includes("Aún te faltan"));
    expect(remainingBlock).toBeUndefined();
  });
});

describe("buildDailyMessage with dateLabel", () => {
  it("includes the date label in the greeting block when provided", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 4,
      workedTickets: [],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(
      summary,
      config,
      "2026-04-09",
      jiraConfig,
      undefined,
      undefined,
      "jueves 9 de abril de 2026",
    );

    const greetingBlock = blocks.find(
      (b) => b.text?.type === "mrkdwn" && b.text.text.includes("Hola"),
    );
    expect(greetingBlock).toBeDefined();
    expect(greetingBlock!.text!.text).toContain("jueves 9 de abril de 2026");
    expect(greetingBlock!.text!.text).toContain("📅");
  });

  it("does NOT include the date label when not provided", () => {
    const summary: UserHoursSummary = {
      email: "user1@example.com",
      displayName: "User One",
      totalHours: 4,
      workedTickets: [],
      ticketKeys: [],
    };

    const blocks = builder.buildDailyMessage(summary, config, "2026-04-09", jiraConfig);

    const greetingBlock = blocks.find(
      (b) => b.text?.type === "mrkdwn" && b.text.text.includes("Hola"),
    );
    expect(greetingBlock).toBeDefined();
    expect(greetingBlock!.text!.text).not.toContain("📅");
  });
});

describe("buildWeeklyByComponentMessage", () => {
  const weekMonday = "2026-04-06";
  const weekFriday = "2026-04-10";

  it("renders header and greeting with week range", () => {
    const breakdown: WeeklyByComponentBreakdown = {
      email: "user1@example.com",
      displayName: "Juan Pérez",
      components: [],
    };

    const blocks = builder.buildWeeklyByComponentMessage(breakdown, config, weekMonday, weekFriday);

    const header = blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();
    expect(header!.text!.text).toContain("Componente");

    const greeting = blocks.find((b) => b.text?.text?.includes("Juan Pérez"));
    expect(greeting).toBeDefined();
    expect(greeting!.text!.text).toContain(weekMonday);
    expect(greeting!.text!.text).toContain(weekFriday);
  });

  it("shows empty message when no components have hours", () => {
    const breakdown: WeeklyByComponentBreakdown = {
      email: "user1@example.com",
      displayName: "Juan Pérez",
      components: [],
    };

    const blocks = builder.buildWeeklyByComponentMessage(breakdown, config, weekMonday, weekFriday);

    const emptyBlock = blocks.find((b) => b.text?.text?.includes("No hay horas"));
    expect(emptyBlock).toBeDefined();
  });

  it("renders each component with its total hours", () => {
    const breakdown: WeeklyByComponentBreakdown = {
      email: "user1@example.com",
      displayName: "Juan Pérez",
      components: [
        {
          componentName: "Backend",
          weekTotal: 5,
          days: [
            {
              date: "2026-04-06",
              totalHours: 5,
              tickets: [{ key: "PROJ-1", summary: "Fix", hours: 5 }],
            },
            { date: "2026-04-07", totalHours: 0, tickets: [] },
            { date: "2026-04-08", totalHours: 0, tickets: [] },
            { date: "2026-04-09", totalHours: 0, tickets: [] },
            { date: "2026-04-10", totalHours: 0, tickets: [] },
          ],
        },
        {
          componentName: "Frontend",
          weekTotal: 3,
          days: [
            { date: "2026-04-06", totalHours: 0, tickets: [] },
            {
              date: "2026-04-07",
              totalHours: 3,
              tickets: [{ key: "PROJ-2", summary: "UI fix", hours: 3 }],
            },
            { date: "2026-04-08", totalHours: 0, tickets: [] },
            { date: "2026-04-09", totalHours: 0, tickets: [] },
            { date: "2026-04-10", totalHours: 0, tickets: [] },
          ],
        },
      ],
    };

    const blocks = builder.buildWeeklyByComponentMessage(breakdown, config, weekMonday, weekFriday);

    const backendBlock = blocks.find((b) => b.text?.text?.includes("Backend"));
    expect(backendBlock).toBeDefined();
    expect(backendBlock!.text!.text).toContain("5.0h");

    const frontendBlock = blocks.find((b) => b.text?.text?.includes("Frontend"));
    expect(frontendBlock).toBeDefined();
    expect(frontendBlock!.text!.text).toContain("3.0h");
  });

  it("shows ticket keys in the day breakdown", () => {
    const breakdown: WeeklyByComponentBreakdown = {
      email: "user1@example.com",
      displayName: "Juan Pérez",
      components: [
        {
          componentName: "Backend",
          weekTotal: 4,
          days: [
            {
              date: "2026-04-06",
              totalHours: 4,
              tickets: [{ key: "PROJ-123", summary: "Auth feature", hours: 4 }],
            },
            { date: "2026-04-07", totalHours: 0, tickets: [] },
            { date: "2026-04-08", totalHours: 0, tickets: [] },
            { date: "2026-04-09", totalHours: 0, tickets: [] },
            { date: "2026-04-10", totalHours: 0, tickets: [] },
          ],
        },
      ],
    };

    const blocks = builder.buildWeeklyByComponentMessage(breakdown, config, weekMonday, weekFriday);

    const dayBlock = blocks.find((b) => b.text?.text?.includes("PROJ-123"));
    expect(dayBlock).toBeDefined();
    expect(dayBlock!.text!.text).toContain("Auth feature");
  });

  it("skips days with 0 hours in the component breakdown", () => {
    const breakdown: WeeklyByComponentBreakdown = {
      email: "user1@example.com",
      displayName: "Juan Pérez",
      components: [
        {
          componentName: "Backend",
          weekTotal: 2,
          days: [
            {
              date: "2026-04-06",
              totalHours: 2,
              tickets: [{ key: "PROJ-1", summary: "Work", hours: 2 }],
            },
            { date: "2026-04-07", totalHours: 0, tickets: [] },
            { date: "2026-04-08", totalHours: 0, tickets: [] },
            { date: "2026-04-09", totalHours: 0, tickets: [] },
            { date: "2026-04-10", totalHours: 0, tickets: [] },
          ],
        },
      ],
    };

    const blocks = builder.buildWeeklyByComponentMessage(breakdown, config, weekMonday, weekFriday);

    // Only one day has hours, so only that day should appear in the breakdown
    const dayBlock = blocks.find((b) => b.text?.text?.includes("2026-04-07"));
    expect(dayBlock).toBeUndefined();
  });
});

describe("buildHelpMessage", () => {
  it("returns a non-empty SlackBlock array", () => {
    const blocks = builder.buildHelpMessage();
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("first block is a header containing 'Ayuda'", () => {
    const blocks = builder.buildHelpMessage();
    expect(blocks[0].type).toBe("header");
    expect(blocks[0].text?.text).toContain("Ayuda");
  });

  it("contains a divider block", () => {
    const blocks = builder.buildHelpMessage();
    expect(blocks.some((b) => b.type === "divider")).toBe(true);
  });

  it("lists all 5 command names", () => {
    const blocks = builder.buildHelpMessage();
    const allText = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(allText).toContain("/summary");
    expect(allText).toContain("/summary-components");
    expect(allText).toContain("/submit");
    expect(allText).toContain("/refresh-tickets");
    expect(allText).toContain("/help");
  });

  it("command listing block uses mrkdwn type", () => {
    const blocks = builder.buildHelpMessage();
    const commandBlock = blocks.find(
      (b) => b.type === "section" && b.text?.type === "mrkdwn" && b.text.text.includes("/summary"),
    );
    expect(commandBlock).toBeDefined();
    expect(commandBlock!.text!.type).toBe("mrkdwn");
  });

  it("is deterministic — identical output on each call", () => {
    expect(JSON.stringify(builder.buildHelpMessage())).toBe(
      JSON.stringify(builder.buildHelpMessage()),
    );
  });
});
