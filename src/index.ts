/**
 * Entry point. Startup order:
 *   1. validate config (imported side-effect in ./config)
 *   2. connect to Sheets (fail fast)
 *   3. load categories from the sheet
 *   4. register middleware + handlers
 *   5. start long polling
 */

import { Bot } from 'grammy';
import { config } from './config';
import { authMiddleware } from './middleware/auth';
import { registerCommandHandlers } from './handlers/commands';
import { registerCallbackHandler } from './handlers/callbacks';
import { registerPhotoHandler } from './handlers/photo';
import { registerTransactionHandler } from './handlers/transaction';
import * as sheets from './services/sheets';
import * as categories from './services/categoryCache';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  logger.info('Menyalakan Budget Bot...', { tz: config.TZ, startDay: config.BUDGET_START_DAY });

  // Fail fast if Sheets is unreachable or misconfigured.
  await sheets.init();
  const cats = await categories.reload();
  logger.info('Kategori dimuat', { count: cats.length });

  const bot = new Bot(config.BOT_TOKEN);

  // Whitelist gate runs before everything else.
  bot.use(authMiddleware);

  // Commands must be registered before the catch-all text handler.
  registerCommandHandlers(bot);
  registerCallbackHandler(bot);
  registerPhotoHandler(bot);
  registerTransactionHandler(bot);

  // Global error boundary: one bad update must never crash the bot.
  bot.catch(async (err) => {
    logger.error('Handler error', err.error);
    try {
      await err.ctx.reply('⚠️ Ada kesalahan sesaat. Coba lagi ya.');
    } catch {
      // ignore — replying failed too
    }
  });

  // Best-effort command menu in the Telegram UI.
  try {
    await bot.api.setMyCommands([
      { command: 'recap', description: 'Rekap periode (arus kas + budget)' },
      { command: 'riwayat', description: 'Transaksi terakhir (kalian berdua)' },
      { command: 'budget', description: 'Lihat / set budget' },
      { command: 'tabungan', description: 'Progres tabungan / set target' },
      { command: 'refresh', description: 'Segarkan Dashboard & Rekap Bulanan' },
      { command: 'undo', description: 'Batalkan transaksi terakhir' },
      { command: 'kategori', description: 'Daftar / tambah / hapus kategori' },
      { command: 'help', description: 'Bantuan' },
    ]);
  } catch (err) {
    logger.warn('Gagal set command menu', err);
  }

  const shutdown = (signal: string) => {
    logger.info(`Menerima ${signal}, mematikan bot...`);
    void bot.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => logger.info('Bot online', { username: info.username }),
  });
}

main().catch((err) => {
  logger.error('Fatal saat startup', err);
  process.exit(1);
});
