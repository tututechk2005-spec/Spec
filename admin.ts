import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { MarketScanner } from './market';
import { db } from './database';
import { logger } from './utils';
import { getSession, updateSession } from './session';
import {
  adminMainKeyboard, adminNavRow, adminUsersKeyboard,
  adminUserDetailKeyboard, adminBroadcastKeyboard,
  adminMaintenanceKeyboard, homeBtn,
} from './buttons';

// ── Shared state ──────────────────────────────────────────────────────────────
let maintenanceMode = false;

function isAdmin(tgId: string): boolean {
  return tgId === process.env.ADMIN_CHAT_ID;
}

// ── Navigate helper (edit or send) ────────────────────────────────────────────
async function nav(ctx: any, text: string, keyboard: any): Promise<void> {
  const tgId = String(ctx.from!.id);
  const sess = getSession(tgId);
  let newMsgId: number | null = null;
  if (sess.currentMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, sess.currentMessageId, undefined, text, {
        parse_mode: 'Markdown', reply_markup: keyboard, disable_web_page_preview: true,
      });
      newMsgId = sess.currentMessageId;
    } catch {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, sess.currentMessageId); } catch {}
      const msg = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard, disable_web_page_preview: true });
      newMsgId = msg.message_id;
    }
  } else {
    const msg = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard, disable_web_page_preview: true });
    newMsgId = msg.message_id;
  }
  updateSession(tgId, { currentMessageId: newMsgId });
}

// ── Build admin dashboard text ─────────────────────────────────────────────────
function adminDashboardText(scanner: MarketScanner): string {
  const users      = db.getAllUsers();
  const openTrades = db.getOpenTrades();
  const signals    = db.getRecentSignals(100);
  const today      = new Date().toISOString().slice(0, 10);
  const todaySigs  = signals.filter(s => s.created_at.slice(0, 10) === today);

  const upSecs = process.uptime();
  const hh = Math.floor(upSecs / 3600);
  const mm = Math.floor((upSecs % 3600) / 60);

  return (
    `👑 *ADMIN PANEL*\n\n` +
    `🕐 Uptime: ${hh}h ${mm}m\n` +
    `🔧 Maintenance: ${maintenanceMode ? '🟡 ON' : '✅ OFF'}\n\n` +
    `👥 *USERS*\n` +
    `  Total: ${users.length}\n` +
    `  Active: ${users.filter(u => u.is_active).length}\n` +
    `  Banned: ${users.filter(u => !u.is_active).length}\n` +
    `  API Connected: ${users.filter(u => u.api_key_enc).length}\n` +
    `  Auto Trading ON: ${users.filter(u => u.auto_trade).length}\n` +
    `  Testnet: ${users.filter(u => u.testnet).length} | Live: ${users.filter(u => !u.testnet && u.api_key_enc).length}\n\n` +
    `📈 *TRADING*\n` +
    `  Open Trades: ${openTrades.length}\n` +
    `  Today's Signals: ${todaySigs.length}\n` +
    `  Total Signals: ${signals.length}\n\n` +
    `📡 *SCANNER*\n` +
    `  Running: ${scanner.isRunning() ? '✅ Yes' : '❌ No'}\n` +
    `  Pairs: ${scanner.getPairCount()}\n` +
    `  Interval: 60 seconds`
  );
}

export function registerAdminCommands(bot: Telegraf, scanner: MarketScanner): void {

  // ── /start opens admin panel if admin ─────────────────────────────────────
  // (handled in user.ts — admin button in main menu opens admin_home)

  // ── Inline callback handler ────────────────────────────────────────────────
  bot.on('callback_query', async (ctx, next) => {
    const tgId = String(ctx.from!.id);
    if (!isAdmin(tgId)) return next();
    const data = (ctx.callbackQuery as any).data as string;
    if (!data.startsWith('admin_')) return next();
    try { await ctx.answerCbQuery(); } catch {}

    // ── Admin Home ───────────────────────────────────────────────────────────
    if (data === 'admin_home') {
      return nav(ctx, adminDashboardText(scanner), adminMainKeyboard());
    }

    // ── Dashboard ────────────────────────────────────────────────────────────
    if (data === 'admin_dashboard') {
      return nav(ctx, adminDashboardText(scanner), adminMainKeyboard());
    }

    // ── Users list ────────────────────────────────────────────────────────────
    if (data === 'admin_users') {
      const users = db.getAllUsers();
      let text = `👥 *ALL USERS (${users.length})*\n\n`;
      for (const u of users.slice(0, 20)) {
        const conn = u.api_key_enc ? '🔗' : '  ';
        const auto = u.auto_trade  ? '🤖' : '  ';
        const net  = u.testnet     ? '🧪' : '💰';
        const ban  = u.is_active   ? ''   : ' 🚫';
        text += `${conn}${auto}${net} ${u.username ? '@' + u.username : u.first_name || u.telegram_id}${ban}\n`;
      }
      if (users.length > 20) text += `_...and ${users.length - 20} more_`;
      return nav(ctx, text, adminUsersKeyboard(users));
    }

    // ── Individual user detail ────────────────────────────────────────────────
    if (data.startsWith('admin_user_')) {
      const uid  = data.replace('admin_user_', '');
      const user = db.getUser(uid);
      if (!user) return nav(ctx, '❌ User not found.', adminMainKeyboard());
      const stats = db.getPnLStats(uid);
      const text =
        `👤 *USER DETAIL*\n\n` +
        `ID: \`${user.telegram_id}\`\n` +
        `Name: ${user.first_name || '—'} ${user.last_name || ''}\n` +
        `Username: ${user.username ? '@' + user.username : '—'}\n` +
        `Status: ${user.is_active ? '✅ Active' : '🚫 Banned'}\n` +
        `Network: ${user.testnet ? '🧪 Testnet' : '💰 Real Account'}\n` +
        `API Key: ${user.api_key_enc ? '🔑 Connected' : '❌ Not Connected'}\n` +
        `Auto Trade: ${user.auto_trade ? '🟢 ON' : '🔴 OFF'}\n` +
        `Leverage: ${user.leverage}x | Risk: ${user.risk_per_trade}%\n` +
        `Confidence: ${user.confidence_threshold}%\n\n` +
        `📊 *STATS*\n` +
        `Trades: ${stats.tradeCount} | Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
        `Win Rate: ${stats.winRate.toFixed(1)}%\n` +
        `Total PnL: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`;
      return nav(ctx, text, adminUserDetailKeyboard(uid, user.is_active === 1, user.auto_trade === 1));
    }

    // ── Ban / Unban ───────────────────────────────────────────────────────────
    if (data.startsWith('admin_ban_')) {
      const uid  = data.replace('admin_ban_', '');
      const user = db.getUser(uid);
      if (!user) return;
      const newActive = user.is_active ? 0 : 1;
      db.setUserActive(uid, newActive);
      logger.info(`[Admin] User ${uid} ${newActive ? 'unbanned' : 'banned'} by admin`);
      await ctx.answerCbQuery(newActive ? '✅ User unbanned' : '🚫 User banned');
      // Refresh
      const updated = db.getUser(uid)!;
      return nav(ctx,
        `✅ User ${newActive ? 'unbanned' : 'banned'} successfully.`,
        adminUserDetailKeyboard(uid, updated.is_active === 1, updated.auto_trade === 1)
      );
    }

    // ── Force disable auto-trade ──────────────────────────────────────────────
    if (data.startsWith('admin_autotrade_')) {
      const uid  = data.replace('admin_autotrade_', '');
      const user = db.getUser(uid);
      if (!user) return;
      const newVal = user.auto_trade ? 0 : 1;
      db.setUserSetting(uid, 'auto_trade', newVal);
      await ctx.answerCbQuery(`Auto trade ${newVal ? 'enabled' : 'disabled'}`);
      const updated = db.getUser(uid)!;
      return nav(ctx,
        `✅ Auto-trade ${newVal ? 'enabled' : 'disabled'} for user ${uid}.`,
        adminUserDetailKeyboard(uid, updated.is_active === 1, updated.auto_trade === 1)
      );
    }

    // ── Force disconnect API ──────────────────────────────────────────────────
    if (data.startsWith('admin_disconnect_')) {
      const uid = data.replace('admin_disconnect_', '');
      db.clearUserApiKeys(uid);
      logger.info(`[Admin] API keys cleared for user ${uid}`);
      await ctx.answerCbQuery('🔌 API keys removed');
      return nav(ctx, `✅ API keys disconnected for user \`${uid}\`.`, adminMainKeyboard());
    }

    // ── Statistics ────────────────────────────────────────────────────────────
    if (data === 'admin_stats') {
      const allTrades = db.getAllTrades(500);
      const closed    = allTrades.filter(t => t.status === 'CLOSED');
      const wins      = closed.filter(t => (t.pnl ?? 0) > 0);
      const totalPnl  = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const wr        = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0';
      const text =
        `📈 *GLOBAL STATISTICS*\n\n` +
        `📊 Total Trades: ${allTrades.length}\n` +
        `✅ Closed: ${closed.length}\n` +
        `📂 Open: ${allTrades.length - closed.length}\n` +
        `🏆 Wins: ${wins.length}\n` +
        `❌ Losses: ${closed.length - wins.length}\n` +
        `📊 Win Rate: ${wr}%\n` +
        `💰 Total Bot PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n\n` +
        `_Best trade: +$${Math.max(0, ...closed.map(t => t.pnl ?? 0)).toFixed(2)}_\n` +
        `_Worst trade: -$${Math.abs(Math.min(0, ...closed.map(t => t.pnl ?? 0))).toFixed(2)}_`;
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Signals ───────────────────────────────────────────────────────────────
    if (data === 'admin_signals') {
      const signals = db.getRecentSignals(15);
      let text = `📡 *RECENT SIGNALS (${signals.length})*\n\n`;
      if (signals.length === 0) { text += '_No signals generated yet._'; }
      for (const s of signals) {
        const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
        text += `▸ *${s.symbol}* ${dir} — ${s.confidence}% — ${s.created_at.slice(0, 16)}\n`;
      }
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Trading overview ──────────────────────────────────────────────────────
    if (data === 'admin_trading') {
      const open = db.getOpenTrades();
      let text = `💹 *ALL OPEN TRADES (${open.length})*\n\n`;
      if (open.length === 0) { text += '_No open trades._'; }
      for (const t of open.slice(0, 15)) {
        const pnl  = t.unrealized_pnl ?? 0;
        const sign = pnl >= 0 ? '+' : '';
        text += `▸ *${t.symbol}* ${t.direction} — PnL: \`${sign}$${Math.abs(pnl).toFixed(2)}\`\n`;
      }
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── API Keys overview ─────────────────────────────────────────────────────
    if (data === 'admin_apikeys') {
      const users   = db.getAllUsers();
      const conn    = users.filter(u => u.api_key_enc);
      const testnet = conn.filter(u => u.testnet);
      const live    = conn.filter(u => !u.testnet);
      const text =
        `🔑 *API KEY OVERVIEW*\n\n` +
        `Total Connected: ${conn.length} / ${users.length}\n` +
        `🧪 Testnet: ${testnet.length}\n` +
        `💰 Live: ${live.length}\n` +
        `❌ Not Connected: ${users.length - conn.length}\n\n` +
        `_API keys are AES-256 encrypted. Never stored in plain text._`;
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Logs ─────────────────────────────────────────────────────────────────
    if (data === 'admin_logs') {
      const logs = db.getRecentDbLogs(20);
      let text   = `📜 *RECENT LOGS (${logs.length})*\n\n`;
      if (logs.length === 0) text += '_No logs yet._';
      for (const l of logs) {
        const lvl = l.level === 'error' ? '🔴' : l.level === 'warn' ? '🟡' : '🟢';
        text += `${lvl} \`${l.category}\` ${l.message.slice(0, 70)}\n`;
      }
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Database info ─────────────────────────────────────────────────────────
    if (data === 'admin_db') {
      const dbPath = process.env.DB_PATH ?? './database.db';
      let size = '—';
      try {
        const stat = fs.statSync(dbPath);
        size = `${(stat.size / 1024).toFixed(1)} KB`;
      } catch {}
      const users  = db.getAllUsers();
      const trades = db.getAllTrades(9999).length;
      const text =
        `🗄 *DATABASE INFO*\n\n` +
        `Path: \`${path.resolve(dbPath)}\`\n` +
        `Size: ${size}\n` +
        `Users: ${users.length}\n` +
        `Trades: ${trades}\n` +
        `Signals: ${db.getRecentSignals(9999).length}\n\n` +
        `_SQLite via better-sqlite3_`;
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Settings ─────────────────────────────────────────────────────────────
    if (data === 'admin_settings') {
      const text =
        `⚙️ *BOT SETTINGS*\n\n` +
        `Scanner Interval: 60 seconds\n` +
        `Min Confidence: 90%\n` +
        `Session Filter: London + New York\n` +
        `Summary Hour: ${process.env.SUMMARY_HOUR ?? '23'}:00 UTC\n` +
        `Maintenance Mode: ${maintenanceMode ? '🟡 ON' : '✅ OFF'}\n\n` +
        `_Edit via Railway environment variables._`;
      return nav(ctx, text, { inline_keyboard: [adminNavRow()] });
    }

    // ── Broadcast ─────────────────────────────────────────────────────────────
    if (data === 'admin_broadcast') {
      updateSession(String(ctx.from!.id), { inputState: 'admin_broadcast' });
      return nav(ctx,
        `📢 *BROADCAST*\n\n` +
        `Type your message below and send it.\n` +
        `It will be delivered to all active users.\n\n` +
        `_Send a text message now:_`,
        adminBroadcastKeyboard()
      );
    }

    if (data === 'admin_broadcast_send') {
      return nav(ctx, '📢 Type your broadcast message and send it as a text.', adminBroadcastKeyboard());
    }

    // ── Maintenance ───────────────────────────────────────────────────────────
    if (data === 'admin_maintenance') {
      return nav(ctx,
        `🔧 *MAINTENANCE MODE*\n\n` +
        `Current: ${maintenanceMode ? '🟡 ON — bot paused for users' : '✅ OFF — bot running normally'}\n\n` +
        `When ON: users receive a maintenance notice instead of commands.`,
        adminMaintenanceKeyboard(maintenanceMode)
      );
    }

    if (data === 'admin_toggle_maintenance') {
      maintenanceMode = !maintenanceMode;
      logger.info(`[Admin] Maintenance mode ${maintenanceMode ? 'enabled' : 'disabled'}`);
      await ctx.answerCbQuery(maintenanceMode ? '🔧 Maintenance ON' : '✅ Maintenance OFF');
      return nav(ctx,
        `🔧 Maintenance mode is now *${maintenanceMode ? 'ON' : 'OFF'}*.`,
        adminMaintenanceKeyboard(maintenanceMode)
      );
    }

    // ── Restart ────────────────────────────────────────────────────────────────
    if (data === 'admin_restart') {
      await nav(ctx, '🔁 *Restarting bot in 3 seconds...*', { inline_keyboard: [adminNavRow()] });
      setTimeout(() => process.exit(0), 3000);
      return;
    }

    // ── Backup ────────────────────────────────────────────────────────────────
    if (data === 'admin_backup') {
      const dbPath = process.env.DB_PATH ?? './database.db';
      const bkPath = dbPath.replace('.db', `-backup-${Date.now()}.db`);
      try {
        fs.copyFileSync(dbPath, bkPath);
        return nav(ctx, `💾 *Backup Created*\n\nFile: \`${path.basename(bkPath)}\``, { inline_keyboard: [adminNavRow()] });
      } catch (e: any) {
        return nav(ctx, `❌ Backup failed: ${e.message}`, { inline_keyboard: [adminNavRow()] });
      }
    }

    // ── Restore ───────────────────────────────────────────────────────────────
    if (data === 'admin_restore') {
      return nav(ctx,
        `📥 *Database Restore*\n\n` +
        `To restore, copy your backup \`.db\` file to the Railway volume as \`database.db\` and restart the bot.\n\n` +
        `Use 💾 Backup DB to create backups first.`,
        { inline_keyboard: [adminNavRow()] }
      );
    }
  });

  // ── Text handler: broadcast ───────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const tgId = String(ctx.from!.id);
    if (!isAdmin(tgId)) return next();
    const sess = getSession(tgId);
    if (sess.inputState !== 'admin_broadcast') return next();

    const text  = (ctx.message as any).text as string;
    const users = db.getAllUsers().filter(u => u.is_active);
    let sent = 0;
    updateSession(tgId, { inputState: 'idle' });
    try { await ctx.deleteMessage(); } catch {}

    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.telegram_id,
          `📢 *Admin Announcement*\n\n${text}`, { parse_mode: 'Markdown' }
        );
        sent++;
        await new Promise(r => setTimeout(r, 60));
      } catch {}
    }
    logger.info(`[Admin] Broadcast sent to ${sent}/${users.length} users`);
    await nav(ctx, `✅ *Broadcast Sent*\n\nDelivered to ${sent} / ${users.length} active users.`, adminMainKeyboard());
  });

  // ── Export maintenance state ──────────────────────────────────────────────
}

export function isMaintenanceMode(): boolean { return maintenanceMode; }
