import { describe, expect, it } from 'vitest';
import { formatSavings, formatSisaLine, newestFirst } from './budget';
import type { PeriodSummary, Transaction } from '../types';

function summary(over: Partial<PeriodSummary> = {}): PeriodSummary {
  return {
    period: { start: new Date(2026, 6, 25), end: new Date(2026, 7, 24, 23, 59, 59, 999) },
    income: 0,
    expense: 0,
    saving: 0,
    totalLimit: 0,
    spentByCategory: {},
    limitByCategory: {},
    ...over,
  };
}

describe('formatSisaLine', () => {
  it('returns null when nothing was spent (income / saving only)', () => {
    expect(formatSisaLine(summary({ income: 8_000_000 }), [])).toBeNull();
  });

  it('prefers the budget anchor when a budget is set', () => {
    const line = formatSisaLine(
      summary({ totalLimit: 8_000_000, expense: 4_760_000, income: 9_000_000 }),
      ['Makan'],
    );
    expect(line).toContain('Sisa budget');
    expect(line).toContain('Rp 3.240.000');
  });

  it('flags an overspent budget instead of showing a negative remainder', () => {
    const line = formatSisaLine(summary({ totalLimit: 1_000_000, expense: 1_250_000 }), ['Makan']);
    expect(line).toContain('Lewat budget');
    expect(line).toContain('Rp 250.000');
    expect(line).not.toContain('-');
  });

  it('falls back to cashflow when no budget is set', () => {
    const line = formatSisaLine(
      summary({ income: 8_000_000, expense: 3_000_000, saving: 1_000_000 }),
      ['Makan'],
    );
    expect(line).toContain('Sisa bulan ini');
    expect(line).toContain('Rp 4.000.000');
  });

  it('falls back to total spend when there is neither budget nor income', () => {
    const line = formatSisaLine(summary({ expense: 275_000 }), ['Makan']);
    expect(line).toContain('Keluar bulan ini');
    expect(line).toContain('Rp 275.000');
  });

  it('appends the category percentage for a single budgeted category', () => {
    const line = formatSisaLine(
      summary({
        totalLimit: 2_000_000,
        expense: 620_000,
        spentByCategory: { Makan: 620_000 },
        limitByCategory: { Makan: 1_000_000 },
      }),
      ['Makan'],
    );
    expect(line).toContain('Makan 62%');
  });

  it('warns once a category is fully spent', () => {
    const line = formatSisaLine(
      summary({
        totalLimit: 2_000_000,
        expense: 1_120_000,
        spentByCategory: { Makan: 1_120_000 },
        limitByCategory: { Makan: 1_000_000 },
      }),
      ['Makan'],
    );
    expect(line).toContain('⚠️ Makan 112%');
  });

  it('omits the percentage when the entry spans several categories', () => {
    const line = formatSisaLine(
      summary({
        totalLimit: 2_000_000,
        expense: 45_000,
        spentByCategory: { Makan: 25_000, Transportasi: 20_000 },
        limitByCategory: { Makan: 1_000_000, Transportasi: 500_000 },
      }),
      ['Makan', 'Transportasi'],
    );
    expect(line).not.toContain('%');
  });

  it('omits the percentage when the category has no limit', () => {
    const line = formatSisaLine(
      summary({ totalLimit: 2_000_000, expense: 50_000, spentByCategory: { Hiburan: 50_000 } }),
      ['Hiburan'],
    );
    expect(line).not.toContain('%');
  });
});

describe('formatSavings', () => {
  const saving = (category: string, amount: number): Transaction => ({
    timestamp: '2026-08-03T12:00:00+07:00',
    date: '2026-08-03',
    user: 'Ryan',
    amount,
    category,
    description: 'Nabung',
    payment_method: 'transfer',
    raw_input: '',
    id: `id-${category}-${amount}`,
    type: 'saving',
  });

  it('matches a target to savings regardless of case', () => {
    const out = formatSavings(
      [saving('Liburan', 1_000_000), saving('liburan', 500_000)],
      [{ goal: 'liburan', target: 5_000_000 }],
    );
    // One row, the sheet's spelling, both deposits counted against the target.
    expect(out.match(/iburan/g)).toHaveLength(1);
    expect(out).toContain('<b>liburan</b>: Rp 1.500.000 / Rp 5.000.000');
    expect(out).not.toContain('belum ada target');
  });
});

describe('newestFirst', () => {
  const at = (id: string, timestamp: string, date = '2026-08-03'): Transaction => ({
    timestamp,
    date,
    user: 'Ryan',
    amount: 1000,
    category: 'Makan',
    description: id,
    payment_method: 'cash',
    raw_input: '',
    id,
    type: 'expense',
  });

  it('orders by record time, not by sheet row order', () => {
    // Rows as they'd come back after someone sorted the sheet by amount.
    const rows = [
      at('b', '2026-08-03T12:00:00+07:00'),
      at('c', '2026-08-04T08:00:00+07:00'),
      at('a', '2026-08-02T09:00:00+07:00'),
    ];
    expect(newestFirst(rows).map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the later row first for one multi-item message', () => {
    const ts = '2026-08-03T12:00:00+07:00';
    expect(newestFirst([at('x1', ts), at('x2', ts)]).map((t) => t.id)).toEqual(['x2', 'x1']);
  });

  it('falls back to the date when the timestamp is missing', () => {
    const rows = [at('manual', '', '2026-08-05'), at('bot', '2026-08-03T12:00:00+07:00')];
    expect(newestFirst(rows)[0].id).toBe('manual');
  });
});
