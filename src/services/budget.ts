/**
 * Budget calculations and the formatted /recap & /budget messages.
 * Rendering uses Telegram HTML parse mode; the aligned breakdown sits in a <pre>
 * block so the monospace font keeps columns roughly aligned.
 */

import type {
  Budget,
  BudgetPeriod,
  CategorySpend,
  PeriodSummary,
  SavingGoal,
  Transaction,
} from '../types';
import { formatRupiah, formatRupiahShort } from '../utils/currency';
import { daysRemaining, formatDateShort, formatPeriod, fromYMD } from '../utils/period';

const CATEGORY_EMOJI: Record<string, string> = {
  Makan: '🍜',
  Transportasi: '🚗',
  'Belanja Rumah Tangga': '🛒',
  Kesehatan: '💊',
  Hiburan: '🎬',
  Tagihan: '🧾',
  'Anak & Keluarga': '👶',
  'Investasi & Tabungan': '💰',
  'Sosial & Hadiah': '🎁',
  Lainnya: '📦',
};

export function emojiFor(category: string): string {
  return CATEGORY_EMOJI[category] ?? '📦';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function typeIcon(t: Transaction): string {
  return t.type === 'income' ? '💰' : t.type === 'saving' ? '🏦' : '💸';
}

/** Sort key for "most recent": when it was recorded, else the transaction date. */
function recency(t: Transaction): number {
  const ts = Date.parse(t.timestamp);
  if (!Number.isNaN(ts)) return ts;
  return fromYMD(t.date)?.getTime() ?? 0;
}

/**
 * Newest first by record time — NOT sheet row order, which changes as soon as
 * someone sorts the Transactions tab via its filter (and /undo would then delete
 * the wrong row). Ties (items of one multi-item message) keep the later row first.
 */
export function newestFirst(txs: Transaction[]): Transaction[] {
  return txs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => recency(b.t) - recency(a.t) || b.i - a.i)
    .map((x) => x.t);
}

/** Shared transaction log for /riwayat: newest first, both users, all types (HTML). */
export function formatHistory(txs: Transaction[]): string {
  if (txs.length === 0) return 'Belum ada transaksi.';
  const lines = txs.map((t) => {
    const d = fromYMD(t.date);
    const day = d ? formatDateShort(d) : t.date;
    const desc = t.description.length > 24 ? `${t.description.slice(0, 23)}…` : t.description;
    const tail = desc ? ` — ${escapeHtml(desc)}` : '';
    return `${day} · ${escapeHtml(t.user)} · ${typeIcon(t)} ${formatRupiah(t.amount)} ${escapeHtml(t.category)}${tail}`;
  });
  return `🧾 <b>${txs.length} transaksi terakhir</b>\n${lines.join('\n')}`;
}

/** Grouped integer without the "Rp " prefix, for tabular columns. */
function grouped(n: number): string {
  return formatRupiah(n).replace(/^Rp\s*/, '');
}

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

export interface Rollup {
  categories: CategorySpend[];
  totalSpent: number;
  totalLimit: number;
}

/** Cash-flow totals for a set of transactions. */
export interface Cashflow {
  income: number;
  expense: number;
  saving: number;
  /** income − expense − saving */
  net: number;
}

export function computeCashflow(transactions: Transaction[]): Cashflow {
  let income = 0;
  let expense = 0;
  let saving = 0;
  for (const t of transactions) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'saving') saving += t.amount;
    else expense += t.amount;
  }
  return { income, expense, saving, net: income - expense - saving };
}

/** Aggregate EXPENSE spend per category and merge with budget limits. */
export function rollup(transactions: Transaction[], budgets: Budget[]): Rollup {
  const expenses = transactions.filter((t) => t.type === 'expense');
  const spentByCat = new Map<string, number>();
  for (const t of expenses) {
    spentByCat.set(t.category, (spentByCat.get(t.category) ?? 0) + t.amount);
  }
  const limitByCat = new Map<string, number>();
  for (const b of budgets) limitByCat.set(b.category, b.monthly_limit);

  const names = new Set<string>([...spentByCat.keys(), ...limitByCat.keys()]);
  const categories: CategorySpend[] = [];
  for (const name of names) {
    categories.push({
      category: name,
      spent: spentByCat.get(name) ?? 0,
      limit: limitByCat.has(name) ? limitByCat.get(name)! : null,
    });
  }
  categories.sort((a, b) => b.spent - a.spent);

  const totalSpent = expenses.reduce((s, t) => s + t.amount, 0);
  const totalLimit = budgets.reduce((s, b) => s + b.monthly_limit, 0);
  return { categories, totalSpent, totalLimit };
}

function topTransactions(transactions: Transaction[], n: number): Transaction[] {
  return [...transactions.filter((t) => t.type === 'expense')].sort((a, b) => b.amount - a.amount).slice(0, n);
}

/** Build the /recap message (HTML). */
export function formatRecap(
  transactions: Transaction[],
  budgets: Budget[],
  period: BudgetPeriod,
  now: Date,
  title = 'Recap',
  showFooter = true,
): string {
  const { categories, totalSpent, totalLimit } = rollup(transactions, budgets);

  if (transactions.length === 0) {
    return `<b>📊 ${escapeHtml(title)} ${escapeHtml(formatPeriod(period))}</b>\n\nBelum ada transaksi pada periode ini.`;
  }

  const totalPct = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : null;
  const totalLine =
    totalLimit > 0
      ? `${formatRupiah(totalSpent)} / ${formatRupiah(totalLimit)} (${totalPct}%)`
      : `${formatRupiah(totalSpent)}`;

  const shown = categories.filter((c) => c.spent > 0 || (c.limit ?? 0) > 0);
  const nameWidth = Math.min(
    20,
    Math.max(8, ...shown.map((c) => c.category.length)),
  );

  const lines: string[] = [];
  for (const c of shown) {
    const name = c.category.slice(0, nameWidth).padEnd(nameWidth);
    if (c.limit && c.limit > 0) {
      const pct = Math.round((c.spent / c.limit) * 100);
      const mark = pct >= 90 ? '⚠️' : emojiFor(c.category);
      lines.push(
        `${mark} ${escapeHtml(name)} ${grouped(c.spent).padStart(11)} / ${grouped(c.limit).padStart(11)} ${bar(pct)} ${String(pct).padStart(3)}%`,
      );
    } else {
      lines.push(`${emojiFor(c.category)} ${escapeHtml(name)} ${grouped(c.spent).padStart(11)}  (no budget)`);
    }
  }

  const cf = computeCashflow(transactions);
  const parts: string[] = [];
  parts.push(`<b>📊 ${escapeHtml(title)} ${escapeHtml(formatPeriod(period))}</b>`);

  // Arus kas ringkas (hanya tampil jika ada pemasukan/tabungan).
  if (cf.income > 0 || cf.saving > 0) {
    parts.push('');
    parts.push('<b>💵 Arus Kas</b>');
    parts.push(`💰 Pemasukan  ${formatRupiah(cf.income)}`);
    parts.push(`💸 Pengeluaran ${formatRupiah(cf.expense)}`);
    parts.push(`🏦 Tabungan   ${formatRupiah(cf.saving)}`);
    const saldoIcon = cf.net >= 0 ? '✅' : '⚠️';
    parts.push(`${saldoIcon} <b>Saldo</b>      ${formatRupiah(cf.net)}`);
  }

  parts.push('');
  parts.push(`<b>Pengeluaran vs Budget:</b> ${totalLine}`);
  // Income/saving-only period with no budgets -> nothing to tabulate; skip the
  // block rather than send an empty <pre>.
  if (lines.length > 0) {
    parts.push('');
    parts.push(`<pre>${lines.join('\n')}</pre>`);
  }

  // Top 5 largest transactions.
  const top = topTransactions(transactions, 5);
  if (top.length > 0) {
    parts.push('');
    parts.push('<b>Top pengeluaran:</b>');
    top.forEach((t, i) => {
      const desc = t.description.length > 28 ? `${t.description.slice(0, 27)}…` : t.description;
      parts.push(`${i + 1}. ${formatRupiah(t.amount)} — ${escapeHtml(desc)} <i>(${escapeHtml(t.user)})</i>`);
    });
  }

  // Footer: days remaining + safe daily average of the remaining budget.
  if (showFooter) {
    const remDays = daysRemaining(now, period);
    parts.push('');
    if (totalLimit > 0) {
      const remainingBudget = Math.max(0, totalLimit - totalSpent);
      const perDay = remDays > 0 ? remainingBudget / remDays : remainingBudget;
      parts.push(
        `<i>Sisa ${remDays} hari · rata-rata aman: ${formatRupiahShort(perDay)}/hari</i>`,
      );
    } else {
      parts.push(`<i>Sisa ${remDays} hari</i>`);
    }
  }

  return parts.join('\n');
}

/** Build the /budget listing (HTML): spent vs limit vs remaining per category. */
export function formatBudgets(
  transactions: Transaction[],
  budgets: Budget[],
  period: BudgetPeriod,
): string {
  if (budgets.length === 0) {
    return (
      '💰 Belum ada budget yang diset.\n\n' +
      'Set budget dengan: <code>/budget Makan 2000000</code>'
    );
  }
  const { categories } = rollup(transactions, budgets);
  const byName = new Map(categories.map((c) => [c.category, c]));

  const parts: string[] = [];
  parts.push(`<b>💰 Budget ${escapeHtml(formatPeriod(period))}</b>`);
  parts.push('');
  for (const b of budgets) {
    const spent = byName.get(b.category)?.spent ?? 0;
    const sisa = b.monthly_limit - spent;
    const pct = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
    const mark = pct >= 90 ? '⚠️' : emojiFor(b.category);
    parts.push(
      `${mark} <b>${escapeHtml(b.category)}</b>: ${formatRupiah(spent)} / ${formatRupiah(b.monthly_limit)} · sisa ${formatRupiah(sisa)}`,
    );
  }
  return parts.join('\n');
}

/**
 * One-line footer for transaction confirmations: how much is left this period.
 *
 * Anchors, in order of usefulness — the first one the data supports wins:
 *   1. budget is set   -> budget − pengeluaran (the actionable number)
 *   2. income recorded -> income − pengeluaran − tabungan ("sisa gaji")
 *   3. neither         -> total pengeluaran (at least something to react to)
 *
 * The percentage suffix is only shown when the entry touched exactly one
 * budgeted category — with several, no single percentage means anything.
 * Returns null for income/saving-only entries, where "sisa" isn't the point.
 */
export function formatSisaLine(
  summary: PeriodSummary,
  expenseCategories: string[],
): string | null {
  if (expenseCategories.length === 0) return null;

  let hint = '';
  const unique = [...new Set(expenseCategories)];
  if (unique.length === 1) {
    const cat = unique[0];
    const limit = summary.limitByCategory[cat] ?? 0;
    if (limit > 0) {
      const pct = Math.round(((summary.spentByCategory[cat] ?? 0) / limit) * 100);
      hint = ` · ${pct >= 100 ? '⚠️' : emojiFor(cat)} ${escapeHtml(cat)} ${pct}%`;
    }
  }

  if (summary.totalLimit > 0) {
    const sisa = summary.totalLimit - summary.expense;
    return sisa >= 0
      ? `💵 Sisa budget: <b>${formatRupiah(sisa)}</b>${hint}`
      : `⚠️ Lewat budget: <b>${formatRupiah(-sisa)}</b>${hint}`;
  }

  if (summary.income > 0) {
    const sisa = summary.income - summary.expense - summary.saving;
    return sisa >= 0
      ? `💵 Sisa bulan ini: <b>${formatRupiah(sisa)}</b>${hint}`
      : `⚠️ Minus bulan ini: <b>${formatRupiah(-sisa)}</b>${hint}`;
  }

  return `💸 Keluar bulan ini: <b>${formatRupiah(summary.expense)}</b>${hint}`;
}

/**
 * Build the /tabungan listing (HTML): accumulated savings vs target per goal,
 * all-time (savings accumulate — not per period).
 */
export function formatSavings(allTransactions: Transaction[], goals: SavingGoal[]): string {
  // Goals match case-insensitively: "/tabungan liburan 5jt" must line up with
  // savings the parser recorded as "Liburan" (the Dashboard's formulas compare
  // case-insensitively too). The Tabungan sheet's spelling wins for display.
  const key = (name: string) => name.trim().toLowerCase();
  const byGoal = new Map<string, { goal: string; saved: number; target: number }>();
  for (const g of goals) byGoal.set(key(g.goal), { goal: g.goal, saved: 0, target: g.target });
  for (const t of allTransactions) {
    if (t.type !== 'saving') continue;
    const k = key(t.category);
    let row = byGoal.get(k);
    if (!row) {
      row = { goal: t.category, saved: 0, target: 0 };
      byGoal.set(k, row);
    }
    row.saved += t.amount;
  }

  if (byGoal.size === 0) {
    return (
      '🏦 Belum ada tabungan.\n\n' +
      'Catat dengan: <i>nabung dana darurat 500rb</i>\n' +
      'Set target: <code>/tabungan Liburan 5000000</code>'
    );
  }

  const rows = [...byGoal.values()];
  rows.sort((a, b) => b.saved - a.saved);

  const parts: string[] = [];
  parts.push('<b>🏦 Tabungan</b>');
  parts.push('');
  let totalSaved = 0;
  for (const r of rows) {
    totalSaved += r.saved;
    if (r.target > 0) {
      const pct = Math.round((r.saved / r.target) * 100);
      const done = pct >= 100 ? '🎉 ' : '';
      parts.push(
        `${done}<b>${escapeHtml(r.goal)}</b>: ${formatRupiah(r.saved)} / ${formatRupiah(r.target)}\n<pre>${bar(pct)} ${pct}%</pre>`,
      );
    } else {
      parts.push(`<b>${escapeHtml(r.goal)}</b>: ${formatRupiah(r.saved)} <i>(belum ada target)</i>`);
    }
  }
  parts.push('');
  parts.push(`<b>Total terkumpul:</b> ${formatRupiah(totalSaved)}`);
  return parts.join('\n');
}
