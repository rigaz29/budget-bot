/**
 * In-memory rollup of the CURRENT budget period, so every transaction
 * confirmation can show the remaining budget for free.
 *
 * Without this, each confirmation would cost a full-sheet read:
 * `getTransactionsInPeriod` pulls every Transactions row and filters in JS.
 * That is the expensive part, not the arithmetic.
 *
 * Freshness strategy:
 *   - loaded from the sheet on first use, re-synced once it is older than TTL_MS
 *     (the sheet can also be edited by hand in the browser, so the cache must
 *     self-heal rather than drift forever)
 *   - every mutation applies an immediate delta, so the number already includes
 *     the transaction the user just sent — a stale-looking figure would be worse
 *     than no figure at all
 *   - deltas are keyed by transaction id, so a reload that already contains a
 *     row can never double-count it, whatever order load/apply happen in
 *
 * Every entry point is best-effort: on a Sheets failure the caller gets `null`
 * and simply omits the line. Recording a transaction must never fail because
 * the summary could not be computed.
 */

import { config } from '../config';
import type { BudgetPeriod, PeriodSummary, Transaction } from '../types';
import { fromYMD, getCurrentPeriod, isWithinPeriod, toYMD } from '../utils/period';
import { logger } from '../utils/logger';
import * as sheets from './sheets';

/** How long a loaded rollup is trusted before re-reading the sheet. */
const TTL_MS = 10 * 60 * 1000;

/** After a failed reload, keep serving the old rollup but retry this soon. */
const RETRY_MS = 60 * 1000;

interface State {
  /** Period start as YYYY-MM-DD — detects the roll into a new period. */
  key: string;
  period: BudgetPeriod;
  income: number;
  expense: number;
  saving: number;
  spent: Map<string, number>;
  limits: Map<string, number>;
  totalLimit: number;
  /** Ids already counted, so deltas stay idempotent against a reload. */
  ids: Set<string>;
  loadedAt: number;
}

let state: State | null = null;
let loading: Promise<State | null> | null = null;

function keyOf(period: BudgetPeriod): string {
  return toYMD(period.start);
}

function emptyState(period: BudgetPeriod): State {
  return {
    key: keyOf(period),
    period,
    income: 0,
    expense: 0,
    saving: 0,
    spent: new Map(),
    limits: new Map(),
    totalLimit: 0,
    ids: new Set(),
    loadedAt: Date.now(),
  };
}

/**
 * Add (sign 1) or remove (sign -1) one transaction. Out-of-period rows and
 * double applications are ignored, so callers can fire this blindly.
 */
function applyTx(s: State, tx: Transaction, sign: 1 | -1): void {
  // Same date rule as sheets.getTransactionsInPeriod, or rows that /recap counts
  // (date cell blank / hand-edited, valid timestamp) would be dropped here.
  const date = fromYMD(tx.date) ?? fromYMD(tx.timestamp);
  if (!date || !isWithinPeriod(date, s.period)) return;

  const id = tx.id?.trim();
  if (sign === 1) {
    if (id) {
      if (s.ids.has(id)) return;
      s.ids.add(id);
    }
  } else {
    // Unknown id -> it was never counted (or already removed); nothing to undo.
    if (!id || !s.ids.delete(id)) return;
  }

  const delta = sign * tx.amount;
  if (tx.type === 'income') {
    s.income += delta;
  } else if (tx.type === 'saving') {
    s.saving += delta;
  } else {
    s.expense += delta;
    s.spent.set(tx.category, (s.spent.get(tx.category) ?? 0) + delta);
  }
}

async function load(now: Date): Promise<State | null> {
  const period = getCurrentPeriod(now, config.BUDGET_START_DAY);
  try {
    const [txs, budgets] = await Promise.all([
      sheets.getTransactionsInPeriod(period.start, period.end),
      sheets.getBudgets(),
    ]);
    const s = emptyState(period);
    for (const tx of txs) applyTx(s, tx, 1);
    for (const b of budgets) {
      s.limits.set(b.category, b.monthly_limit);
      s.totalLimit += b.monthly_limit;
    }
    return s;
  } catch (err) {
    logger.warn('Gagal memuat rollup periode', err);
    return null;
  }
}

/** Current rollup, reloading when stale, on a new period, or after invalidate(). */
async function ensure(now: Date): Promise<State | null> {
  const key = keyOf(getCurrentPeriod(now, config.BUDGET_START_DAY));
  if (state && state.key === key && Date.now() - state.loadedAt < TTL_MS) return state;

  if (!loading) {
    loading = load(now).then(
      (s) => {
        if (s) state = s;
        loading = null;
        return s;
      },
      (err) => {
        loading = null;
        throw err;
      },
    );
  }

  const fresh = await loading;
  if (fresh) return fresh;

  // Reload failed. A rollup for the same period is still better than nothing;
  // just don't hammer Sheets on every message.
  if (state && state.key === key) {
    state.loadedAt = Date.now() - TTL_MS + RETRY_MS;
    return state;
  }
  return null;
}

function snapshot(s: State): PeriodSummary {
  return {
    period: s.period,
    income: s.income,
    expense: s.expense,
    saving: s.saving,
    totalLimit: s.totalLimit,
    spentByCategory: Object.fromEntries(s.spent),
    limitByCategory: Object.fromEntries(s.limits),
  };
}

/** Rollup of the current period, or null if the sheet could not be read. */
export async function summary(now = new Date()): Promise<PeriodSummary | null> {
  const s = await ensure(now);
  return s ? snapshot(s) : null;
}

/**
 * Count `txs` as just written and return the resulting rollup. Safe to call
 * even if the reload already picked those rows up.
 */
export async function summaryAfter(
  txs: Transaction[],
  now = new Date(),
): Promise<PeriodSummary | null> {
  const s = await ensure(now);
  if (!s) return null;
  for (const tx of txs) applyTx(s, tx, 1);
  return snapshot(s);
}

/** Discount `txs` again after they were deleted (/undo, cancel buttons). */
export async function removed(txs: Transaction[], now = new Date()): Promise<void> {
  const s = await ensure(now);
  if (!s) return;
  for (const tx of txs) applyTx(s, tx, -1);
}

/** Force a reload on next use — call after anything that changes the budgets. */
export function invalidate(): void {
  state = null;
}

/** Preload at startup so the first confirmation doesn't pay for the read. */
export async function warm(now = new Date()): Promise<void> {
  await ensure(now);
}
