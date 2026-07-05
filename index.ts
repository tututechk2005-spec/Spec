import 'dotenv/config';
import { logger } from './utils';
import { getDb, db } from './database';
import { MarketScanner } from './market';
import { createBot } from './bot';
import { executeSignal, restoreTradeMonitors } from './trade';
import { formatSignalMessage, TradingSignal } from './strategy';
import { PriceWebSocket } from './binance';
import { validateEnv } from './config';
import { startDailySummaryScheduler } from './scheduler';
import { isMaintenanceMode } from './admin';

async function main(): Promise<void> {
  logger.info('=========================================');
  logger.info(' Binance Futures AI Trading Bot v2.0');
  logger.info(' Professional Edition — Railway Ready');
  logger.info('=========================================');

  validateEnv();
  getDb();
  logger.info('[Boot] Database ready');

  const scanner = new MarketScanner(false, 90, 60_000);
  const bot = createBot(scanner);

  // ── Signal broadcast + auto-trade ──────────────────────────────────────────
  scanner.on('signal', async (signal: TradingSignal) => {
    logger.info(`[Signal] ${signal.symbol} ${signal.direction} conf=${signal.confidence}%`);

    // Skip auto-execution during maintenance (still notify users)
    const maintenance = isMaintenanceMode();
    if (maintenance) {
      logger.info(`[Signal] Maintenance mode ON — skipping auto-trade`);
    }

    const users = db.getAllUsers().filter(u => u.is_active);

    for (const user of users) {
      try {
        const autoOk = !maintenance && user.auto_trade && user.api_key_enc && signal.confidence >= user.confidence_threshold;

        const sigText = formatSignalMessage(signal) + '\n\n' +
          (maintenance
            ? `⚙️ *Auto Trading paused (maintenance mode)*`
            : user.auto_trade
              ? `⏳ *Executing trade automatically...*`
              : `ℹ️ *Auto Trading is OFF*\nEnable it in the Trading menu to execute automatically.`
          );

        await bot.telegram.sendMessage(user.telegram_id, sigText, { parse_mode: 'Markdown' });

        if (autoOk) {
          await executeSignal(signal, user, bot);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }

    // Admin notification
    try {
      await bot.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID!,
        `📡 *[ADMIN] Signal*\n${signal.symbol} ${signal.direction} conf=${signal.confidence}% RR=${signal.riskReward}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // ── Bot commands list ──────────────────────────────────────────────────────
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🚀 Start the bot & open menu' },
    { command: 'admin', description: '👑 Admin panel (admin only)' }
  ]);

  logger.info('[Boot] Starting Telegram bot...');
  bot.launch({ dropPendingUpdates: true });
  logger.info('[Boot] Bot launched');

  startDailySummaryScheduler(bot);
  logger.info('[Boot] Daily summary scheduler started');

  restoreTradeMonitors(bot);
  logger.info('[Boot] Trade monitors restored');

  await scanner.start();
  logger.info('[Boot] Scanner started');

  // ── Startup message ────────────────────────────────────────────────────────
  try {
    await bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID!,
      `✅ *Bot Started — v2.0*\n\n` +
      `🕐 ${new Date().toUTCString()}\n` +
      `👁 Scanning ${scanner.getPairCount()} pairs\n` +
      `⏱ Interval: 60 seconds\n` +
      `🎯 Confidence: 90%+\n\n` +
      `Send /start to open the menu.`,
      { parse_mode: 'Markdown' }
    );
  } catch {}

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  process.once('SIGINT', () => { scanner.stop(); bot.stop('SIGINT'); process.exit(0); });
  process.once('SIGTERM', () => { scanner.stop(); bot.stop('SIGTERM'); process.exit(0); });

  process.on('unhandledRejection', (reason) => {
    logger.error(`[Boot] Unhandled rejection: ${reason}`);
  });

  process.on('uncaughtException', (err) => {
    logger.error(`[Boot] Uncaught exception: ${err.message}`);
  });

  logger.info('[Boot] ✅ Bot running. Send /start to your bot on Telegram.');
}

main().catch(err => {
  logger.error(`[Boot] Fatal: ${err.message}`);
  process.exit(1);
});
