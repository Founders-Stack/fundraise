import { describe, expect, it } from "vitest";
import {
  nextPeriod,
  parsePeriodLabel,
  periodContaining,
  periodToReport,
  periodsPerYear,
  recordDateAfter,
  type ReportingPeriod,
} from "./index";
import type { DistributionFrequency } from "../rights/terms";

const iso = (p: ReportingPeriod) => [p.label, p.recordDate.toISOString()];

function walk(from: string, frequency: DistributionFrequency, n: number) {
  let p = periodContaining(new Date(from), frequency);
  const out = [iso(p)];
  for (let i = 0; i < n; i++) {
    p = nextPeriod(p);
    out.push(iso(p));
  }
  return out;
}

describe("reporting calendar", () => {
  it("walks quarters from a Q1 launch without drifting", () => {
    expect(walk("2026-02-10T12:00:00Z", "QUARTERLY", 4)).toEqual([
      ["2026-Q1", "2026-03-31T23:59:59.999Z"],
      ["2026-Q2", "2026-06-30T23:59:59.999Z"],
      ["2026-Q3", "2026-09-30T23:59:59.999Z"],
      ["2026-Q4", "2026-12-31T23:59:59.999Z"],
      ["2027-Q1", "2027-03-31T23:59:59.999Z"],
    ]);
  });

  it("walks quarters from a Q3 launch (Dec 31, not Dec 30)", () => {
    expect(walk("2026-08-10T00:00:00Z", "QUARTERLY", 2)).toEqual([
      ["2026-Q3", "2026-09-30T23:59:59.999Z"],
      ["2026-Q4", "2026-12-31T23:59:59.999Z"],
      ["2027-Q1", "2027-03-31T23:59:59.999Z"],
    ]);
  });

  it("walks months through February, including a leap year", () => {
    expect(walk("2028-01-31T23:00:00Z", "MONTHLY", 2)).toEqual([
      ["2028-01", "2028-01-31T23:59:59.999Z"],
      ["2028-02", "2028-02-29T23:59:59.999Z"],
      ["2028-03", "2028-03-31T23:59:59.999Z"],
    ]);
    expect(walk("2026-01-15T00:00:00Z", "MONTHLY", 1)[1]).toEqual(["2026-02", "2026-02-28T23:59:59.999Z"]);
  });

  it("puts period boundaries at the first and last millisecond", () => {
    const q3 = periodContaining(new Date("2026-09-30T23:59:59.999Z"), "QUARTERLY");
    expect(q3.label).toBe("2026-Q3");
    expect(q3.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(periodContaining(new Date("2026-10-01T00:00:00.000Z"), "QUARTERLY").label).toBe("2026-Q4");
    expect(periodContaining(q3.recordDate, "QUARTERLY")).toEqual(q3);
  });

  it("parses canonical labels per frequency", () => {
    expect(parsePeriodLabel("2026-Q3", "QUARTERLY")?.recordDate.toISOString()).toBe("2026-09-30T23:59:59.999Z");
    expect(parsePeriodLabel(" 2026-q4 ", "QUARTERLY")?.label).toBe("2026-Q4");
    expect(parsePeriodLabel("2026-09", "MONTHLY")?.recordDate.toISOString()).toBe("2026-09-30T23:59:59.999Z");
    for (const bad of ["2026-Q5", "2026-Q0", "Q3 2026", "2026-09", "x"]) {
      expect(parsePeriodLabel(bad, "QUARTERLY"), bad).toBeNull();
    }
    for (const bad of ["2026-13", "2026-00", "2026-9", "2026-Q3"]) {
      expect(parsePeriodLabel(bad, "MONTHLY"), bad).toBeNull();
    }
  });

  it("knows periods per year and rejects unknown frequencies", () => {
    expect(periodsPerYear("QUARTERLY")).toBe(4);
    expect(periodsPerYear("MONTHLY")).toBe(12);
    expect(() => periodsPerYear("WEEKLY" as DistributionFrequency)).toThrow(RangeError);
  });

  it("tells which period is reported next and advances the record date after a distribution", () => {
    const now = new Date("2026-09-24T10:00:00Z");
    expect(periodToReport(null, "QUARTERLY", now).label).toBe("2026-Q3");
    const q3End = new Date("2026-09-30T23:59:59.999Z");
    expect(periodToReport(q3End, "QUARTERLY", now).label).toBe("2026-Q3");

    const q3 = parsePeriodLabel("2026-Q3", "QUARTERLY")!;
    expect(recordDateAfter(q3, q3End).toISOString()).toBe("2026-12-31T23:59:59.999Z");
    // Distributing an older period never moves the record date backwards.
    const q4End = new Date("2026-12-31T23:59:59.999Z");
    expect(recordDateAfter(parsePeriodLabel("2026-Q2", "QUARTERLY")!, q4End)).toBe(q4End);
    expect(recordDateAfter(q3, null).toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });
});
