import { describe, it, expect } from "vitest";
import {
  getTodayET,
  formatDateForJira,
  isFriday,
  getCurrentHourET,
  getWeekBoundaries,
  isSameCalendarWeek,
  toJiraStartedFormat,
  dateStringToEpochMs,
} from "../../src/utils/date.ts";

describe("date utils", () => {
  describe("formatDateForJira", () => {
    it("formats a date as yyyy-MM-dd in ET timezone", () => {
      // Use a known UTC date: 2026-04-08 15:00 UTC = 2026-04-08 11:00 ET
      const date = new Date("2026-04-08T15:00:00Z");
      const result = formatDateForJira(date);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result).toBe("2026-04-08");
    });

    it("handles date boundary correctly (late UTC = next day UTC but same day ET)", () => {
      // 2026-04-08 03:00 UTC = 2026-04-07 23:00 ET (previous day in ET)
      const date = new Date("2026-04-08T03:00:00Z");
      const result = formatDateForJira(date);
      expect(result).toBe("2026-04-07");
    });
  });

  describe("getTodayET", () => {
    it("returns a string in yyyy-MM-dd format", () => {
      const result = getTodayET();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("isFriday", () => {
    it("returns true for a Friday", () => {
      // 2026-04-10 is a Friday
      const friday = new Date("2026-04-10T12:00:00Z");
      expect(isFriday(friday)).toBe(true);
    });

    it("returns false for a non-Friday", () => {
      // 2026-04-08 is a Wednesday
      const wednesday = new Date("2026-04-08T12:00:00Z");
      expect(isFriday(wednesday)).toBe(false);
    });

    it("returns false for a Saturday", () => {
      const saturday = new Date("2026-04-11T12:00:00Z");
      expect(isFriday(saturday)).toBe(false);
    });
  });

  describe("getCurrentHourET", () => {
    it("returns a number between 0 and 23", () => {
      const hour = getCurrentHourET();
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThanOrEqual(23);
    });
  });

  describe("getWeekBoundaries", () => {
    it("returns correct Monday and Friday for a Wednesday", () => {
      // 2026-04-08 is a Wednesday
      const date = new Date("2026-04-08T12:00:00Z");
      const { monday, friday } = getWeekBoundaries(date);
      expect(monday).toBe("2026-04-06");
      expect(friday).toBe("2026-04-10");
    });

    it("returns correct boundaries for a Monday", () => {
      const date = new Date("2026-04-06T12:00:00Z");
      const { monday, friday } = getWeekBoundaries(date);
      expect(monday).toBe("2026-04-06");
      expect(friday).toBe("2026-04-10");
    });

    it("returns correct boundaries for a Friday", () => {
      const date = new Date("2026-04-10T12:00:00Z");
      const { monday, friday } = getWeekBoundaries(date);
      expect(monday).toBe("2026-04-06");
      expect(friday).toBe("2026-04-10");
    });

    it("returns correct boundaries for a Sunday (previous week)", () => {
      // 2026-04-05 is a Sunday → should map to Mon 2026-03-30 .. Fri 2026-04-03
      const date = new Date("2026-04-05T12:00:00Z");
      const { monday, friday } = getWeekBoundaries(date);
      expect(monday).toBe("2026-03-30");
      expect(friday).toBe("2026-04-03");
    });
  });

  describe("isSameCalendarWeek", () => {
    it("returns true for dates in the same ISO week", () => {
      // Mon 2026-04-06 and Fri 2026-04-10 are in the same week
      expect(isSameCalendarWeek("2026-04-06", "2026-04-10")).toBe(true);
    });

    it("returns true for the same date", () => {
      expect(isSameCalendarWeek("2026-04-08", "2026-04-08")).toBe(true);
    });

    it("returns false for dates in different weeks", () => {
      // 2026-04-10 (Fri) and 2026-04-13 (Mon next week)
      expect(isSameCalendarWeek("2026-04-10", "2026-04-13")).toBe(false);
    });

    it("returns true for Monday and Sunday of the same ISO week", () => {
      // ISO week: Mon 2026-04-06 to Sun 2026-04-12
      expect(isSameCalendarWeek("2026-04-06", "2026-04-12")).toBe(true);
    });

    it("returns false across year boundary in different weeks", () => {
      expect(isSameCalendarWeek("2025-12-28", "2026-01-05")).toBe(false);
    });
  });

  describe("toJiraStartedFormat", () => {
    it("converts date string to Jira started format", () => {
      const result = toJiraStartedFormat("2026-04-08");
      expect(result).toBe("2026-04-08T12:00:00.000+0000");
    });
  });

  describe("dateStringToEpochMs", () => {
    it("converts date string to epoch milliseconds", () => {
      const result = dateStringToEpochMs("2026-04-08");
      expect(result).toBe(new Date("2026-04-08T00:00:00Z").getTime());
    });
  });
});
