/**
 * Whitelist gate. Runs before every handler; anyone not in ALLOWED_CHAT_IDS is
 * politely rejected and the update is dropped.
 */

import type { Context, NextFunction } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId !== undefined && config.allowedChatIds.has(chatId)) {
    return next();
  }

  logger.warn('Akses ditolak', { chatId, from: ctx.from?.username });
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Bot ini private.' });
    } else if (ctx.chat) {
      await ctx.reply('🔒 Bot ini private.');
    }
  } catch {
    // ignore — nothing more we can do for a stranger
  }
  // Do not call next(): the update stops here.
}
