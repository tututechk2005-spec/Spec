import { Telegraf } from 'telegraf';
import { registerUser } from './telegram';
import { registerUserCommands } from './user';
import { registerAdminCommands } from './admin';
import { MarketScanner } from './market';
import { logger } from './utils';

export function createBot(scanner: MarketScanner): Telegraf {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const bot = new Telegraf(token, { handlerTimeout: 90_000 });
  bot.use(registerUser());
  registerUserCommands(bot, scanner);
  registerAdminCommands(bot, scanner);
  bot.catch((err: unknown, ctx) => {
    logger.error(`[Bot] Error ${ctx.updateType}: ${(err as Error)?.message || err}`);
    ctx.reply('❌ An error occurred. Please try again.').catch(() => {});
  });
  return bot;
}
