import { Telegraf, Markup } from 'telegraf';
import { MarketScanner } from './market';
import { db, User } from './database';
import { encrypt, maskKey } from './config';
import {
  mainMenuKeyboard, tradingMenuKeyboard, connectionTypeKeyboard,
  dashboardKeyboard, openTradesKeyboard, tradeManagementKeyboard,
  settingsKeyboard, disconnectConfirmKeyboard, signalsKeyboard,
  scanKeyboard, historyKeyboard, profileMenuKeyboard,
  closeAllConfirmKeyboard, connectionActionsKeyboard, autoTradeKeyboard,
} from './buttons';
import { getSession, updateSession, clearDashboard, resetInput } from './session';
import { safeDelete, safeEdit, safeReply } from './telegram';
import { buildClientForUser, BinanceClient, validateApiKeys } from './binance';
import { closePositionForTrade, reversePositionForTrade } from './trade';
import { formatSignalMessage } from './strategy';
import { logger } from './utils';

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAdmin(tgId: string): boolean { return tgId === process.env.ADMIN_CHAT_ID; }
function pnlEmoji(v: number) { return v >= 0 ? '🟢' : '🔴'; }
function pnlSign(v: number)  { return v >= 0 ? '+' : ''; }
function fmtPct(v: number)   { return `${pnlSign(v)}${v.toFixed(2)}%`; }

// ── Navigate: edit or replace the current bot message ────────────────────────
async function navigate(ctx: any, text: string, keyboard: any): Promise<void> {
  const tgId = String(ctx.from!.id);
  const sess  = getSession(tgId);
  clearDashboard(tgId);
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

// ── Update prompt text without changing keyboard ──────────────────────────────
async function updatePrompt(ctx: any, tgId: string, text: string): Promise<void> {
  const sess = getSession(tgId);
  if (sess.currentMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, sess.currentMessageId, undefined, text, { parse_mode: 'Markdown' });
      return;
    } catch {}
  }
  const msg = await ctx.reply(text, { parse_mode: 'Markdown' });
  updateSession(tgId, { currentMessageId: msg.message_id });
}

async function answerCb(ctx: any, text = ''): Promise<void> {
  try { await ctx.answerCbQuery(text); } catch {}
}

// ── Home / Main Menu ──────────────────────────────────────────────────────────
async function showHome(ctx: any): Promise<void> {
  const tgId      = String(ctx.from!.id);
  clearDashboard(tgId);
  resetInput(tgId);

  const user      = db.getUser(tgId);
  const connected = !!(user?.api_key_enc);
  const autoOn    = user?.auto_trade === 1;
  const net       = user?.testnet ? '🧪 Testnet' : '💰 Real Account';

  const text =
    `🤖 *Binance Futures AI Trading Bot*\n\n` +
    `👤 Welcome, *${ctx.from!.first_name || 'Trader'}*\n\n` +
    `📡 Exchange: ${connected ? `✅ Connected (${net})` : '❌ Not Connected'}\n` +
    `🤖 Auto Trading: ${autoOn ? '🟢 ON' : '🔴 OFF'}\n\n` +
    `_Select an option below:_`;

  await navigate(ctx, text, mainMenuKeyboard(isAdmin(tgId)));
}

// ── Live Dashboard builder ─────────────────────────────────────────────────────
async function buildDashboardText(user: User, client: BinanceClient): Promise<string> {
  try {
    const [acct, positions] = await Promise.all([
      client.getAccountInfo(),
      client.getPositions(),
    ]);
    const openTrades = db.getOpenTrades(user.telegram_id);
    const pnlStats   = db.getPnLStats(user.telegram_id);
    const todayPnl   = db.getPnLStats(user.telegram_id, new Date(new Date().toISOString().slice(0, 10))).totalPnl;
    const net        = user.testnet ? '🧪 Testnet' : '💰 Real Account';

    let text =
      `📊 *LIVE DASHBOARD*\n` +
      `_Updated: ${new Date().toUTCString().replace(' GMT', 'Z')}_\n\n` +
      `🔗 *Network:* ${net}\n` +
      `🤖 *Auto Trading:* ${user.auto_trade ? '🟢 ON' : '🔴 OFF'}\n` +
      `⚡ *Leverage:* ${user.leverage}x | 📉 *Risk:* ${user.risk_per_trade}%/trade\n\n` +
      `💼 *WALLET*\n` +
      `💰 Balance: \`$${acct.totalWalletBalance.toFixed(2)}\`\n` +
      `✅ Available: \`$${acct.totalAvailableBalance.toFixed(2)}\`\n` +
      `📊 Margin Balance: \`$${acct.totalMarginBalance.toFixed(2)}\`\n` +
      `🔒 Used Margin: \`$${acct.totalInitialMargin.toFixed(2)}\`\n\n` +
      `📈 *P&L SUMMARY*\n` +
      `Today: ${pnlEmoji(todayPnl)} \`${pnlSign(todayPnl)}$${Math.abs(todayPnl).toFixed(2)}\`\n` +
      `All Time: ${pnlEmoji(pnlStats.totalPnl)} \`${pnlSign(pnlStats.totalPnl)}$${Math.abs(pnlStats.totalPnl).toFixed(2)}\`\n` +
      `Unrealized: ${pnlEmoji(acct.totalUnrealizedProfit)} \`${pnlSign(acct.totalUnrealizedProfit)}$${Math.abs(acct.totalUnrealizedProfit).toFixed(2)}\`\n` +
      `Win Rate: \`${pnlStats.winRate.toFixed(1)}%\` (${pnlStats.wins}W / ${pnlStats.losses}L)\n\n`;

    if (positions.length > 0) {
      text += `📌 *OPEN POSITIONS (${positions.length})*\n`;
      for (const pos of positions) {
        const dir = pos.positionAmt > 0 ? '🟢 LONG' : '🔴 SHORT';
        const roi = pos.initialMargin > 0 ? (pos.unRealizedProfit / pos.initialMargin) * 100 : 0;
        text +=
          `\n▸ *${pos.symbol}* ${dir}\n` +
          `  Entry: \`${pos.entryPrice}\` → Mark: \`${pos.markPrice.toFixed(4)}\`\n` +
          `  Qty: \`${Math.abs(pos.positionAmt)}\` | Lev: \`${pos.leverage}x\`\n` +
          `  Liq: \`${pos.liquidationPrice.toFixed(4)}\`\n` +
          `  PnL: ${pnlEmoji(pos.unRealizedProfit)} \`${pnlSign(pos.unRealizedProfit)}$${Math.abs(pos.unRealizedProfit).toFixed(2)}\` (${fmtPct(roi)})\n`;
      }
    } else {
      text += `📌 *OPEN POSITIONS:* None\n`;
    }
    text += `\n🤖 *Bot Trades:* ${openTrades.length} open | ${pnlStats.tradeCount} total`;
    return text;
  } catch (err: any) {
    logger.error(`[Dashboard] ${err.message}`);
    return `📊 *LIVE DASHBOARD*\n\n❌ Error loading data:\n\`${err?.message || 'Connection failed'}\`\n\nCheck your API keys and try again.`;
  }
}

async function showDashboard(ctx: any, tgId: string): Promise<void> {
  const user = db.getUser(tgId);
  if (!user?.api_key_enc) {
    return navigate(ctx, `❌ *No Exchange Connected*\n\nConnect your Binance account first.`, connectionTypeKeyboard());
  }
  const client = buildClientForUser(user);
  if (!client) return navigate(ctx, '❌ Invalid API keys. Please reconnect.', mainMenuKeyboard(isAdmin(tgId)));

  const text = await buildDashboardText(user, client);
  await navigate(ctx, text, dashboardKeyboard());

  // Auto-refresh every 5 seconds
  const interval = setInterval(async () => {
    try {
      const freshUser = db.getUser(tgId);
      if (!freshUser?.api_key_enc) { clearDashboard(tgId); return; }
      const c = buildClientForUser(freshUser);
      if (!c) return;
      const newText = await buildDashboardText(freshUser, c);
      const msgId   = getSession(tgId).currentMessageId;
      if (!msgId) return;
      await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, newText, {
        parse_mode: 'Markdown', reply_markup: dashboardKeyboard(), disable_web_page_preview: true,
      }).catch(() => {});
    } catch {}
  }, 5000);

  updateSession(tgId, { dashboardInterval: interval });
}

// ── Open Trades panel ─────────────────────────────────────────────────────────
async function buildTradesText(user: User, client: BinanceClient): Promise<{ text: string; firstTradeId: number }> {
  const botTrades = db.getOpenTrades(user.telegram_id);
  let positions: any[] = [];
  try { positions = await client.getPositions(); } catch {}

  if (positions.length === 0 && botTrades.length === 0) {
    return { text: '📈 *OPEN TRADES*\n\nNo open positions found.', firstTradeId: 0 };
  }

  let text        = `📈 *OPEN POSITIONS*\n_${new Date().toUTCString().replace(' GMT', 'Z')}_\n\n`;
  let firstTradeId = botTrades[0]?.id || 0;

  for (const pos of positions) {
    const dir = pos.positionAmt > 0 ? '🟢 LONG' : '🔴 SHORT';
    const roi = pos.initialMargin > 0 ? (pos.unRealizedProfit / pos.initialMargin) * 100 : 0;
    text +=
      `📌 *${pos.symbol}* ${dir}\n` +
      `  Entry: \`${pos.entryPrice}\` | Mark: \`${pos.markPrice.toFixed(4)}\`\n` +
      `  Qty: \`${Math.abs(pos.positionAmt)}\` | Lev: \`${pos.leverage}x\`\n` +
      `  Margin: \`$${pos.initialMargin.toFixed(2)}\` | Liq: \`${pos.liquidationPrice.toFixed(4)}\`\n` +
      `  PnL: ${pnlEmoji(pos.unRealizedProfit)} \`${pnlSign(pos.unRealizedProfit)}$${Math.abs(pos.unRealizedProfit).toFixed(2)}\` (${fmtPct(roi)})\n\n`;
  }

  for (const t of botTrades) {
    const pnl = t.unrealized_pnl ?? 0;
    text +=
      `🤖 *Bot Trade #${t.id}* — ${t.symbol} ${t.direction}\n` +
      `  SL: \`${t.stop_loss ?? 'N/A'}\` | TP: \`${t.take_profit ?? 'N/A'}\`\n` +
      `  Confidence: \`${t.confidence ?? 0}%\` | PnL: ${pnlEmoji(pnl)} \`${pnlSign(pnl)}$${Math.abs(pnl).toFixed(2)}\`\n\n`;
  }

  return { text, firstTradeId };
}

// ── Register all user commands & callbacks ────────────────────────────────────
export function registerUserCommands(bot: Telegraf, scanner: MarketScanner): void {

  // /start — always works
  bot.command('start', async (ctx) => {
    const tgId = String(ctx.from!.id);
    try { await ctx.deleteMessage(); } catch {}
    const sess = getSession(tgId);
    if (sess.currentMessageId) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, sess.currentMessageId); } catch {}
      updateSession(tgId, { currentMessageId: null });
    }
    await showHome(ctx);
  });

  // ── Text input handler ─────────────────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const tgId = String(ctx.from!.id);
    const sess  = getSession(tgId);
    const text  = (ctx.message as any).text?.trim() ?? '';
    if (!text || text.startsWith('/')) return next();
    try { await ctx.deleteMessage(); } catch {}

    if (sess.inputState === 'idle' || sess.inputState === 'admin_broadcast') return next();

    // ── Step 1: collect API Key ──────────────────────────────────────────────
    if (sess.inputState === 'await_api_key') {
      updateSession(tgId, { tempApiKey: text, inputState: 'await_api_secret' });
      await updatePrompt(ctx, tgId,
        `🔐 *Step 2 of 2 — API Secret*\n\n` +
        `✅ API Key received\n\n` +
        `Now send your *API Secret:*\n\n` +
        `⚠️ Your message is deleted immediately for security`
      );
      return;
    }

    // ── Step 2: collect API Secret → validate strictly ───────────────────────
    if (sess.inputState === 'await_api_secret') {
      if (!sess.tempApiKey) { resetInput(tgId); return; }
      const user = db.getUser(tgId);
      if (!user) return;

      const selectedTestnet = sess.tempTestnet ?? false;
      const networkLabel    = selectedTestnet ? '🧪 Testnet' : '💰 Live';

      await updatePrompt(ctx, tgId,
        `⏳ *Validating API Keys...*\n\n` +
        `Network: ${networkLabel}\n` +
        `Connecting to Binance — please wait a few seconds.`
      );

      logger.info(`[API Validate] User ${tgId} validating on ${networkLabel}`);

      try {
        // STRICT: only tests the network the user selected — never tries both
        const result = await validateApiKeys(sess.tempApiKey, text, selectedTestnet);

        if (!result.valid) {
          logger.warn(`[API Validate] Failed for user ${tgId}: ${result.reason}`);
          db.dbLog('warn', 'API_VALIDATE', `User ${tgId} validation failed: ${result.reason}`);

          const errorMsg =
            `❌ *API Validation Failed*\n\n` +
            `Network tested: ${networkLabel}\n\n` +
            `*Reason:*\n${result.reason}\n\n` +
            `*Checklist:*\n` +
            `• ✅ Enable *Futures Trading* permission on the key\n` +
            `• ✅ Enable *Read Info* permission on the key\n` +
            `• ✅ Remove IP restrictions (or whitelist your server IP)\n` +
            `• ✅ Make sure you selected the correct network above\n` +
            `   (Testnet keys → 🧪 Testnet | Live keys → 💰 Real)\n\n` +
            `Please try again — send your *API Key:*`;

          await updatePrompt(ctx, tgId, errorMsg);
          updateSession(tgId, { inputState: 'await_api_key', tempApiKey: null });
          return;
        }

        logger.info(`[API Validate] ✅ Success for user ${tgId} on ${networkLabel}`);
        db.dbLog('info', 'API_VALIDATE', `User ${tgId} connected successfully on ${selectedTestnet ? 'testnet' : 'live'}`);

        db.setUserApiKeys(tgId, encrypt(sess.tempApiKey), encrypt(text), selectedTestnet ? 1 : 0);
        resetInput(tgId);

        await navigate(ctx,
          `✅ *Exchange Connected Successfully!*\n\n` +
          `🔗 Network: ${selectedTestnet ? '🧪 Testnet' : '💰 Real Account'}\n` +
          `🔑 API Key: \`${maskKey(sess.tempApiKey)}\`\n` +
          `📊 Read: ✅ | Futures: ✅\n\n` +
          `🔒 Keys encrypted with AES-256.\n` +
          `You can now use the Dashboard and Auto Trading.`,
          mainMenuKeyboard(isAdmin(tgId))
        );
      } catch (err: any) {
        logger.error(`[API Validate] Exception for user ${tgId}: ${err.message}`);
        resetInput(tgId);
        await navigate(ctx, `❌ *Unexpected Error*\n\n${err.message}`, mainMenuKeyboard(isAdmin(tgId)));
      }
      return;
    }

    // ── Settings text inputs ─────────────────────────────────────────────────
    if (sess.inputState === 'await_sl' && sess.editingTradeId) {
      const val = parseFloat(text);
      if (!isNaN(val) && val > 0) {
        db.updateTradeSL(sess.editingTradeId, val);
        resetInput(tgId);
        return navigate(ctx, `✅ *Stop Loss Updated*\n\nNew SL: \`${val}\``, mainMenuKeyboard(isAdmin(tgId)));
      }
      await updatePrompt(ctx, tgId, `❌ Invalid price. Send a positive number:`);
      return;
    }

    if (sess.inputState === 'await_tp' && sess.editingTradeId) {
      const val = parseFloat(text);
      if (!isNaN(val) && val > 0) {
        db.updateTradeTP(sess.editingTradeId, val);
        resetInput(tgId);
        return navigate(ctx, `✅ *Take Profit Updated*\n\nNew TP: \`${val}\``, mainMenuKeyboard(isAdmin(tgId)));
      }
      await updatePrompt(ctx, tgId, `❌ Invalid price. Send a positive number:`);
      return;
    }

    if (sess.inputState === 'await_leverage') {
      const val = parseInt(text, 10);
      if (!isNaN(val) && val >= 1 && val <= 125) {
        db.updateUserSettings(tgId, { leverage: val });
        resetInput(tgId);
        return navigate(ctx, `✅ *Leverage Updated*\n\nNew Leverage: \`${val}x\``, settingsKeyboard());
      }
      await updatePrompt(ctx, tgId, `❌ Invalid value. Enter a number between 1 and 125:`);
      return;
    }

    if (sess.inputState === 'await_risk') {
      const val = parseFloat(text);
      if (!isNaN(val) && val > 0 && val <= 100) {
        db.updateUserSettings(tgId, { risk_per_trade: val });
        resetInput(tgId);
        return navigate(ctx, `✅ *Risk Updated*\n\nNew Risk per Trade: \`${val}%\``, settingsKeyboard());
      }
      await updatePrompt(ctx, tgId, `❌ Invalid value. Enter a number between 0.1 and 100:`);
      return;
    }

    if (sess.inputState === 'await_confidence') {
      const val = parseFloat(text);
      if (!isNaN(val) && val >= 50 && val <= 99) {
        db.updateUserSettings(tgId, { confidence_threshold: val });
        resetInput(tgId);
        return navigate(ctx, `✅ *Confidence Updated*\n\nNew Threshold: \`${val}%\``, settingsKeyboard());
      }
      await updatePrompt(ctx, tgId, `❌ Invalid value. Enter a number between 50 and 99:`);
      return;
    }

    if (sess.inputState === 'await_symbol_analyse') {
      const raw    = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const symbol = raw.endsWith('USDT') ? raw : raw + 'USDT';
      resetInput(tgId);
      await navigate(ctx, `🔍 *Analysing ${symbol}...*\n\nPlease wait.`, mainMenuKeyboard(isAdmin(tgId)));
      try {
        const signal = await scanner.scanSingle(symbol);
        if (signal) {
          return navigate(ctx, `🔎 *${symbol} Analysis*\n\n` + formatSignalMessage(signal), signalsKeyboard());
        }
        return navigate(ctx,
          `🔎 *${symbol} Analysis*\n\n⚠️ No high-confidence signal found.\n\nPossible reasons:\n• Market in consolidation\n• Outside London/NY session\n• Indicators not aligned (< 90%)\n\nTry again later.`,
          scanKeyboard()
        );
      } catch {
        return navigate(ctx, `❌ Analysis failed. *${symbol}* may not exist on Binance Futures.`, mainMenuKeyboard(isAdmin(tgId)));
      }
    }
  });

  // ── Callback Query Handler ─────────────────────────────────────────────────
  bot.on('callback_query', async (ctx, next) => {
    const tgId = String(ctx.from!.id);
    const data  = (ctx.callbackQuery as any).data as string;

    // Let admin.ts handle its own callbacks
    if (data.startsWith('admin_')) return next();

    await answerCb(ctx);
    await handleCallback(ctx, tgId, data, scanner);
  });
}

// ── Main callback router ──────────────────────────────────────────────────────
async function handleCallback(ctx: any, tgId: string, data: string, scanner: MarketScanner): Promise<void> {
  const user = db.getUser(tgId);

  // ── Close menu (delete the message entirely) ───────────────────────────────
  if (data === 'close_menu') {
    clearDashboard(tgId);
    resetInput(tgId);
    const sess = getSession(tgId);
    if (sess.currentMessageId) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, sess.currentMessageId); } catch {}
      updateSession(tgId, { currentMessageId: null });
    }
    return;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  if (data === 'home' || data === 'back') return showHome(ctx);

  // ── Main menu sections ─────────────────────────────────────────────────────
  if (data === 'trading') {
    return navigate(ctx,
      `📈 *TRADING*\n\nManage your positions, view the dashboard, and scan for setups.`,
      tradingMenuKeyboard()
    );
  }

  if (data === 'profile') {
    return handleCallback(ctx, tgId, 'account', scanner);
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  if (data === 'dashboard' || data === 'dashboard_refresh') {
    return showDashboard(ctx, tgId);
  }

  // ── Connect Exchange ───────────────────────────────────────────────────────
  if (data === 'connect') {
    if (user?.api_key_enc) {
      return navigate(ctx,
        `✅ *Exchange Already Connected*\n\n` +
        `Network: ${user.testnet ? '🧪 Testnet' : '💰 Real Account'}\n\n` +
        `Would you like to reconnect with different keys or disconnect?`,
        connectionActionsKeyboard()
      );
    }
    return navigate(ctx,
      `🔗 *Connect Exchange*\n\n` +
      `Choose your account type:\n\n` +
      `🧪 *Testnet* — practice trading, no real funds\n` +
      `   API keys from: testnet.binancefutures.com\n\n` +
      `💰 *Real Account* — live trading with real funds\n` +
      `   API keys from: binance.com → API Management`,
      connectionTypeKeyboard()
    );
  }

  if (data === 'connect_testnet' || data === 'connect_real') {
    const testnet    = data === 'connect_testnet';
    const netName    = testnet ? 'Testnet' : 'Real Account';
    const keyUrl     = testnet
      ? 'https://testnet.binancefutures.com'
      : 'https://www.binance.com/en/my/settings/api-management';
    const restUrl    = testnet
      ? 'https://testnet.binancefutures.com'
      : 'https://fapi.binance.com';

    updateSession(tgId, { tempTestnet: testnet, inputState: 'await_api_key' });

    await navigate(ctx,
      `🔑 *Connect — ${netName}*\n\n` +
      `*Step 1 of 2 — API Key*\n\n` +
      `REST endpoint: \`${restUrl}\`\n\n` +
      `Get your API key from:\n${keyUrl}\n\n` +
      `*Required permissions:*\n` +
      `✅ Enable Futures\n` +
      `✅ Read Info\n` +
      `❌ Withdrawals — NOT required\n\n` +
      `📤 *Send your API Key now:*\n\n` +
      `⚠️ Your message is deleted immediately`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'home')]]).reply_markup
    );
    return;
  }

  if (data === 'disconnect_confirm') {
    return navigate(ctx,
      `⚠️ *Disconnect Exchange?*\n\n` +
      `This will:\n` +
      `• Remove your API keys from the bot\n` +
      `• Disable auto-trading\n` +
      `• Keep your trade history intact\n\n` +
      `Are you sure?`,
      disconnectConfirmKeyboard()
    );
  }

  if (data === 'disconnect_yes') {
    db.clearUserApiKeys(tgId);
    resetInput(tgId);
    logger.info(`[User] ${tgId} disconnected API keys`);
    return navigate(ctx,
      `✅ *Disconnected Successfully*\n\nAll API keys have been removed securely.`,
      mainMenuKeyboard(isAdmin(tgId))
    );
  }

  // ── Auto Trading ───────────────────────────────────────────────────────────
  if (data === 'autotrade_menu' || data === 'autotrade_toggle') {
    if (!user?.api_key_enc) {
      return navigate(ctx, `❌ *Connect an exchange first*\n\nYou need API keys to use Auto Trading.`, connectionTypeKeyboard());
    }
    if (data === 'autotrade_toggle') {
      const newVal = user.auto_trade ? 0 : 1;
      db.updateUserSettings(tgId, { auto_trade: newVal });
      const freshUser = db.getUser(tgId)!;
      return navigate(ctx,
        `🤖 *Auto Trading ${newVal ? 'Enabled ✅' : 'Disabled 🔴'}*\n\n` +
        (newVal
          ? `Bot will automatically execute high-confidence signals.\n\n` +
            `*Current Settings:*\n` +
            `⚡ Leverage: ${freshUser.leverage}x\n` +
            `📊 Risk/Trade: ${freshUser.risk_per_trade}%\n` +
            `🎯 Confidence: ${freshUser.confidence_threshold}%\n` +
            `🔢 Max Trades: ${freshUser.max_open_trades}\n` +
            `📉 Daily Loss Limit: ${freshUser.daily_loss_limit}%`
          : `Bot will NOT execute trades automatically.\nYou will still receive signal notifications.`),
        autoTradeKeyboard(newVal === 1)
      );
    }
    return navigate(ctx,
      `🤖 *Auto Trading*\n\n` +
      `Status: ${user.auto_trade ? '🟢 Enabled' : '🔴 Disabled'}\n\n` +
      `When enabled, the bot automatically executes trades when a signal reaches your confidence threshold.`,
      autoTradeKeyboard(user.auto_trade === 1)
    );
  }

  // ── Open Trades ────────────────────────────────────────────────────────────
  if (data === 'open_trades' || data === 'trades_refresh') {
    if (!user?.api_key_enc) return navigate(ctx, `❌ Connect an exchange first.`, connectionTypeKeyboard());
    const client = buildClientForUser(user);
    if (!client) return navigate(ctx, '❌ Invalid API keys. Please reconnect.', mainMenuKeyboard(isAdmin(tgId)));
    const { text, firstTradeId } = await buildTradesText(user, client);
    return navigate(ctx, text, openTradesKeyboard(firstTradeId));
  }

  // ── Close All ──────────────────────────────────────────────────────────────
  if (data === 'close_all_confirm') {
    return navigate(ctx,
      `⚠️ *Close ALL Positions?*\n\nThis closes every open position immediately at market price. This cannot be undone.`,
      closeAllConfirmKeyboard()
    );
  }

  if (data === 'close_all_yes') {
    if (!user?.api_key_enc) return navigate(ctx, '❌ No exchange connected.', mainMenuKeyboard(isAdmin(tgId)));
    const client = buildClientForUser(user);
    if (!client) return navigate(ctx, '❌ Invalid API keys.', mainMenuKeyboard(isAdmin(tgId)));
    try {
      const positions = await client.getPositions();
      let closed = 0;
      for (const pos of positions) {
        try {
          await client.closePosition(pos.symbol, pos.positionAmt);
          closed++;
          const botTrade = db.getOpenTrades(tgId).find(t => t.symbol === pos.symbol);
          if (botTrade) {
            const margin = pos.initialMargin || 1;
            db.closeTrade(botTrade.id, pos.unRealizedProfit, (pos.unRealizedProfit / margin) * 100, 'Manual close all', pos.markPrice);
          }
        } catch {}
      }
      return navigate(ctx, `✅ *Closed ${closed} position(s) successfully*`, mainMenuKeyboard(isAdmin(tgId)));
    } catch (err: any) {
      return navigate(ctx, `❌ Error: ${err.message}`, mainMenuKeyboard(isAdmin(tgId)));
    }
  }

  // ── Trade Management ───────────────────────────────────────────────────────
  const manageMatch = data.match(/^manage_(\d+)$/);
  if (manageMatch) {
    const tradeId = parseInt(manageMatch[1], 10);
    const trade   = db.getTrade(tradeId);
    if (!trade) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    if (!user?.api_key_enc) return navigate(ctx, '❌ No exchange connected.', mainMenuKeyboard(isAdmin(tgId)));
    const client = buildClientForUser(user);
    if (!client) return navigate(ctx, '❌ Invalid API keys.', mainMenuKeyboard(isAdmin(tgId)));

    let posText = '';
    try {
      const positions = await client.getPositions();
      const pos = positions.find(p => p.symbol === trade.symbol);
      if (pos) {
        const roi = pos.initialMargin > 0 ? (pos.unRealizedProfit / pos.initialMargin) * 100 : 0;
        posText =
          `\n📍 *Live Position*\n` +
          `Mark: \`${pos.markPrice.toFixed(4)}\` | Qty: \`${Math.abs(pos.positionAmt)}\`\n` +
          `Size: \`$${pos.notional.toFixed(2)}\` | Lev: \`${pos.leverage}x\`\n` +
          `Liq: \`${pos.liquidationPrice.toFixed(4)}\`\n` +
          `PnL: ${pnlEmoji(pos.unRealizedProfit)} \`${pnlSign(pos.unRealizedProfit)}$${Math.abs(pos.unRealizedProfit).toFixed(2)}\` (${fmtPct(roi)})\n`;
      }
    } catch {}

    const text =
      `⚙️ *Trade Management #${tradeId}*\n\n` +
      `📌 Pair: \`${trade.symbol}\`\n` +
      `Direction: ${trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}\n` +
      `Entry: \`${trade.entry_price}\`\n` +
      `SL: \`${trade.stop_loss ?? 'N/A'}\` | TP: \`${trade.take_profit ?? 'N/A'}\`\n` +
      `Confidence: \`${trade.confidence ?? 0}%\`\n` +
      `Opened: ${trade.opened_at.slice(0, 16)}` +
      posText;

    return navigate(ctx, text, tradeManagementKeyboard(tradeId));
  }

  // Break Even
  const beMatch = data.match(/^be_(\d+)$/);
  if (beMatch) {
    const trade = db.getTrade(parseInt(beMatch[1], 10));
    if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    if (trade.entry_price) {
      db.updateTradeSL(trade.id, trade.entry_price);
      return navigate(ctx, `✅ *Break Even Activated*\n\nSL moved to entry: \`${trade.entry_price}\``, tradeManagementKeyboard(trade.id));
    }
    return navigate(ctx, `❌ Entry price not available.`, tradeManagementKeyboard(trade.id));
  }

  // Partial close
  for (const [pat, pct] of [['close25', 0.25], ['close50', 0.5], ['close75', 0.75]] as [string, number][]) {
    const m = data.match(new RegExp(`^${pat}_(\\d+)$`));
    if (m) {
      const trade = db.getTrade(parseInt(m[1], 10));
      if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
      const r = await closePositionForTrade(trade, user, pct);
      return navigate(ctx, r.success ? `✅ ${r.msg}` : `❌ ${r.msg}`, tradeManagementKeyboard(trade.id));
    }
  }

  // Full close
  const closeMatch = data.match(/^close_pos_(\d+)$/);
  if (closeMatch) {
    const trade = db.getTrade(parseInt(closeMatch[1], 10));
    if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    const r = await closePositionForTrade(trade, user, 1.0);
    return navigate(ctx, r.success ? `✅ ${r.msg}` : `❌ ${r.msg}`, mainMenuKeyboard(isAdmin(tgId)));
  }

  // Reverse
  const reverseMatch = data.match(/^reverse_(\d+)$/);
  if (reverseMatch) {
    const trade = db.getTrade(parseInt(reverseMatch[1], 10));
    if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    const r = await reversePositionForTrade(trade, user);
    return navigate(ctx, r.success ? `✅ ${r.msg}` : `❌ ${r.msg}`, mainMenuKeyboard(isAdmin(tgId)));
  }

  // Move SL
  const moveSLMatch = data.match(/^move_sl_(\d+)$/);
  if (moveSLMatch) {
    const tradeId = parseInt(moveSLMatch[1], 10);
    updateSession(tgId, { inputState: 'await_sl', editingTradeId: tradeId });
    return navigate(ctx, `🛡 *Move Stop Loss — Trade #${tradeId}*\n\nSend the new SL price:`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `manage_${tradeId}`)]]).reply_markup
    );
  }

  // Move TP
  const moveTPMatch = data.match(/^move_tp_(\d+)$/);
  if (moveTPMatch) {
    const tradeId = parseInt(moveTPMatch[1], 10);
    updateSession(tgId, { inputState: 'await_tp', editingTradeId: tradeId });
    return navigate(ctx, `🎯 *Move Take Profit — Trade #${tradeId}*\n\nSend the new TP price:`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `manage_${tradeId}`)]]).reply_markup
    );
  }

  // Cancel SL order
  const cancelSLMatch = data.match(/^cancel_sl_(\d+)$/);
  if (cancelSLMatch) {
    const trade  = db.getTrade(parseInt(cancelSLMatch[1], 10));
    if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    const client = buildClientForUser(user);
    try {
      const orders = await client?.getOpenOrders(trade.symbol);
      for (const o of (orders || [])) {
        if (o.type === 'STOP_MARKET') await client?.cancelOrder(trade.symbol, o.orderId);
      }
      db.updateTradeSL(trade.id, 0);
    } catch {}
    return navigate(ctx, `✅ Stop Loss order cancelled for *${trade.symbol}*`, tradeManagementKeyboard(trade.id));
  }

  // Cancel TP order
  const cancelTPMatch = data.match(/^cancel_tp_(\d+)$/);
  if (cancelTPMatch) {
    const trade  = db.getTrade(parseInt(cancelTPMatch[1], 10));
    if (!trade || !user) return navigate(ctx, '❌ Trade not found.', mainMenuKeyboard(isAdmin(tgId)));
    const client = buildClientForUser(user);
    try {
      const orders = await client?.getOpenOrders(trade.symbol);
      for (const o of (orders || [])) {
        if (o.type === 'TAKE_PROFIT_MARKET') await client?.cancelOrder(trade.symbol, o.orderId);
      }
      db.updateTradeTP(trade.id, 0);
    } catch {}
    return navigate(ctx, `✅ Take Profit order cancelled for *${trade.symbol}*`, tradeManagementKeyboard(trade.id));
  }

  // ── Signals ────────────────────────────────────────────────────────────────
  if (data === 'signals' || data === 'signals_refresh') {
    const signals = db.getRecentSignals(5);
    if (!signals.length) {
      return navigate(ctx,
        `🤖 *AI Signals*\n\nNo recent signals yet.\nThe scanner runs every 60 seconds.\n\n_Signal engine: 4H + 1H + 15M confluence, 20+ indicators, London/NY session only._`,
        signalsKeyboard()
      );
    }
    let text = `📡 *RECENT AI SIGNALS*\n_Last ${signals.length} signals_\n\n`;
    for (const s of signals) {
      const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
      text +=
        `▸ *${s.symbol}* ${dir}\n` +
        `  Confidence: \`${s.confidence}%\` | RR: \`${s.risk_reward}R\`\n` +
        `  Entry: \`${s.entry_price}\` | SL: \`${s.stop_loss}\` | TP: \`${s.take_profit}\`\n` +
        `  🕐 ${s.created_at.slice(0, 16)}\n\n`;
    }
    return navigate(ctx, text, signalsKeyboard());
  }

  // ── Market Scan ────────────────────────────────────────────────────────────
  if (data === 'scan') {
    await navigate(ctx,
      `🔍 *Market Scan*\n\nScanning ${scanner.getPairCount()} pairs...\n\nThis takes 15–30 seconds.`,
      scanKeyboard()
    );
    scanner['scan']?.().catch(() => {});
    setTimeout(async () => {
      const signals = db.getRecentSignals(5);
      let text = `🔍 *Scan Complete*\n\n`;
      if (signals.length) {
        text += `Found ${signals.length} recent signal(s):\n\n`;
        for (const s of signals) {
          text += `▸ *${s.symbol}* ${s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} — \`${s.confidence}%\`\n`;
        }
      } else {
        text += `No high-confidence signals found.\nMarkets may be in consolidation or outside session hours.`;
      }
      const msgId = getSession(tgId).currentMessageId;
      if (msgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, text, {
          parse_mode: 'Markdown', reply_markup: scanKeyboard(),
        }).catch(() => {});
      }
    }, 20_000);
    return;
  }

  // ── Analyse Pair ───────────────────────────────────────────────────────────
  if (data === 'analyse') {
    updateSession(tgId, { inputState: 'await_symbol_analyse' });
    return navigate(ctx,
      `🔎 *Analyse Pair*\n\nSend the trading pair symbol:\n\nExamples: \`BTCUSDT\`  \`ETHUSDT\`  \`SOLUSDT\``,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'home')]]).reply_markup
    );
  }

  // ── Trade History ──────────────────────────────────────────────────────────
  if (data === 'history') {
    const trades = db.getClosedTrades(tgId, 10);
    const stats  = db.getPnLStats(tgId);
    let text =
      `📋 *TRADE HISTORY*\n\n` +
      `📊 Total Trades: ${stats.tradeCount}\n` +
      `✅ Wins: ${stats.wins}  ❌ Losses: ${stats.losses}\n` +
      `🏆 Win Rate: ${stats.winRate.toFixed(1)}%\n` +
      `💰 Total PnL: ${pnlEmoji(stats.totalPnl)} \`${pnlSign(stats.totalPnl)}$${Math.abs(stats.totalPnl).toFixed(2)}\`\n` +
      `📈 Best: \`+$${stats.bestTrade.toFixed(2)}\`  📉 Worst: \`-$${Math.abs(stats.worstTrade).toFixed(2)}\`\n\n`;

    if (trades.length) {
      text += `*Last ${trades.length} Trades:*\n`;
      for (const t of trades) {
        const pnl = t.pnl ?? 0;
        text +=
          `${pnlEmoji(pnl)} ${t.symbol} ${t.direction} — \`${pnlSign(pnl)}$${Math.abs(pnl).toFixed(2)}\` (${t.close_reason ?? 'closed'})\n` +
          `   _${t.closed_at?.slice(0, 16)}_\n`;
      }
    } else {
      text += `_No closed trades yet._`;
    }
    return navigate(ctx, text, historyKeyboard());
  }

  // ── Account / Profile ──────────────────────────────────────────────────────
  if (data === 'account') {
    const hasKeys = !!(user?.api_key_enc);
    const text =
      `👤 *MY PROFILE*\n\n` +
      `Name: ${ctx.from!.first_name || 'N/A'}${ctx.from!.last_name ? ' ' + ctx.from!.last_name : ''}\n` +
      `ID: \`${tgId}\`\n` +
      `Role: ${isAdmin(tgId) ? '👑 Admin' : '👤 User'}\n\n` +
      (hasKeys
        ? `🔗 *Exchange:* ✅ Connected\n` +
          `Network: ${user!.testnet ? '🧪 Testnet' : '💰 Real Account'}\n` +
          `Auto Trade: ${user!.auto_trade ? '🟢 ON' : '🔴 OFF'}\n`
        : `🔗 *Exchange:* ❌ Not Connected\n`
      );
    return navigate(ctx, text, profileMenuKeyboard(hasKeys));
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  if (data === 'settings') {
    const text =
      `⚙️ *SETTINGS*\n\n` +
      `⚡ Leverage: \`${user?.leverage ?? 10}x\`\n` +
      `📊 Risk/Trade: \`${user?.risk_per_trade ?? 1}%\`\n` +
      `🎯 Confidence: \`${user?.confidence_threshold ?? 90}%\`\n` +
      `🔢 Max Trades: \`${user?.max_open_trades ?? 3}\`\n` +
      `📉 Daily Loss Limit: \`${user?.daily_loss_limit ?? 3}%\`\n` +
      `🛡 Break Even: ${user?.break_even_enabled ? '✅ ON' : '❌ OFF'}\n` +
      `📉 Trailing Stop: ${user?.trailing_stop_enabled ? '✅ ON' : '❌ OFF'}`;
    return navigate(ctx, text, settingsKeyboard());
  }

  if (data === 'set_leverage') {
    updateSession(tgId, { inputState: 'await_leverage' });
    return navigate(ctx, `⚡ *Set Leverage*\n\nCurrent: \`${user?.leverage ?? 10}x\`\n\nSend new leverage (1–125):`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'settings')]]).reply_markup
    );
  }

  if (data === 'set_risk') {
    updateSession(tgId, { inputState: 'await_risk' });
    return navigate(ctx, `📊 *Set Risk Per Trade*\n\nCurrent: \`${user?.risk_per_trade ?? 1}%\`\n\nSend risk % (e.g. 1.5):`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'settings')]]).reply_markup
    );
  }

  if (data === 'set_confidence') {
    updateSession(tgId, { inputState: 'await_confidence' });
    return navigate(ctx, `🎯 *Set Confidence Threshold*\n\nCurrent: \`${user?.confidence_threshold ?? 90}%\`\n\nSend threshold (50–99):`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'settings')]]).reply_markup
    );
  }

  if (data === 'set_max_trades') {
    return navigate(ctx, `🔢 *Max Open Trades*\n\nCurrent: \`${user?.max_open_trades ?? 3}\`\n\nContact admin to change this limit.`, settingsKeyboard());
  }

  if (data === 'toggle_be') {
    const newVal = user?.break_even_enabled ? 0 : 1;
    db.updateUserSettings(tgId, { break_even_enabled: newVal });
    return navigate(ctx, `✅ Break Even ${newVal ? 'Enabled' : 'Disabled'}`, settingsKeyboard());
  }

  if (data === 'toggle_ts') {
    const newVal = user?.trailing_stop_enabled ? 0 : 1;
    db.updateUserSettings(tgId, { trailing_stop_enabled: newVal });
    return navigate(ctx, `✅ Trailing Stop ${newVal ? 'Enabled' : 'Disabled'}`, settingsKeyboard());
  }

  // ── Help ───────────────────────────────────────────────────────────────────
  if (data === 'help') {
    return navigate(ctx,
      `ℹ️ *HOW TO USE THIS BOT*\n\n` +
      `1️⃣ Go to *👤 Profile* → *Connect Exchange*\n` +
      `   Enter your Binance API keys\n\n` +
      `2️⃣ Go to *📈 Trading* → *Auto Trading*\n` +
      `   Enable to let the bot trade automatically\n\n` +
      `3️⃣ Go to *🤖 Signals* to see recent AI signals\n\n` +
      `4️⃣ Go to *📈 Trading* → *Live Dashboard*\n` +
      `   View live balance and open positions\n\n` +
      `*⚙️ Risk Settings:*\n` +
      `• Set risk % per trade in Settings\n` +
      `• Set daily loss limit to protect capital\n` +
      `• Break Even moves SL to entry automatically\n\n` +
      `*📡 Signal Engine:*\n` +
      `• 4H + 1H + 15M multi-timeframe confluence\n` +
      `• 20+ technical indicators\n` +
      `• London + New York sessions only\n` +
      `• Minimum 90% confidence required\n` +
      `• No duplicate signals within 4 hours`,
      mainMenuKeyboard(isAdmin(tgId))
    );
  }
}
