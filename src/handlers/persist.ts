/**
 * Shared helpers for turning parsed transactions into sheet rows and rendering
 * the confirmation messages/keyboards used by both the text and photo handlers.
 *
 * Callback data conventions:
 *   cx:<id>            cancel a single transaction (delete its row)
 *   cxa:<id>.<id>...   cancel all transactions from a multi-entry message
 *   sv:<token>         save a low-confidence pending parse
 *   dc:<token>         discard a low-confidence pending parse
 */

import { randomUUID } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type { ParsedTransaction, Transaction } from '../types';
import { formatRupiah } from '../utils/currency';
import { applyOffset, formatDateID, fromYMD, toISOLocal, toYMD } from '../utils/period';
import { escapeHtml, formatSisaLine } from '../services/budget';
import * as periodCache from '../services/periodCache';
import { logger } from '../utils/logger';

export function genId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** Resolve parsed items (date_offset, user, id, timestamp) into sheet rows. */
export function buildTransactions(
  parsed: ParsedTransaction[],
  userName: string,
  now: Date,
  rawInput: string,
): Transaction[] {
  const timestamp = toISOLocal(now);
  return parsed.map((p) => ({
    timestamp,
    date: toYMD(applyOffset(now, p.date_offset)),
    user: userName,
    amount: p.amount,
    category: p.category,
    description: p.description,
    payment_method: p.payment_method,
    raw_input: rawInput,
    id: genId(),
    type: p.type,
  }));
}

function humanDate(tx: Transaction): string {
  const d = fromYMD(tx.date);
  return d ? formatDateID(d) : tx.date;
}

function methodSuffix(tx: Transaction): string {
  return tx.payment_method && tx.payment_method !== 'cash' ? ` · ${tx.payment_method}` : '';
}

/** Icon + label per transaction type, shown on confirmations. */
function typeIcon(tx: Transaction): string {
  return tx.type === 'income' ? '💰' : tx.type === 'saving' ? '🏦' : '💸';
}

function typeLabel(tx: Transaction): string {
  return tx.type === 'income' ? 'Pemasukan' : tx.type === 'saving' ? 'Tabungan' : 'Tercatat';
}

export function singleCancelKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text('❌ Batalkan', `cx:${id}`);
}

/**
 * Remaining-budget footer for `txs`, which must ALREADY be written to the sheet.
 * Best-effort: a Sheets hiccup drops the line rather than the confirmation.
 */
export async function sisaLine(txs: Transaction[], now = new Date()): Promise<string | null> {
  try {
    const summary = await periodCache.summaryAfter(txs, now);
    if (!summary) return null;
    const expenseCategories = txs.filter((t) => t.type === 'expense').map((t) => t.category);
    return formatSisaLine(summary, expenseCategories);
  } catch (err) {
    logger.warn('Gagal menghitung sisa budget', err);
    return null;
  }
}

/** Confirmation for a single recorded transaction. */
export function singleConfirm(
  tx: Transaction,
  sisa?: string | null,
): { text: string; keyboard: InlineKeyboard } {
  const text =
    `✅ <b>${typeLabel(tx)}</b>\n` +
    `${typeIcon(tx)} ${formatRupiah(tx.amount)} — ${escapeHtml(tx.category)}${methodSuffix(tx)}\n` +
    `📝 ${escapeHtml(tx.description)}\n` +
    `👤 ${escapeHtml(tx.user)} · ${humanDate(tx)}` +
    (sisa ? `\n${sisa}` : '');
  return { text, keyboard: singleCancelKeyboard(tx.id) };
}

/** Confirmation summary for a multi-transaction message. */
export function multiConfirm(
  txs: Transaction[],
  sisa?: string | null,
): { text: string; keyboard?: InlineKeyboard } {
  const total = txs.reduce((s, t) => s + t.amount, 0);
  const lines = txs.map(
    (t, i) =>
      `${i + 1}. ${typeIcon(t)} ${formatRupiah(t.amount)} — ${escapeHtml(t.category)} · ${escapeHtml(t.description)}${methodSuffix(t)}`,
  );
  const text =
    `✅ <b>${txs.length} transaksi tercatat</b>\n` +
    `${lines.join('\n')}\n` +
    `<b>Total:</b> ${formatRupiah(total)}\n` +
    `👤 ${escapeHtml(txs[0].user)} · ${humanDate(txs[0])}` +
    (sisa ? `\n${sisa}` : '');

  // "Batalkan semua" only if the ids fit inside Telegram's 64-byte callback data.
  const data = `cxa:${txs.map((t) => t.id).join('.')}`;
  const keyboard =
    data.length <= 60 ? new InlineKeyboard().text('❌ Batalkan semua', data) : undefined;
  return { text, keyboard };
}

/** Preview for a low-confidence photo parse — asks to save/discard, writes nothing yet. */
export function pendingConfirm(
  txs: Transaction[],
  token: string,
): { text: string; keyboard: InlineKeyboard } {
  const lines = txs.map(
    (t) => `⚠️ ${formatRupiah(t.amount)} — ${escapeHtml(t.category)} · ${escapeHtml(t.description)}${methodSuffix(t)}`,
  );
  const text =
    `⚠️ <b>Perlu konfirmasi</b> (nominal kurang jelas)\n` +
    `${lines.join('\n')}\n\n` +
    `Simpan transaksi ini? Kalau salah, ketik ulang manual.`;
  const keyboard = new InlineKeyboard()
    .text('✅ Simpan', `sv:${token}`)
    .text('❌ Buang', `dc:${token}`);
  return { text, keyboard };
}
