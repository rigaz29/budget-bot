/**
 * Free-text transaction handler: parse -> write -> confirm.
 * Falls back to a regex rupiah parser when the LLM is unavailable.
 */

import type { Bot, Context } from 'grammy';
import { resolveUserName } from '../config';
import * as categories from '../services/categoryCache';
import { parseTransaction } from '../services/llm';
import * as sheets from '../services/sheets';
import type { ParsedTransaction } from '../types';
import { parseRupiah } from '../utils/currency';
import { logger } from '../utils/logger';
import { buildTransactions, multiConfirm, singleConfirm } from './persist';

const NEEDS_NOMINAL =
  '❌ Gagal memahami input, coba format: <code>deskripsi nominal</code> (mis: makan siang 25rb)';

async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;

  const chatId = ctx.from?.id ?? ctx.chat?.id;
  const userName = resolveUserName(chatId ?? 0);
  const cats = categories.getCategories();

  let items: ParsedTransaction[] = [];
  let llmFailed = false;
  try {
    items = await parseTransaction(text, cats);
  } catch (err) {
    llmFailed = true;
    logger.error('parseTransaction gagal', err);
  }

  // Fallback: LLM errored, or returned nothing but the text clearly has a number.
  if (items.length === 0 && (llmFailed || /\d/.test(text))) {
    const amount = parseRupiah(text);
    if (amount && amount > 0) {
      items = [
        {
          amount,
          category: cats.find((c) => c.toLowerCase() === 'lainnya') ?? 'Lainnya',
          description: text.slice(0, 80),
          payment_method: 'cash',
          date_offset: 0,
          type: 'expense',
        },
      ];
    }
  }

  if (items.length === 0) {
    // No number at all -> most likely a greeting/question; nudge gently.
    if (!/\d/.test(text)) {
      await ctx.reply(
        'Kirim transaksi seperti: <i>makan siang 25rb</i>, atau foto struk. Ketik /help untuk bantuan.',
        { parse_mode: 'HTML' },
      );
    } else {
      await ctx.reply(NEEDS_NOMINAL, { parse_mode: 'HTML' });
    }
    return;
  }

  const now = new Date();
  const txs = buildTransactions(items, userName, now, text);

  try {
    await sheets.appendTransactions(txs);
  } catch (err) {
    logger.error('Gagal menulis ke Sheets', err);
    await ctx.reply('⚠️ Transaksi terparsing tapi gagal disimpan ke Sheets. Coba lagi sebentar.');
    return;
  }

  logger.info('Transaksi tercatat', { user: userName, count: txs.length });

  if (txs.length === 1) {
    const { text: msg, keyboard } = singleConfirm(txs[0]);
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    const { text: msg, keyboard } = multiConfirm(txs);
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export function registerTransactionHandler(bot: Bot): void {
  bot.on('message:text', handleText);
}
