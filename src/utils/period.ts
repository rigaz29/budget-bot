/**
 * Budget-period math.
 *
 * A budget period runs from BUDGET_START_DAY of one month to the day before
 * BUDGET_START_DAY of the next (aligned to payday, default the 25th).
 *
 * All arithmetic uses the process-local timezone. Deployment sets TZ=Asia/Jakarta
 * (systemd + .env), so getDate()/getMonth() reflect WIB.
 *
 * Short-month handling: if BUDGET_START_DAY exceeds the number of days in a month
 * (e.g. 31 in February), it is clamped to that month's last day.
 */

import type { BudgetPeriod } from '../types';

const MONTHS_ID = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

/** Days in the given month (month is 0-indexed). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Clamp a start-day to a month's valid range. */
function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/**
 * Return the inclusive [start, end] budget period that contains `now`.
 * start is at 00:00:00.000; end is at 23:59:59.999 of the last day.
 */
export function getCurrentPeriod(now: Date, startDay: number): BudgetPeriod {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  const startThisMonth = clampDay(y, m, startDay);

  let sy: number;
  let sm: number;
  if (d >= startThisMonth) {
    sy = y;
    sm = m;
  } else {
    // Fall back to the previous month's start day.
    sm = m - 1;
    sy = y;
    if (sm < 0) {
      sm = 11;
      sy = y - 1;
    }
  }

  const start = new Date(sy, sm, clampDay(sy, sm, startDay), 0, 0, 0, 0);

  // Next period's start, then step back one millisecond (Jakarta has no DST).
  let nm = sm + 1;
  let ny = sy;
  if (nm > 11) {
    nm = 0;
    ny = sy + 1;
  }
  const nextStart = new Date(ny, nm, clampDay(ny, nm, startDay), 0, 0, 0, 0);
  const end = new Date(nextStart.getTime() - 1);

  return { start, end };
}

/** Rolling window of the last `days` days (for `/recap minggu`), inclusive of today. */
export function getRecentPeriod(now: Date, days: number): BudgetPeriod {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
  return { start, end };
}

/** True if `date` falls inside the inclusive period. */
export function isWithinPeriod(date: Date, period: BudgetPeriod): boolean {
  const t = date.getTime();
  return t >= period.start.getTime() && t <= period.end.getTime();
}

/** Total whole days in the period (inclusive). */
export function daysInPeriod(period: BudgetPeriod): number {
  const ms = period.end.getTime() - period.start.getTime();
  return Math.round(ms / 86_400_000);
}

/** Whole days remaining from `now` to the end of the period (inclusive of today). */
export function daysRemaining(now: Date, period: BudgetPeriod): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const ms = period.end.getTime() - today.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Apply a day offset (0 = today, -1 = yesterday) and return the resulting date. */
export function applyOffset(now: Date, offset: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
}

/** Format a date as YYYY-MM-DD in local time. */
export function toYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Human date for confirmations: "16 Jul 2026". */
export function formatDateID(date: Date): string {
  return `${date.getDate()} ${MONTHS_ID[date.getMonth()]} ${date.getFullYear()}`;
}

/** Compact date without year: "16 Jul". */
export function formatDateShort(date: Date): string {
  return `${date.getDate()} ${MONTHS_ID[date.getMonth()]}`;
}

/** Parse a YYYY-MM-DD string to a local Date at midnight, or null. */
export function fromYMD(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/**
 * ISO 8601 timestamp with the local timezone offset (e.g. WIB: +07:00),
 * not UTC — Date.toISOString() would drop the offset.
 */
export function toISOLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzh = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzm = pad(Math.abs(tzMin) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${tzh}:${tzm}`
  );
}

/** Period header for recap: "25 Jun – 16 Jul 2026" (year shown once when shared). */
export function formatPeriod(period: BudgetPeriod): string {
  const { start, end } = period;
  const sameYear = start.getFullYear() === end.getFullYear();
  const left = sameYear
    ? `${start.getDate()} ${MONTHS_ID[start.getMonth()]}`
    : `${start.getDate()} ${MONTHS_ID[start.getMonth()]} ${start.getFullYear()}`;
  const right = `${end.getDate()} ${MONTHS_ID[end.getMonth()]} ${end.getFullYear()}`;
  return `${left} – ${right}`;
}
