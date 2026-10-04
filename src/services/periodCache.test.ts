import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Budget, Transaction } from '../types';

vi.mock('./sheets', () => ({
  getTransactionsInPeriod: vi.fn(async () => [] as Transaction[]),
  getBudgets: vi.fn(async () => [] as Budget[]),
}));

import * as sheets from './sheets';
import * as periodCache from './periodCache';

/** BUDGET_START_DAY is 25 under test -> this sits inside 25 Jul – 24 Aug 2026. */
const NOW = new Date(2026, 7, 3, 12, 0, 0);

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    timestamp: '2026-08-03T12:00:00+07:00',
    date: '2026-08-03',
    user: 'Ryan',
    amount: 50_000,
    category: 'Makan',
    description: 'Makan malam',
    payment_method: 'cash',
    raw_input: 'makan malam 50rb',
    id: 'aaaa1111',
    type: 'expense',
    ...over,
  };
}

beforeEach(() => {
  periodCache.invalidate();
  vi.mocked(sheets.getTransactionsInPeriod).mockResolvedValue([]);
  vi.mocked(sheets.getBudgets).mockResolvedValue([]);
  vi.clearAllMocks();
});

describe('periodCache', () => {
  it('loads the period rollup from the sheet once, then serves it from memory', async () => {
    vi.mocked(sheets.getTransactionsInPeriod).mockResolvedValue([tx({ amount: 200_000 })]);
    vi.mocked(sheets.getBudgets).mockResolvedValue([{ category: 'Makan', monthly_limit: 1_000_000 }]);

    const first = await periodCache.summary(NOW);
    const second = await periodCache.summary(NOW);

    expect(first?.expense).toBe(200_000);
    expect(first?.totalLimit).toBe(1_000_000);
    expect(second?.expense).toBe(200_000);
    expect(sheets.getTransactionsInPeriod).toHaveBeenCalledTimes(1);
  });

  it('includes a just-written transaction without re-reading the sheet', async () => {
    await periodCache.summary(NOW);
    const after = await periodCache.summaryAfter([tx({ id: 'new1', amount: 50_000 })], NOW);

    expect(after?.expense).toBe(50_000);
    expect(after?.spentByCategory.Makan).toBe(50_000);
    expect(sheets.getTransactionsInPeriod).toHaveBeenCalledTimes(1);
  });

  it('never double-counts a row the sheet reload already returned', async () => {
    const written = tx({ id: 'dup1', amount: 75_000 });
    vi.mocked(sheets.getTransactionsInPeriod).mockResolvedValue([written]);

    const after = await periodCache.summaryAfter([written], NOW);
    const again = await periodCache.summaryAfter([written], NOW);

    expect(after?.expense).toBe(75_000);
    expect(again?.expense).toBe(75_000);
  });

  it('splits income and saving out of the expense total', async () => {
    const after = await periodCache.summaryAfter(
      [
        tx({ id: 'i1', type: 'income', amount: 8_000_000, category: 'Gaji' }),
        tx({ id: 's1', type: 'saving', amount: 1_000_000, category: 'Liburan' }),
        tx({ id: 'e1', type: 'expense', amount: 25_000 }),
      ],
      NOW,
    );

    expect(after?.income).toBe(8_000_000);
    expect(after?.saving).toBe(1_000_000);
    expect(after?.expense).toBe(25_000);
    expect(after?.spentByCategory.Gaji).toBeUndefined();
  });

  it('subtracts a cancelled transaction, and ignores a repeated cancel', async () => {
    const t = tx({ id: 'cx1', amount: 30_000 });
    await periodCache.summaryAfter([t], NOW);

    await periodCache.removed([t], NOW);
    expect((await periodCache.summary(NOW))?.expense).toBe(0);

    await periodCache.removed([t], NOW);
    expect((await periodCache.summary(NOW))?.expense).toBe(0);
  });

  it('ignores transactions dated outside the current period', async () => {
    const after = await periodCache.summaryAfter(
      [tx({ id: 'old1', date: '2026-07-01', amount: 999_000 })],
      NOW,
    );
    expect(after?.expense).toBe(0);
  });

  it('re-reads after invalidate() so a new budget takes effect', async () => {
    await periodCache.summary(NOW);
    vi.mocked(sheets.getBudgets).mockResolvedValue([{ category: 'Makan', monthly_limit: 2_000_000 }]);

    expect((await periodCache.summary(NOW))?.totalLimit).toBe(0);
    periodCache.invalidate();
    expect((await periodCache.summary(NOW))?.totalLimit).toBe(2_000_000);
  });

  it('returns null instead of throwing when Sheets is unreachable', async () => {
    vi.mocked(sheets.getTransactionsInPeriod).mockRejectedValue(new Error('boom'));
    expect(await periodCache.summary(NOW)).toBeNull();
    expect(await periodCache.summaryAfter([tx()], NOW)).toBeNull();
  });
});
