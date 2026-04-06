import type { TrackerConfig } from "./types/index.ts";
import rawConfig from "../config/tracker-config.json";

export function loadConfig(): TrackerConfig {
  const cfg = rawConfig as TrackerConfig;

  if (cfg.tracking.dailyTarget <= 0 || cfg.tracking.weeklyTarget <= 0) {
    throw new Error("Config: tracking targets must be positive numbers");
  }

  return cfg;
}
