/**
 * Inline-button handler.
 *   cx:<id>            delete one transaction row
 *   cxa:<id>.<id>...   delete several (multi-message "Batalkan semua")
 *   sv:<token>         save a low-confidence pending parse
 *   dc:<token>         discard a low-confidence pending parse
 */

import type { Bot, Context } from 'grammy';
import { formatRupiah } from '../utils/currency';
import { escapeHtml } from '../services/budget';
import * as periodCache from '../services/periodCache';
import * as sheets from '../services/sheets';
import { logger } from '../utils/logger';
import { multiConfirm, pendingConfirm, singleConfirm, sisaLine } from './persist';
import * as pending from './pending';

async function cancelSingle(ctx: Context, id: string): Promise<void> {
  const deleted = await sheets.deleteTransactionById(id);
  await ctx.answerCallbackQuery({ text: deleted ? 'Dibatalkan' : 'Sudah tidak ada' });
  if (deleted) {
    await periodCache.removed([deleted]);
    await ctx.editMessageText(
      `🗑 <b>Dibatalkan</b>\n${formatRupiah(deleted.amount)} — ${escapeHtml(deleted.category)} · ${escapeHtml(deleted.description)}`,
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.editMessageText('🗑 Transaksi ini sudah dibatalkan sebelumnya.');
  }
}

async function cancelAll(ctx: Context, ids: string[]): Promise<void> {
  let count = 0;
  const deletedTxs = [];
  for (const id of ids) {
    const deleted = await sheets.deleteTransactionById(id);
    if (deleted) {
      deletedTxs.push(deleted);
      count++;
    }
  }
  await periodCache.removed(deletedTxs);
  await ctx.answerCallbackQuery({ text: count > 0 ? `${count} dibatalkan` : 'Sudah tidak ada' });
  // A double tap must not overwrite "3 transaksi dibatalkan" with "0 ...".
  await ctx.editMessageText(
    count > 0
      ? `🗑 <b>${count} transaksi dibatalkan</b>`
      : '🗑 Transaksi ini sudah dibatalkan sebelumnya.',
    { parse_mode: 'HTML' },
  );
}

async function savePending(ctx: Context, token: string): Promise<void> {
  const txs = pending.take(token);
  if (!txs) {
    await ctx.answerCallbackQuery({ text: 'Kedaluwarsa / sudah diproses' });
    await ctx.editMessageText('⌛ Konfirmasi kedaluwarsa. Kirim ulang jika masih perlu dicatat.');
    return;
  }
  try {
    await sheets.appendTransactions(txs);
  } catch (err) {
    logger.error('Gagal simpan pending', err);
    // take() already consumed the entry: put it back and keep the buttons, or
    // "coba lagi" would be impossible and the parsed photo lost.
    pending.put(token, txs, Date.now());
    await ctx.answerCallbackQuery({ text: 'Gagal simpan, coba lagi' });
    const view = pendingConfirm(txs, token);
    await ctx.editMessageText(`${view.text}\n\n⚠️ Gagal menyimpan ke Sheets. Tekan <b>Simpan</b> lagi.`, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Disimpan' });
  logger.info('Pending disimpan', { count: txs.length });
  const sisa = await sisaLine(txs);
  const view = txs.length === 1 ? singleConfirm(txs[0], sisa) : multiConfirm(txs, sisa);
  await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

async function discardPending(ctx: Context, token: string): Promise<void> {
  pending.take(token);
  await ctx.answerCallbackQuery({ text: 'Dibuang' });
  await ctx.editMessageText('🗑 Dibuang, tidak disimpan.');
}

async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data.startsWith('cx:')) return cancelSingle(ctx, data.slice(3));
  if (data.startsWith('cxa:')) return cancelAll(ctx, data.slice(4).split('.').filter(Boolean));
  if (data.startsWith('sv:')) return savePending(ctx, data.slice(3));
  if (data.startsWith('dc:')) return discardPending(ctx, data.slice(3));

  await ctx.answerCallbackQuery();
}

export function registerCallbackHandler(bot: Bot): void {
  bot.on('callback_query:data', handleCallback);
}
