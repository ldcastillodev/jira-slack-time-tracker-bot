import type { JiraConfig } from "../src/types/index.ts";

export const JIRA_CONFIG: JiraConfig = {
  jira: {
    boards: ["MP"],
    genericTickets: [
      { key: "MP-2126", summary: "[MgS-Hours] Others MgS" },
      { key: "MP-2980", summary: "[MgS-Hours] Others Apply hours" },
    ],
    projectComponents: [
      { name: "Tishman Studio" },
      { name: "MgS-Black & Veatch" },
      { name: "MgS-Star Trek" },
      { name: "Tishman-Corporate" },
      { name: "MgS-TORQ" },
      { name: "MgS-Alltech" },
      { name: "MgS-CSG" },
      { name: "MgS-Marketing" },
      { name: "MgS-Parkland" },
      { name: "MgS-Select Quote" },
      { name: "MgS-TBD" },
      { name: "MgS-Banistmo" },
      { name: "MgS Hours - Others MgS (NB)" },
      { name: "MgS Hours - Others Apply (NB)" },
    ],
  },
};
