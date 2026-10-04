/**
 * Photo & image-document handler: receipts, payment notifications, bank mutations.
 * Downloads the image, runs the vision model, and writes (or asks to confirm on
 * low confidence). One image per update; album members arrive as separate updates
 * and are each processed on their own.
 */

import type { Bot, Context } from 'grammy';
import { config, resolveUserName } from '../config';
import * as categories from '../services/categoryCache';
import { parseImage } from '../services/llm';
import * as sheets from '../services/sheets';
import { logger } from '../utils/logger';
import {
  buildTransactions,
  genId,
  multiConfirm,
  pendingConfirm,
  singleConfirm,
  sisaLine,
} from './persist';
import * as pending from './pending';

async function downloadAsDataUrl(ctx: Context, fileId: string, mime: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('file_path kosong dari Telegram');
  const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Gagal download file: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Extract (fileId, mime) from a photo or an image document, or null if unsupported. */
function pickImage(ctx: Context): { fileId: string; mime: string } | null {
  const photos = ctx.message?.photo;
  if (photos && photos.length > 0) {
    // Largest size: Telegram caps the long side (~1280px), so a tall receipt is
    // already narrow — any smaller rendition makes the small print illegible.
    return { fileId: photos[photos.length - 1].file_id, mime: 'image/jpeg' };
  }
  const doc = ctx.message?.document;
  if (doc && doc.mime_type?.startsWith('image/')) {
    return { fileId: doc.file_id, mime: doc.mime_type };
  }
  return null;
}

async function handlePhoto(ctx: Context): Promise<void> {
  const image = pickImage(ctx);
  if (!image) {
    // e.g. a PDF e-statement: say so instead of silently ignoring it.
    if (ctx.message?.document) {
      await ctx.reply('📄 Hanya gambar (foto / screenshot) yang bisa dibaca. Kirim sebagai foto ya.');
    }
    return;
  }

  const chatId = ctx.from?.id ?? ctx.chat?.id;
  const userName = resolveUserName(chatId ?? 0);
  const caption = ctx.message?.caption?.trim() || undefined;
  const cats = categories.getCategories();
  const sentAt = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();

  const placeholder = await ctx.reply('🔍 Membaca struk...');
  const edit = (text: string, keyboard?: import('grammy').InlineKeyboard) =>
    ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

  let result;
  try {
    const dataUrl = await downloadAsDataUrl(ctx, image.fileId, image.mime);
    result = await parseImage(dataUrl, caption, cats, sentAt);
  } catch (err) {
    logger.error('parseImage gagal', err);
    await edit('⚠️ Gagal membaca gambar. Coba lagi, atau ketik transaksinya manual.');
    return;
  }

  if (result.notReceipt) {
    await edit('🤔 Ini sepertinya bukan struk atau bukti transaksi.');
    return;
  }
  if (result.items.length === 0) {
    await edit('ℹ️ Tidak ada transaksi yang terbaca dari gambar.');
    return;
  }

  const base = `[foto]${caption ? ' ' + caption : ''}`;
  const txs = buildTransactions(result.items, userName, sentAt, base);
  txs.forEach((t, i) => {
    const merch = result.items[i].merchant;
    t.raw_input = `${base}${merch ? ' | merchant: ' + merch : ''}`;
  });

  // Low confidence -> confirm before writing anything to the sheet.
  const lowConfidence = result.items.some((it) => it.confidence === 'low');
  if (lowConfidence) {
    const token = genId();
    pending.put(token, txs, Date.now());
    const { text, keyboard } = pendingConfirm(txs, token);
    await edit(text, keyboard);
    return;
  }

  try {
    await sheets.appendTransactions(txs);
  } catch (err) {
    logger.error('Gagal menulis foto ke Sheets', err);
    await edit('⚠️ Transaksi terbaca tapi gagal disimpan ke Sheets. Coba lagi sebentar.');
    return;
  }

  logger.info('Transaksi foto tercatat', { user: userName, count: txs.length });

  const sisa = await sisaLine(txs);
  if (txs.length === 1) {
    const { text, keyboard } = singleConfirm(txs[0], sisa);
    await edit(text, keyboard);
  } else {
    const { text, keyboard } = multiConfirm(txs, sisa);
    await edit(text, keyboard);
  }
}

export function registerPhotoHandler(bot: Bot): void {
  bot.on('message:photo', handlePhoto);
  bot.on('message:document', handlePhoto);
}
