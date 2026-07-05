import { Telegraf } from 'telegraf';
import { db } from './database';
import { logger } from './utils';

// ── Daily Performance Summary ─────────────────────────────────────────────────
// Sends every day at SUMMARY_HOUR UTC (default: 23:00).
// Set SUMMARY_HOUR=23 in Railway env vars to customise.

function buildSummaryText(telegramId: string): string {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const daily = db.getPnLStats(telegramId, new Date(todayStr));
  const weekly = db.getPnLStats(telegramId, weekAgo);
  const monthly = db.getPnLStats(telegramId, monthAgo);
  const allTime = db.getPnLStats(telegramId);

  const recentTrades = db.getClosedTrades(telegramId, 5);

  function pnlLine(label: string, stats: ReturnType<typeof db.getPnLStats>): string {
    const emoji = stats.totalPnl >= 0 ? '🟢' : '🔴';
    const sign = stats.totalPnl >= 0 ? '+' : '-';
    return (
      `${emoji} *${label}*\n` +
      `   💰 PnL: \`${sign}$${Math.abs(stats.totalPnl).toFixed(2)}\`\n` +
      `   ✅ Wins: \`${stats.wins}\`  ❌ Losses: \`${stats.losses}\`  📊 Total: \`${stats.tradeCount}\`\n` +
      `   🏆 Win Rate: \`${stats.winRate.toFixed(1)}%\`\n` +
      `   📈 Best: \`+$${stats.bestTrade.toFixed(2)}\`  📉 Worst: \`-$${Math.abs(stats.worstTrade).toFixed(2)}\`\n` +
      `   📊 Avg PnL: \`${stats.avgPnl >= 0 ? '+' : ''}$${stats.avgPnl.toFixed(2)}\`\n`
    );
  }

  let text =
    `📅 *DAILY PERFORMANCE SUMMARY*\n` +
    `_${todayStr} — ${now.toUTCString().slice(17, 22)} UTC_\n\n` +
    pnlLine('Today', daily) + '\n' +
    pnlLine('This Week', weekly) + '\n' +
    pnlLine('This Month', monthly) + '\n' +
    pnlLine('All Time', allTime);

  if (recentTrades.length > 0) {
    text += `\n📋 *LAST ${recentTrades.length} TRADES*\n`;
    for (const t of recentTrades) {
      const pnl = t.pnl ?? 0;
      const emoji = pnl >= 0 ? '✅' : '❌';
      const sign = pnl >= 0 ? '+' : '';
      text +=
        `${emoji} ${t.symbol} ${t.direction} — \`${sign}$${Math.abs(pnl).toFixed(2)}\`` +
        ` (${t.close_reason ?? 'closed'})\n`;
    }
  }

  // Open positions summary
  const openTrades = db.getOpenTrades(telegramId);
  if (openTrades.length > 0) {
    text += `\n📌 *OPEN POSITIONS: ${openTrades.length}*\n`;
    for (const t of openTrades) {
      const pnl = t.unrealized_pnl ?? 0;
      const sign = pnl >= 0 ? '+' : '';
      text += `▸ ${t.symbol} ${t.direction} — Unrealized: \`${sign}$${Math.abs(pnl).toFixed(2)}\`\n`;
    }
  }

  return text;
}

export function startDailySummaryScheduler(bot: Telegraf): void {
  const summaryHour = parseInt(process.env.SUMMARY_HOUR ?? '23', 10);
  logger.info(`[Scheduler] Daily summary scheduled at ${summaryHour}:00 UTC`);

  // Check every minute whether it's time to send
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() !== summaryHour || now.getUTCMinutes() !== 0) return;

    logger.info('[Scheduler] Sending daily performance summaries...');
    const users = db.getAllUsers().filter(u => u.is_active);

    for (const user of users) {
      try {
        const text = buildSummaryText(user.telegram_id);
        await bot.telegram.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' });
        await new Promise(r => setTimeout(r, 100)); // avoid Telegram rate limit
      } catch (e) {
        logger.error(`[Scheduler] Failed to send summary to ${user.telegram_id}: ${e}`);
      }
    }

    // Admin gets a global summary too
    try {
      const users = db.getAllUsers();
      const openTrades = db.getOpenTrades();
      const allSignals = db.getRecentSignals(100);
      const todaySignals = allSignals.filter(s =>
        s.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)
      );
      await bot.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID!,
        `📊 *[ADMIN] DAILY REPORT*\n\n` +
        `👥 Users: ${users.length} | Active: ${users.filter(u => u.is_active).length}\n` +
        `🔗 Connected: ${users.filter(u => u.api_key_enc).length}\n` +
        `🤖 Auto-Trading ON: ${users.filter(u => u.auto_trade).length}\n` +
        `📈 Open Trades: ${openTrades.length}\n` +
        `📡 Today's Signals: ${todaySignals.length}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }, 60_000); // check every minute
}
