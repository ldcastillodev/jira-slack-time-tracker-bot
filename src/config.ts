import type { TrackerConfig } from "./types/index.ts";
import rawConfig from "../config/tracker-config.json";

export function loadConfig(): TrackerConfig {
  const cfg = rawConfig as TrackerConfig;

  if (!cfg.jira.boards.length) {
    throw new Error("Config: jira.boards must contain at least one board key");
  }
  if (!cfg.users.length) {
    throw new Error("Config: users must contain at least one email");
  }
  if (cfg.tracking.dailyTarget <= 0 || cfg.tracking.weeklyTarget <= 0) {
    throw new Error("Config: tracking targets must be positive numbers");
  }

  return cfg;
}
