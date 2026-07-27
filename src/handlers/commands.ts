/**
 * Slash commands: /start /help /recap /budget /undo /kategori.
 */

import type { Bot, Context } from 'grammy';
import { config, resolveUserName } from '../config';
import * as categories from '../services/categoryCache';
import { formatBudgets, formatHistory, formatRecap, formatSavings } from '../services/budget';
import { refreshDashboard } from '../services/dashboard';
import * as sheets from '../services/sheets';
import { formatRupiah, parseRupiah } from '../utils/currency';
import { getCurrentPeriod, getRecentPeriod } from '../utils/period';
import { escapeHtml } from '../services/budget';
import { logger } from '../utils/logger';

const HELP = `👋 <b>Budget Bot</b>

Catat cukup dengan mengetik natural, atau kirim <b>foto struk / screenshot mutasi</b>.

<b>💸 Pengeluaran:</b>
• <i>makan siang 25rb</i>
• <i>grab ke rs 18.500</i>
• <i>makan 25rb, parkir 2rb, kopi 18rb</i> (multi)

<b>💰 Pemasukan:</b>
• <i>gaji 8jt</i> · <i>dapat bonus 2jt</i>

<b>🏦 Tabungan:</b>
• <i>nabung dana darurat 500rb</i> · <i>nabung 1jt buat liburan</i>

<b>Perintah:</b>
/recap — rekap periode (arus kas + budget)
/recap minggu — rekap 7 hari terakhir
/riwayat — transaksi terakhir (kalian berdua) · /riwayat 20
/budget — lihat budget · /budget Makan 2000000 — set budget
/tabungan — progres tabungan · /tabungan Liburan 5000000 — set target
/undo — batalkan transaksi terakhirmu
/kategori — daftar · /kategori tambah &lt;nama&gt; · /kategori hapus &lt;nama&gt;
/refresh — segarkan tampilan Dashboard &amp; Rekap Bulanan`;

async function cmdStart(ctx: Context): Promise<void> {
  await ctx.reply(HELP, { parse_mode: 'HTML' });
}

async function cmdRecap(ctx: Context): Promise<void> {
  const now = new Date();
  const arg = (ctx.match as string | undefined)?.trim().toLowerCase();
  const weekly = arg === 'minggu' || arg === 'week' || arg === '7';

  if (weekly) {
    const period = getRecentPeriod(now, 7);
    const txs = await sheets.getTransactionsInPeriod(period.start, period.end);
    // Weekly spend isn't compared against monthly budgets -> no bars, no footer.
    await ctx.reply(formatRecap(txs, [], period, now, 'Recap 7 hari', false), {
      parse_mode: 'HTML',
    });
    return;
  }

  const period = getCurrentPeriod(now, config.BUDGET_START_DAY);
  const [txs, budgets] = await Promise.all([
    sheets.getTransactionsInPeriod(period.start, period.end),
    sheets.getBudgets(),
  ]);
  await ctx.reply(formatRecap(txs, budgets, period, now), { parse_mode: 'HTML' });
}

async function cmdBudget(ctx: Context): Promise<void> {
  const now = new Date();
  const period = getCurrentPeriod(now, config.BUDGET_START_DAY);
  const arg = (ctx.match as string | undefined)?.trim();

  // No args -> list all budgets.
  if (!arg) {
    const [txs, budgets] = await Promise.all([
      sheets.getTransactionsInPeriod(period.start, period.end),
      sheets.getBudgets(),
    ]);
    await ctx.reply(formatBudgets(txs, budgets, period), { parse_mode: 'HTML' });
    return;
  }

  // "<category words> <amount>" -> set budget.
  const m = /^(.+?)\s+(\S+)$/.exec(arg);
  if (!m) {
    await ctx.reply('Format: <code>/budget &lt;Kategori&gt; &lt;nominal&gt;</code>\nmis: <code>/budget Makan 2000000</code>', {
      parse_mode: 'HTML',
    });
    return;
  }
  const rawCat = m[1].trim();
  const amount = parseRupiah(m[2]);
  if (!amount || amount <= 0) {
    await ctx.reply('Nominal budget tidak valid. Contoh: <code>/budget Makan 2000000</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const cats = categories.getCategories();
  const canonical = cats.find((c) => c.toLowerCase() === rawCat.toLowerCase());
  if (!canonical) {
    await ctx.reply(
      `Kategori "${escapeHtml(rawCat)}" tidak dikenal.\nKategori valid: ${cats.map(escapeHtml).join(', ')}`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    await sheets.setBudget(canonical, amount);
  } catch (err) {
    logger.error('Gagal set budget', err);
    await ctx.reply('⚠️ Gagal menyimpan budget ke Sheets. Coba lagi.');
    return;
  }
  await ctx.reply(`✅ Budget <b>${escapeHtml(canonical)}</b> diset ke ${formatRupiah(amount)}.`, {
    parse_mode: 'HTML',
  });
}

async function cmdTabungan(ctx: Context): Promise<void> {
  const arg = (ctx.match as string | undefined)?.trim();

  // No args -> list savings goals with progress.
  if (!arg) {
    const [allTxs, goals] = await Promise.all([
      sheets.getAllTransactions(),
      sheets.getSavingGoals(),
    ]);
    await ctx.reply(formatSavings(allTxs, goals), { parse_mode: 'HTML' });
    return;
  }

  // "<goal words> <amount>" -> set/update a savings target.
  const m = /^(.+?)\s+(\S+)$/.exec(arg);
  const amount = m ? parseRupiah(m[2]) : null;
  if (!m || !amount || amount <= 0) {
    await ctx.reply(
      'Format: <code>/tabungan &lt;Tujuan&gt; &lt;target&gt;</code>\nmis: <code>/tabungan Liburan 5000000</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }
  const goal = m[1].trim();
  try {
    await sheets.setSavingTarget(goal, amount);
  } catch (err) {
    logger.error('Gagal set target tabungan', err);
    await ctx.reply('⚠️ Gagal menyimpan target ke Sheets. Coba lagi.');
    return;
  }
  await ctx.reply(`✅ Target tabungan <b>${escapeHtml(goal)}</b> diset ke ${formatRupiah(amount)}.`, {
    parse_mode: 'HTML',
  });
}

async function cmdUndo(ctx: Context): Promise<void> {
  const chatId = ctx.from?.id ?? ctx.chat?.id ?? 0;
  const userName = resolveUserName(chatId);
  const last = await sheets.getLastTransactionByUser(userName);
  if (!last) {
    await ctx.reply('Tidak ada transaksi milikmu yang bisa dibatalkan.');
    return;
  }
  const deleted = await sheets.deleteTransactionById(last.id);
  if (!deleted) {
    await ctx.reply('Transaksi terakhir sudah tidak ada.');
    return;
  }
  await ctx.reply(
    `🗑 <b>Dibatalkan</b>\n${formatRupiah(deleted.amount)} — ${escapeHtml(deleted.category)} · ${escapeHtml(deleted.description)}`,
    { parse_mode: 'HTML' },
  );
}

/** "anak & keluarga" -> "Anak & Keluarga" */
function titleCaseName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

const KATEGORI_USAGE =
  'Perintah kategori:\n' +
  '<code>/kategori</code> — lihat daftar\n' +
  '<code>/kategori tambah &lt;nama&gt;</code>\n' +
  '<code>/kategori hapus &lt;nama&gt;</code>\n' +
  '<code>/kategori reload</code>';

async function cmdKategori(ctx: Context): Promise<void> {
  const raw = (ctx.match as string | undefined)?.trim() ?? '';

  if (raw.toLowerCase() === 'reload') {
    const cats = await categories.reload();
    await ctx.reply(`🔄 Kategori dimuat ulang (${cats.length}):\n${cats.map(escapeHtml).join(', ')}`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const m = /^(tambah|add|hapus|hilangkan|remove|del)\s+(.+)$/i.exec(raw);
  if (m) {
    const isAdd = /^(tambah|add)$/i.test(m[1]);
    const name = titleCaseName(m[2]);
    if (!name) {
      await ctx.reply(KATEGORI_USAGE, { parse_mode: 'HTML' });
      return;
    }

    if (isAdd) {
      try {
        const added = await sheets.addCategory(name);
        const cats = await categories.reload();
        await ctx.reply(
          added
            ? `✅ Kategori <b>${escapeHtml(name)}</b> ditambahkan (total ${cats.length}).\n` +
                `<i>Ketik /refresh untuk memunculkan barisnya di tab Dashboard.</i>`
            : `ℹ️ Kategori <b>${escapeHtml(name)}</b> sudah ada.`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error('Gagal tambah kategori', err);
        await ctx.reply('⚠️ Gagal menambah kategori ke Sheets. Coba lagi.');
      }
      return;
    }

    // remove
    if (name.toLowerCase() === 'lainnya') {
      await ctx.reply('❌ Kategori <b>Lainnya</b> tidak bisa dihapus (kategori cadangan).', {
        parse_mode: 'HTML',
      });
      return;
    }
    try {
      const removed = await sheets.removeCategory(name);
      const cats = await categories.reload();
      await ctx.reply(
        removed
          ? `🗑 Kategori <b>${escapeHtml(name)}</b> dihapus (sisa ${cats.length}).\n` +
              `<i>Transaksi lama tetap tersimpan. Ketik /refresh untuk memperbarui tab Dashboard.</i>`
          : `Kategori "${escapeHtml(name)}" tidak ditemukan.\nKategori: ${cats.map(escapeHtml).join(', ')}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.error('Gagal hapus kategori', err);
      await ctx.reply('⚠️ Gagal menghapus kategori dari Sheets. Coba lagi.');
    }
    return;
  }

  // Unknown sub-command with leftover text -> show usage.
  if (raw) {
    await ctx.reply(KATEGORI_USAGE, { parse_mode: 'HTML' });
    return;
  }

  // No args -> list.
  const cats = categories.getCategories();
  await ctx.reply(`🏷 <b>Kategori aktif</b> (${cats.length}):\n${cats.map(escapeHtml).join(', ')}`, {
    parse_mode: 'HTML',
  });
}

async function cmdRiwayat(ctx: Context): Promise<void> {
  const arg = (ctx.match as string | undefined)?.trim();
  let limit = 10;
  if (arg) {
    const n = parseInt(arg, 10);
    if (Number.isInteger(n) && n > 0) limit = Math.min(n, 30);
  }
  const all = await sheets.getAllTransactions();
  const recent = all.slice(-limit).reverse(); // sheet order = send order; newest first
  await ctx.reply(formatHistory(recent), { parse_mode: 'HTML' });
}

async function cmdRefresh(ctx: Context): Promise<void> {
  const placeholder = await ctx.reply('🔄 Menyegarkan Dashboard & Rekap Bulanan...');
  const edit = (text: string) =>
    ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, text, { parse_mode: 'HTML' });
  try {
    const r = await refreshDashboard();
    await edit(
      `✅ <b>Dashboard disegarkan</b>\n${r.categories} kategori · ${r.goals} tujuan tabungan.\n` +
        `Tab Dashboard &amp; Rekap Bulanan sudah terbaru.`,
    );
  } catch (err) {
    logger.error('Gagal refresh dashboard', err);
    await edit('⚠️ Gagal menyegarkan Dashboard. Coba lagi sebentar.');
  }
}

export function registerCommandHandlers(bot: Bot): void {
  bot.command(['start', 'help'], cmdStart);
  bot.command('recap', cmdRecap);
  bot.command('riwayat', cmdRiwayat);
  bot.command('budget', cmdBudget);
  bot.command('tabungan', cmdTabungan);
  bot.command('refresh', cmdRefresh);
  bot.command('undo', cmdUndo);
  bot.command('kategori', cmdKategori);
}
