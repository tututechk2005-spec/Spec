import { MiddlewareFn } from 'telegraf';
import { db } from './database';
import { logger } from './utils';

export function registerUser(): MiddlewareFn<any> {
  return async (ctx, next) => {
    try {
      const from = ctx.from;
      if (!from) return next();
      const telegramId = String(from.id);
      db.upsertUser(telegramId, {
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        role: telegramId === process.env.ADMIN_CHAT_ID ? 'admin' : 'user'
      });
    } catch (e) {
      logger.error('[Middleware] registerUser error: ' + e);
    }
    return next();
  };
}

// ── Safe message operations ───────────────────────────────────────────────────
export async function safeDelete(ctx: any, messageId: number): Promise<void> {
  try { await ctx.telegram.deleteMessage(ctx.chat.id, messageId); } catch {}
}

export async function safeEdit(ctx: any, text: string, keyboard: any): Promise<number | null> {
  try {
    const msg = await ctx.editMessageText(text, {
      parse_mode: 'Markdown', reply_markup: keyboard,
      disable_web_page_preview: true
    });
    return typeof msg === 'object' ? msg.message_id : null;
  } catch {
    // Edit failed (message too old) — send new
    return safeReply(ctx, text, keyboard);
  }
}

export async function safeReply(ctx: any, text: string, keyboard: any): Promise<number | null> {
  try {
    const msg = await ctx.reply(text, {
      parse_mode: 'Markdown', reply_markup: keyboard,
      disable_web_page_preview: true
    });
    return msg.message_id;
  } catch { return null; }
}
