// Reporting calendar (SPEC R3): which period a date falls in, its canonical label and its
// record date. The only place period boundaries are computed. Pure, all dates UTC.
import type { DistributionFrequency } from "../rights/terms";

export interface ReportingPeriod {
  frequency: DistributionFrequency;
  /** Canonical label: "2026-Q3" (quarterly) or "2026-09" (monthly). */
  label: string;
  /** First millisecond of the period. */
  start: Date;
  /** Record date: the last millisecond of the period. */
  recordDate: Date;
}

const MONTHS_PER_PERIOD: Record<DistributionFrequency, number> = { QUARTERLY: 3, MONTHLY: 1 };

function monthsPerPeriod(frequency: DistributionFrequency): number {
  const m = MONTHS_PER_PERIOD[frequency];
  if (!m) throw new RangeError(`distributionFrequency must be QUARTERLY or MONTHLY, got ${String(frequency)}`);
  return m;
}

export function periodsPerYear(frequency: DistributionFrequency): number {
  return 12 / monthsPerPeriod(frequency);
}

/** Period `index` (0-based) of `year`. */
function periodAt(frequency: DistributionFrequency, year: number, index: number): ReportingPeriod {
  const months = monthsPerPeriod(frequency);
  const startMonth = index * months;
  const label = frequency === "QUARTERLY" ? `${year}-Q${index + 1}` : `${year}-${String(index + 1).padStart(2, "0")}`;
  return {
    frequency,
    label,
    start: new Date(Date.UTC(year, startMonth, 1)),
    recordDate: new Date(Date.UTC(year, startMonth + months, 1) - 1),
  };
}

export function periodContaining(date: Date, frequency: DistributionFrequency): ReportingPeriod {
  return periodAt(frequency, date.getUTCFullYear(), Math.floor(date.getUTCMonth() / monthsPerPeriod(frequency)));
}

export function nextPeriod(period: ReportingPeriod): ReportingPeriod {
  return periodContaining(new Date(period.recordDate.getTime() + 1), period.frequency);
}

const QUARTER_LABEL = /^(\d{4})-Q([1-4])$/i;
const MONTH_LABEL = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Parses "2026-Q3" (quarterly, case-insensitive) or "2026-09" (monthly). Null if it is not a label of `frequency`. */
export function parsePeriodLabel(label: string, frequency: DistributionFrequency): ReportingPeriod | null {
  const re = frequency === "QUARTERLY" ? QUARTER_LABEL : MONTH_LABEL;
  const m = re.exec(label.trim());
  return m ? periodAt(frequency, Number(m[1]), Number(m[2]) - 1) : null;
}

/** Example label for error messages and skills. */
export function periodLabelFormat(frequency: DistributionFrequency): string {
  return frequency === "QUARTERLY" ? "YYYY-Qn, e.g. 2026-Q3" : "YYYY-MM, e.g. 2026-09";
}

/** The period an issuance reports next: the one whose record date is `nextRecordDate`, or the current one if unset. */
export function periodToReport(nextRecordDate: Date | null, frequency: DistributionFrequency, now: Date): ReportingPeriod {
  return periodContaining(nextRecordDate ?? now, frequency);
}

/** Record date an issuance moves to once `distributed` is paid out. Never moves an existing record date backwards. */
export function recordDateAfter(distributed: ReportingPeriod, current: Date | null): Date {
  const next = nextPeriod(distributed).recordDate;
  return current && current.getTime() > next.getTime() ? current : next;
}
