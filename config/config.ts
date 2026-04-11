import type { TrackerConfig } from "../src/types/index.ts";
import rawConfig from "./tracker-config.json";

export function loadConfig(): TrackerConfig {
  const cfg = rawConfig as TrackerConfig;

  if (cfg.tracking.dailyTarget <= 0 || cfg.tracking.weeklyTarget <= 0) {
    throw new Error("Config: tracking targets must be positive numbers");
  }

  return cfg;
}
