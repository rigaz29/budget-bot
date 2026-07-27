import { describe, expect, it } from 'vitest';
import {
  applyOffset,
  daysInPeriod,
  daysRemaining,
  formatPeriod,
  fromYMD,
  getCurrentPeriod,
  getRecentPeriod,
  toISOLocal,
  toYMD,
} from './period';

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('getCurrentPeriod', () => {
  it('mid-period with startDay 25 (16 Jul -> 25 Jun..24 Jul)', () => {
    const p = getCurrentPeriod(new Date(2026, 6, 16), 25);
    expect(ymd(p.start)).toBe('2026-06-25');
    expect(ymd(p.end)).toBe('2026-07-24');
    expect(p.end.getHours()).toBe(23);
  });

  it('on the start day itself', () => {
    const p = getCurrentPeriod(new Date(2026, 6, 25), 25);
    expect(ymd(p.start)).toBe('2026-07-25');
    expect(ymd(p.end)).toBe('2026-08-24');
  });

  it('day before start day rolls to previous period', () => {
    const p = getCurrentPeriod(new Date(2026, 6, 24), 25);
    expect(ymd(p.start)).toBe('2026-06-25');
    expect(ymd(p.end)).toBe('2026-07-24');
  });

  it('startDay 1 uses calendar month', () => {
    const p = getCurrentPeriod(new Date(2026, 6, 16), 1);
    expect(ymd(p.start)).toBe('2026-07-01');
    expect(ymd(p.end)).toBe('2026-07-31');
  });

  it('clamps startDay 31 in short months (Feb)', () => {
    const p = getCurrentPeriod(new Date(2026, 1, 15), 31);
    expect(ymd(p.start)).toBe('2026-01-31');
    expect(ymd(p.end)).toBe('2026-02-27'); // day before Feb 28 (clamped next start)
  });

  it('handles year boundary', () => {
    const p = getCurrentPeriod(new Date(2026, 0, 10), 25);
    expect(ymd(p.start)).toBe('2025-12-25');
    expect(ymd(p.end)).toBe('2026-01-24');
  });
});

describe('period helpers', () => {
  const p = getCurrentPeriod(new Date(2026, 6, 16), 25);

  it('daysInPeriod counts inclusive days', () => {
    expect(daysInPeriod(p)).toBe(30);
  });

  it('daysRemaining from 16 Jul is 9', () => {
    expect(daysRemaining(new Date(2026, 6, 16), p)).toBe(9);
  });

  it('formatPeriod same year', () => {
    expect(formatPeriod(p)).toBe('25 Jun – 24 Jul 2026');
  });

  it('formatPeriod across years', () => {
    const cross = getCurrentPeriod(new Date(2026, 0, 10), 25);
    expect(formatPeriod(cross)).toBe('25 Des 2025 – 24 Jan 2026');
  });

  it('getRecentPeriod is a rolling 7-day window', () => {
    const r = getRecentPeriod(new Date(2026, 6, 16), 7);
    expect(ymd(r.start)).toBe('2026-07-10');
    expect(ymd(r.end)).toBe('2026-07-16');
  });
});

describe('date conversions', () => {
  it('applyOffset', () => {
    expect(ymd(applyOffset(new Date(2026, 6, 16), -1))).toBe('2026-07-15');
    expect(ymd(applyOffset(new Date(2026, 6, 1), -1))).toBe('2026-06-30');
  });

  it('toYMD / fromYMD round-trip', () => {
    expect(toYMD(new Date(2026, 6, 5))).toBe('2026-07-05');
    const d = fromYMD('2026-07-05');
    expect(d && ymd(d)).toBe('2026-07-05');
  });

  it('toISOLocal keeps a timezone offset (not UTC Z)', () => {
    const iso = toISOLocal(new Date(2026, 6, 16, 10, 30, 0));
    expect(iso).toMatch(/^2026-07-16T10:30:00[+-]\d{2}:\d{2}$/);
  });
});
