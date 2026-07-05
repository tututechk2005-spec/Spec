import { Telegraf } from 'telegraf';
import { logger } from './utils';
import { db, User, Trade } from './database';
import { buildClientForUser, BinanceClient } from './binance';
import { TradingSignal } from './strategy';

// ── Error classifier ──────────────────────────────────────────────────────────
function classifyBinanceError(err: any): string {
  const msg    = err?.response?.data?.msg ?? err?.message ?? '';
  const code   = err?.response?.data?.code as number | undefined;
  const status = err?.response?.status as number | undefined;

  if (status === 403)           return '🚫 IP banned or API key disabled by Binance';
  if (code === -1021)           return '⏱ Timestamp out of sync — server clock issue';
  if (code === -1022)           return '🔐 Invalid signature — wrong API Secret';
  if (code === -2014)           return '🔑 Invalid API Key format';
  if (code === -2015)           return '❌ API key rejected or Futures permission disabled';
  if (code === -2018)           return '💰 Insufficient balance — add USDT to your account';
  if (code === -2019)           return '💰 Insufficient margin';
  if (code === -1013)           return '📊 Order quantity too small (below minimum)';
  if (code === -4003)           return '📊 Quantity precision error — adjust step size';
  if (code === -1121)           return '❓ Invalid symbol — pair not available on Binance Futures';
  if (code === -4061)           return '❌ Order would immediately trigger (bad SL/TP)';
  if (/insufficient/i.test(msg)) return '💰 Insufficient balance or margin';
  if (/minimum/i.test(msg))     return '📊 Order size below minimum notional ($10)';
  if (/ETIMEDOUT|timeout/i.test(msg)) return '⏱ Request timed out — Binance unreachable';
  if (/ECONNRESET|ECONNREFUSED/i.test(msg)) return '🌐 Network connection error';
  return `⚠️ ${msg || 'Unknown exchange error'}`;
}

// ── Retry helper for transient Binance errors ─────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err: any) {
      lastErr = err;
      const code = err?.response?.data?.code as number | undefined;
      const status = err?.response?.status as number | undefined;
      // Don't retry auth errors or invalid-input errors
      const fatal = code && [-2014, -2015, -1022, -1121, -1013, -4003].includes(code);
      if (fatal || (status && status < 500 && status !== 429)) throw err;
      if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Duplicate trade guard ─────────────────────────────────────────────────────
function hasDuplicateTrade(telegramId: string, symbol: string, direction: string): boolean {
  const open = db.getOpenTrades(telegramId);
  return open.some(t => t.symbol === symbol && t.direction === direction);
}

// ── Calculate quantity based on risk parameters ───────────────────────────────
async function calcQuantity(
  client: BinanceClient,
  user: User,
  signal: TradingSignal
): Promise<{ qty: number; error?: string }> {
  try {
    const acct = await withRetry(() => client.getAccountInfo());
    const balance     = acct.totalAvailableBalance;
    const MIN_BALANCE = 10; // USDT

    if (balance < MIN_BALANCE) {
      return { qty: 0, error: `Available balance too low ($${balance.toFixed(2)})` };
    }

    const riskAmount = balance * (user.risk_per_trade / 100);
    const riskPips   = Math.abs(signal.entryPrice - signal.stopLoss);

    if (!riskPips || riskPips < 0.000001) {
      return { qty: 0, error: 'Invalid SL — entry price equals stop loss' };
    }

    // Raw quantity based on risk
    let qty = (riskAmount / riskPips) * user.leverage;

    // Enforce minimum notional ($10 USDT)
    const minQty    = 10 / (signal.entryPrice * user.leverage);
    qty = Math.max(qty, minQty);

    // Round to 3 decimal places (safe for most USDT pairs)
    qty = parseFloat(qty.toFixed(3));

    if (qty <= 0) {
      return { qty: 0, error: 'Calculated quantity is zero — increase balance or reduce risk' };
    }

    return { qty };
  } catch (err: any) {
    return { qty: 0, error: `Balance check failed: ${err?.message || 'Connection error'}` };
  }
}

// ── Validate symbol exists on Binance Futures ─────────────────────────────────
async function validateSymbol(client: BinanceClient, symbol: string): Promise<boolean> {
  try {
    const info = await client.getExchangeInfo();
    return info.symbols.some(s => s.symbol === symbol && s.status === 'TRADING');
  } catch {
    return true; // If we can't fetch, assume valid and let Binance reject it
  }
}

// ── Main trade executor ───────────────────────────────────────────────────────
export async function executeSignal(signal: TradingSignal, user: User, bot: Telegraf): Promise<void> {
  const client = buildClientForUser(user);
  if (!client) return;

  const tgId = user.telegram_id;

  // ── Guard: duplicate trade ─────────────────────────────────────────────────
  if (hasDuplicateTrade(tgId, signal.symbol, signal.direction)) {
    logger.info(`[Trade] Skipping duplicate ${signal.symbol} ${signal.direction} for user ${tgId}`);
    await notify(bot, tgId,
      `⚠️ *Signal Detected — Trade Skipped*\n\n` +
      `📍 Pair: \`${signal.symbol}\`\n` +
      `📌 Direction: ${signal.direction}\n` +
      `⚡ Confidence: \`${signal.confidence}%\`\n\n` +
      `Reason: You already have an open *${signal.direction}* position on *${signal.symbol}*.`
    );
    return;
  }

  // ── Guard: daily loss limit ────────────────────────────────────────────────
  const todayLoss = db.getTodayLoss(user.id);
  if (todayLoss >= user.daily_loss_limit) {
    await notify(bot, tgId,
      `⚠️ *Signal Detected — Trade NOT Executed*\n\n` +
      `📍 Pair: \`${signal.symbol}\`\n\n` +
      `🚫 Reason: Daily loss limit reached\n` +
      `📊 Today's loss: \`${todayLoss.toFixed(2)}%\` / limit: \`${user.daily_loss_limit}%\`\n\n` +
      `Auto-trading paused until tomorrow.`
    );
    return;
  }

  // ── Guard: max open trades ─────────────────────────────────────────────────
  const openTrades = db.getOpenTrades(tgId);
  if (openTrades.length >= user.max_open_trades) {
    await notify(bot, tgId,
      `⚠️ *Signal Detected — Trade NOT Executed*\n\n` +
      `📍 Pair: \`${signal.symbol}\`\n\n` +
      `🚫 Reason: Maximum open trades reached\n` +
      `📊 Open: \`${openTrades.length}\` / Max: \`${user.max_open_trades}\``
    );
    return;
  }

  // ── Guard: symbol validation ───────────────────────────────────────────────
  const symbolValid = await validateSymbol(client, signal.symbol);
  if (!symbolValid) {
    logger.warn(`[Trade] Invalid symbol ${signal.symbol}`);
    await notify(bot, tgId,
      `❌ *Trade Execution Failed*\n\n` +
      `Pair: \`${signal.symbol}\`\n` +
      `Reason: Symbol not found or not trading on Binance Futures`
    );
    return;
  }

  // ── Guard: quantity / balance ──────────────────────────────────────────────
  const { qty, error: qtyErr } = await calcQuantity(client, user, signal);
  if (!qty || qty <= 0) {
    await notify(bot, tgId,
      `⚠️ *Signal Detected — Trade NOT Executed*\n\n` +
      `📍 Pair: \`${signal.symbol}\`\n` +
      `🚫 Reason: ${qtyErr || 'Insufficient balance or minimum size not met'}`
    );
    return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  try {
    // Set leverage first (with retry)
    await withRetry(() => client.setLeverage(signal.symbol, user.leverage));

    const side: 'BUY' | 'SELL' = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const order = await withRetry(() => client.placeMarketOrder(signal.symbol, side, qty));

    const execPrice  = parseFloat(order.avgPrice) || signal.entryPrice;
    const marginUsed = (execPrice * qty) / user.leverage;

    logger.info(`[Trade] ✅ Executed ${signal.symbol} ${signal.direction} qty=${qty} @ ${execPrice} for user ${tgId}`);
    db.dbLog('info', 'TRADE_EXEC', `${signal.symbol} ${signal.direction} qty=${qty} @ ${execPrice}`, { userId: tgId });

    const tradeId = db.insertTrade({
      user_id:         user.id,
      telegram_id:     tgId,
      order_id:        String(order.orderId),
      client_order_id: order.clientOrderId,
      symbol:          signal.symbol,
      direction:       signal.direction,
      entry_price:     execPrice,
      current_price:   execPrice,
      mark_price:      execPrice,
      quantity:        qty,
      leverage:        user.leverage,
      stop_loss:       signal.stopLoss,
      take_profit:     signal.takeProfit,
      liquidation_price: null,
      margin_used:     marginUsed,
      position_side:   'BOTH',
      status:          'OPEN',
      pnl:             0,
      pnl_pct:         0,
      unrealized_pnl:  0,
      risk_reward:     signal.riskReward,
      confidence:      signal.confidence,
      signal_id:       signal.uuid,
      close_reason:    null,
    });

    // Place SL and TP orders (best-effort, don't fail the trade if these error)
    const slSide: 'BUY' | 'SELL' = signal.direction === 'LONG' ? 'SELL' : 'BUY';
    let slStatus = '✅ Placed';
    let tpStatus = '✅ Placed';
    try {
      await withRetry(() => client.placeStopLoss(signal.symbol, slSide, qty, signal.stopLoss));
    } catch (e: any) {
      slStatus = `⚠️ Failed (${e?.response?.data?.msg || e?.message || 'error'})`;
      logger.warn(`[Trade] SL order failed for ${signal.symbol}: ${slStatus}`);
    }
    try {
      await withRetry(() => client.placeTakeProfit(signal.symbol, slSide, qty, signal.takeProfit));
    } catch (e: any) {
      tpStatus = `⚠️ Failed (${e?.response?.data?.msg || e?.message || 'error'})`;
      logger.warn(`[Trade] TP order failed for ${signal.symbol}: ${tpStatus}`);
    }

    await notify(bot, tgId,
      `✅ *Trade Executed Successfully*\n\n` +
      `🔢 Order ID: \`${order.orderId}\`\n` +
      `📍 Pair: \`${signal.symbol}\`\n` +
      `📌 Direction: ${signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}\n` +
      `💵 Entry Price: \`${execPrice}\`\n` +
      `📦 Quantity: \`${qty}\`\n` +
      `⚡ Leverage: \`${user.leverage}x\`\n` +
      `💰 Margin Used: \`$${marginUsed.toFixed(2)}\`\n` +
      `🛡 Stop Loss: \`${signal.stopLoss}\` — ${slStatus}\n` +
      `🎯 Take Profit: \`${signal.takeProfit}\` — ${tpStatus}\n` +
      `📊 Confidence: \`${signal.confidence}%\`\n` +
      `📈 Risk/Reward: \`${signal.riskReward}R\`\n` +
      `🤖 Bot Trade ID: \`#${tradeId}\``
    );

    startTradeMonitor(tradeId, bot);
  } catch (err: any) {
    const reason = classifyBinanceError(err);
    logger.error(`[Trade] Execution failed for user ${tgId}: ${reason}`);
    db.dbLog('error', 'TRADE_EXEC', `Failed: ${reason}`, { userId: tgId, symbol: signal.symbol });
    await notify(bot, tgId,
      `❌ *Trade Execution Failed*\n\n` +
      `📍 Pair: \`${signal.symbol}\`\n` +
      `📌 Direction: ${signal.direction}\n\n` +
      `🚫 Reason:\n${reason}\n\n` +
      `_The signal was detected but the order was not placed._`
    );
  }
}

// ── Trade monitor (checks every 15 seconds) ───────────────────────────────────
const monitors = new Map<number, NodeJS.Timeout>();

export function startTradeMonitor(tradeId: number, bot: Telegraf): void {
  if (monitors.has(tradeId)) return;

  const timer = setInterval(async () => {
    const trade = db.getTrade(tradeId);
    if (!trade || trade.status !== 'OPEN') {
      clearInterval(timer);
      monitors.delete(tradeId);
      return;
    }

    const user = db.getAllUsers().find(u => u.telegram_id === trade.telegram_id);
    if (!user) return;
    const client = buildClientForUser(user);
    if (!client) return;

    try {
      const positions = await client.getPositions();
      const pos       = positions.find(p => p.symbol === trade.symbol);

      // Position closed on Binance (manually or by SL/TP exchange order)
      if (!pos || Math.abs(pos.positionAmt) < 0.0001) {
        const pnl    = trade.pnl ?? 0;
        const pnlPct = trade.pnl_pct ?? 0;
        const price  = trade.current_price ?? trade.entry_price ?? 0;
        db.closeTrade(tradeId, pnl, pnlPct, 'Closed externally', price);
        clearInterval(timer);
        monitors.delete(tradeId);
        await sendCloseNotification(bot, trade, pnl, pnlPct, price, 'Closed externally');
        return;
      }

      // Update live PnL
      const markPrice = pos.markPrice;
      const pnl       = pos.unRealizedProfit;
      const margin    = pos.initialMargin || (trade.margin_used ?? 1);
      const pnlPct    = margin > 0 ? (pnl / margin) * 100 : 0;
      db.updateTradePrice(tradeId, markPrice, markPrice, pnl, pnlPct, pnl);

      // Break-even logic
      if (user.break_even_enabled && trade.entry_price && trade.stop_loss !== trade.entry_price) {
        const pnlRatio = margin > 0 ? pnl / margin : 0;
        if (pnlRatio > 0.5) {
          db.updateTradeSL(tradeId, trade.entry_price);
          await notify(bot, trade.telegram_id,
            `✅ *Break Even Activated*\n\n` +
            `📍 Pair: \`${trade.symbol}\`\n` +
            `🛡 SL moved to entry: \`${trade.entry_price}\`\n` +
            `💰 Unrealized PnL: \`$${pnl.toFixed(2)}\``
          );
        }
      }

      // SL hit check (bot-level, in addition to Binance orders)
      if (trade.stop_loss && (
        (trade.direction === 'LONG'  && markPrice <= trade.stop_loss) ||
        (trade.direction === 'SHORT' && markPrice >= trade.stop_loss)
      )) {
        db.closeTrade(tradeId, pnl, pnlPct, 'Stop Loss hit', markPrice);
        if (pnl < 0) db.recordDailyLoss(user.id, Math.abs(pnlPct));
        clearInterval(timer);
        monitors.delete(tradeId);
        await sendCloseNotification(bot, trade, pnl, pnlPct, markPrice, 'Stop Loss hit');
        return;
      }

      // TP hit check
      if (trade.take_profit && (
        (trade.direction === 'LONG'  && markPrice >= trade.take_profit) ||
        (trade.direction === 'SHORT' && markPrice <= trade.take_profit)
      )) {
        db.closeTrade(tradeId, pnl, pnlPct, 'Take Profit hit', markPrice);
        clearInterval(timer);
        monitors.delete(tradeId);
        await sendCloseNotification(bot, trade, pnl, pnlPct, markPrice, 'Take Profit hit');
        return;
      }
    } catch (err: any) {
      logger.warn(`[Monitor] Trade ${tradeId} check failed: ${err?.message}`);
    }
  }, 15_000);

  monitors.set(tradeId, timer);
  logger.info(`[Monitor] Started for trade #${tradeId}`);
}

export function restoreTradeMonitors(bot: Telegraf): void {
  const trades = db.getOpenTrades();
  for (const trade of trades) {
    startTradeMonitor(trade.id, bot);
  }
  logger.info(`[Monitor] Restored ${trades.length} trade monitors`);
}

// ── Close notification ────────────────────────────────────────────────────────
async function sendCloseNotification(
  bot: Telegraf, trade: Trade,
  pnl: number, pnlPct: number,
  closePrice: number, reason: string
): Promise<void> {
  const emoji    = pnl >= 0 ? '✅' : '❌';
  const pnlSign  = pnl >= 0 ? '+' : '';
  const duration = msToHuman(Date.now() - new Date(trade.opened_at).getTime());

  await notify(bot, trade.telegram_id,
    `${emoji} *Trade Closed — ${reason}*\n\n` +
    `📍 Pair: \`${trade.symbol}\`\n` +
    `📌 Direction: ${trade.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}\n` +
    `📥 Entry: \`${trade.entry_price}\`\n` +
    `📤 Exit: \`${closePrice}\`\n` +
    `💰 PnL: \`${pnlSign}$${Math.abs(pnl).toFixed(2)}\`\n` +
    `📊 ROI: \`${pnlSign}${pnlPct.toFixed(2)}%\`\n` +
    `⏱ Duration: ${duration}\n` +
    `🔚 Reason: ${reason}`
  );

  logger.info(`[Monitor] Trade #${trade.id} closed — ${reason} — PnL: ${pnlSign}$${Math.abs(pnl).toFixed(2)}`);
  db.dbLog(pnl >= 0 ? 'info' : 'warn', 'TRADE_CLOSE',
    `${trade.symbol} ${trade.direction} — ${reason} — PnL: ${pnlSign}$${Math.abs(pnl).toFixed(2)}`
  );
}

// ── Close from inline button ──────────────────────────────────────────────────
export async function closePositionForTrade(
  trade: Trade, user: User, pct = 1.0
): Promise<{ success: boolean; msg: string }> {
  const client = buildClientForUser(user);
  if (!client) return { success: false, msg: 'No API keys configured' };
  try {
    const positions = await client.getPositions();
    const pos       = positions.find(p => p.symbol === trade.symbol);
    if (!pos || Math.abs(pos.positionAmt) < 0.0001) {
      return { success: false, msg: 'Position already closed or not found on Binance' };
    }
    if (pct >= 1) {
      await withRetry(() => client.closePosition(pos.symbol, pos.positionAmt));
      const pnl    = pos.unRealizedProfit;
      const margin = pos.initialMargin || (trade.margin_used ?? 1);
      const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
      db.closeTrade(trade.id, pnl, pnlPct, 'Manually closed', pos.markPrice);
      if (pnl < 0) db.recordDailyLoss(user.id, Math.abs(pnlPct));
      return { success: true, msg: `Closed @ \`${pos.markPrice}\` | PnL: \`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\`` };
    } else {
      await withRetry(() => client.closePartialPosition(pos.symbol, pos.positionAmt, pct));
      return { success: true, msg: `Closed ${(pct * 100).toFixed(0)}% of position @ \`${pos.markPrice}\`` };
    }
  } catch (err: any) {
    const reason = classifyBinanceError(err);
    return { success: false, msg: reason };
  }
}

// ── Reverse position from inline button ──────────────────────────────────────
export async function reversePositionForTrade(
  trade: Trade, user: User
): Promise<{ success: boolean; msg: string }> {
  const client = buildClientForUser(user);
  if (!client) return { success: false, msg: 'No API keys' };
  try {
    const positions = await client.getPositions();
    const pos       = positions.find(p => p.symbol === trade.symbol);
    if (!pos) return { success: false, msg: 'Position not found on Binance' };
    await withRetry(() => client.reversePosition(pos.symbol, pos.positionAmt));
    return { success: true, msg: `Position reversed on \`${trade.symbol}\`` };
  } catch (err: any) {
    return { success: false, msg: classifyBinanceError(err) };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function notify(bot: Telegraf, chatId: string, text: string): Promise<void> {
  try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch {}
}

function msToHuman(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
