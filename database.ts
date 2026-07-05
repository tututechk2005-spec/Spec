import Database from 'better-sqlite3';
import path from 'path';
import { logger } from './utils';

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  api_key_enc TEXT,
  api_secret_enc TEXT,
  testnet INTEGER NOT NULL DEFAULT 0,
  auto_trade INTEGER NOT NULL DEFAULT 0,
  leverage INTEGER NOT NULL DEFAULT 10,
  risk_per_trade REAL NOT NULL DEFAULT 1.0,
  max_open_trades INTEGER NOT NULL DEFAULT 3,
  daily_loss_limit REAL NOT NULL DEFAULT 3.0,
  confidence_threshold REAL NOT NULL DEFAULT 90.0,
  break_even_enabled INTEGER NOT NULL DEFAULT 1,
  trailing_stop_enabled INTEGER NOT NULL DEFAULT 0,
  trailing_stop_pct REAL NOT NULL DEFAULT 1.0,
  max_drawdown REAL NOT NULL DEFAULT 10.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  telegram_id TEXT NOT NULL,
  order_id TEXT,
  client_order_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL,
  current_price REAL,
  mark_price REAL,
  quantity REAL,
  leverage INTEGER,
  stop_loss REAL,
  take_profit REAL,
  liquidation_price REAL,
  margin_used REAL,
  position_side TEXT DEFAULT 'BOTH',
  status TEXT NOT NULL DEFAULT 'OPEN',
  pnl REAL,
  pnl_pct REAL,
  unrealized_pnl REAL,
  risk_reward REAL,
  confidence REAL,
  signal_id TEXT,
  close_reason TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_uuid TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  risk_reward REAL NOT NULL,
  confidence REAL NOT NULL,
  probability REAL,
  trend_summary TEXT,
  volume_confirmation TEXT,
  market_structure TEXT,
  entry_reason TEXT,
  timeframe TEXT,
  expected_duration TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  trades_opened INTEGER NOT NULL DEFAULT 0,
  trades_closed INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  total_pnl REAL NOT NULL DEFAULT 0,
  daily_loss REAL NOT NULL DEFAULT 0,
  UNIQUE(user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at);
`;

export interface User {
  id: number;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name?: string | null;
  role: 'admin' | 'user';
  is_active: number;
  api_key_enc: string | null;
  api_secret_enc: string | null;
  testnet: number;
  auto_trade: number;
  leverage: number;
  risk_per_trade: number;
  max_open_trades: number;
  daily_loss_limit: number;
  confidence_threshold: number;
  break_even_enabled: number;
  trailing_stop_enabled: number;
  trailing_stop_pct: number;
  max_drawdown: number;
  created_at: string;
  updated_at: string;
}

export interface Trade {
  id: number;
  user_id: number;
  telegram_id: string;
  order_id: string | null;
  client_order_id: string | null;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number | null;
  current_price: number | null;
  mark_price: number | null;
  quantity: number | null;
  leverage: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  liquidation_price: number | null;
  margin_used: number | null;
  position_side: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  pnl: number | null;
  pnl_pct: number | null;
  unrealized_pnl: number | null;
  risk_reward: number | null;
  confidence: number | null;
  signal_id: string | null;
  close_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface Signal {
  id: number;
  signal_uuid: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number;
  confidence: number;
  probability: number | null;
  trend_summary: string | null;
  volume_confirmation: string | null;
  market_structure: string | null;
  entry_reason: string | null;
  timeframe: string | null;
  expected_duration: string | null;
  status: 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'FILLED';
  created_at: string;
  expires_at: string | null;
}

export interface PnLStats {
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  tradeCount: number;
  bestTrade: number;
  worstTrade: number;
  avgPnl: number;
}

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'database.db');
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.exec(SCHEMA_SQL);
    logger.info(`Database initialized at ${DB_PATH}`);
  }
  return _db;
}

export const db = {
  getUser(telegramId: string): User | undefined {
    return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | undefined;
  },

  upsertUser(telegramId: string, data: Partial<User>): void {
    const existing = db.getUser(telegramId);
    if (existing) {
      const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
      getDb().prepare(`UPDATE users SET ${fields}, updated_at = datetime('now') WHERE telegram_id = ?`)
        .run(...Object.values(data), telegramId);
    } else {
      getDb().prepare(`INSERT INTO users (telegram_id, username, first_name, role) VALUES (?, ?, ?, ?)`)
        .run(telegramId, data.username ?? null, data.first_name ?? null, data.role ?? 'user');
    }
  },

  getAllUsers(): User[] {
    return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as User[];
  },

  setUserApiKeys(telegramId: string, apiKeyEnc: string, apiSecretEnc: string, testnet: number): void {
    getDb().prepare(`UPDATE users SET api_key_enc = ?, api_secret_enc = ?, testnet = ?, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(apiKeyEnc, apiSecretEnc, testnet, telegramId);
  },

  clearUserApiKeys(telegramId: string): void {
    getDb().prepare(`UPDATE users SET api_key_enc = NULL, api_secret_enc = NULL, auto_trade = 0, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(telegramId);
  },

  updateUserSettings(telegramId: string, settings: Partial<User>): void {
    const fields = Object.keys(settings).map(k => `${k} = ?`).join(', ');
    getDb().prepare(`UPDATE users SET ${fields}, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(...Object.values(settings), telegramId);
  },

  insertTrade(trade: Omit<Trade, 'id' | 'opened_at' | 'closed_at'>): number {
    const res = getDb().prepare(`
      INSERT INTO trades
        (user_id, telegram_id, order_id, client_order_id, symbol, direction,
         entry_price, current_price, mark_price, quantity, leverage, stop_loss, take_profit,
         liquidation_price, margin_used, position_side, status, pnl, pnl_pct, unrealized_pnl,
         risk_reward, confidence, signal_id, close_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      trade.user_id, trade.telegram_id, trade.order_id, trade.client_order_id,
      trade.symbol, trade.direction, trade.entry_price, trade.current_price, trade.mark_price,
      trade.quantity, trade.leverage, trade.stop_loss, trade.take_profit,
      trade.liquidation_price, trade.margin_used, trade.position_side,
      trade.status, trade.pnl, trade.pnl_pct, trade.unrealized_pnl,
      trade.risk_reward, trade.confidence, trade.signal_id, trade.close_reason
    );
    return res.lastInsertRowid as number;
  },

  getOpenTrades(telegramId?: string): Trade[] {
    if (telegramId) {
      return getDb().prepare("SELECT * FROM trades WHERE telegram_id = ? AND status = 'OPEN' ORDER BY opened_at DESC")
        .all(telegramId) as Trade[];
    }
    return getDb().prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY opened_at DESC").all() as Trade[];
  },

  getAllTrades(limit = 50): Trade[] {
    return getDb().prepare('SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?').all(limit) as Trade[];
  },

  getUserTrades(telegramId: string, limit = 20): Trade[] {
    return getDb().prepare('SELECT * FROM trades WHERE telegram_id = ? ORDER BY opened_at DESC LIMIT ?')
      .all(telegramId, limit) as Trade[];
  },

  getClosedTrades(telegramId: string, limit = 10): Trade[] {
    return getDb().prepare("SELECT * FROM trades WHERE telegram_id = ? AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT ?")
      .all(telegramId, limit) as Trade[];
  },

  closeTrade(tradeId: number, pnl: number, pnlPct: number, reason: string, closePrice: number): void {
    getDb().prepare(`UPDATE trades SET status = 'CLOSED', pnl = ?, pnl_pct = ?, close_reason = ?, current_price = ?, closed_at = datetime('now') WHERE id = ?`)
      .run(pnl, pnlPct, reason, closePrice, tradeId);
  },

  updateTradePrice(tradeId: number, currentPrice: number, markPrice: number, pnl: number, pnlPct: number, unrealizedPnl: number): void {
    getDb().prepare('UPDATE trades SET current_price = ?, mark_price = ?, pnl = ?, pnl_pct = ?, unrealized_pnl = ? WHERE id = ?')
      .run(currentPrice, markPrice, pnl, pnlPct, unrealizedPnl, tradeId);
  },

  updateTradeSL(tradeId: number, newSL: number): void {
    getDb().prepare('UPDATE trades SET stop_loss = ? WHERE id = ?').run(newSL, tradeId);
  },

  updateTradeTP(tradeId: number, newTP: number): void {
    getDb().prepare('UPDATE trades SET take_profit = ? WHERE id = ?').run(newTP, tradeId);
  },

  getTrade(tradeId: number): Trade | undefined {
    return getDb().prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade | undefined;
  },

  getPnLStats(telegramId: string, since?: Date): PnLStats {
    let query = "SELECT * FROM trades WHERE telegram_id = ? AND status = 'CLOSED'";
    const params: (string | number)[] = [telegramId];
    if (since) { query += ' AND closed_at >= ?'; params.push(since.toISOString()); }
    const trades = getDb().prepare(query).all(...params) as Trade[];
    const wins = trades.filter(t => (t.pnl ?? 0) > 0);
    const losses = trades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = trades.reduce((a, t) => a + (t.pnl ?? 0), 0);
    return {
      totalPnl, wins: wins.length, losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      tradeCount: trades.length,
      bestTrade: wins.length ? Math.max(...wins.map(t => t.pnl ?? 0)) : 0,
      worstTrade: losses.length ? Math.min(...losses.map(t => t.pnl ?? 0)) : 0,
      avgPnl: trades.length ? totalPnl / trades.length : 0
    };
  },

  insertSignal(signal: Omit<Signal, 'id' | 'created_at'>): void {
    getDb().prepare(`
      INSERT OR IGNORE INTO signals
        (signal_uuid, symbol, direction, entry_price, stop_loss, take_profit, risk_reward,
         confidence, probability, trend_summary, volume_confirmation, market_structure,
         entry_reason, timeframe, expected_duration, status, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      signal.signal_uuid, signal.symbol, signal.direction, signal.entry_price,
      signal.stop_loss, signal.take_profit, signal.risk_reward, signal.confidence,
      signal.probability, signal.trend_summary, signal.volume_confirmation,
      signal.market_structure, signal.entry_reason, signal.timeframe,
      signal.expected_duration, signal.status, signal.expires_at
    );
  },

  getRecentSignals(limit = 10): Signal[] {
    return getDb().prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit) as Signal[];
  },

  dbLog(level: string, category: string, message: string, meta?: object): void {
    try {
      getDb().prepare('INSERT INTO system_logs (level, category, message, meta) VALUES (?,?,?,?)')
        .run(level, category, message, meta ? JSON.stringify(meta) : null);
    } catch {}
  },

  getRecentDbLogs(limit = 50): Array<{ level: string; category: string; message: string; meta: string | null; created_at: string }> {
    return getDb().prepare('SELECT * FROM system_logs ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  },

  getTodayLoss(userId: number): number {
    const today = new Date().toISOString().slice(0, 10);
    const row = getDb().prepare('SELECT daily_loss FROM daily_stats WHERE user_id = ? AND date = ?').get(userId, today) as { daily_loss: number } | undefined;
    return row?.daily_loss ?? 0;
  },

  recordDailyLoss(userId: number, amount: number): void {
    const today = new Date().toISOString().slice(0, 10);
    getDb().prepare(`
      INSERT INTO daily_stats (user_id, date, daily_loss) VALUES (?,?,?)
      ON CONFLICT(user_id, date) DO UPDATE SET daily_loss = daily_loss + excluded.daily_loss
    `).run(userId, today, amount);
  },

  // ── Admin convenience methods ───────────────────────────────────────────────
  setUserActive(telegramId: string, active: number): void {
    getDb().prepare(`UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(active, telegramId);
    // Disable auto-trade when banning
    if (!active) {
      getDb().prepare(`UPDATE users SET auto_trade = 0, updated_at = datetime('now') WHERE telegram_id = ?`)
        .run(telegramId);
    }
  },

  setUserSetting(telegramId: string, key: string, value: number | string): void {
    // Whitelist allowed keys to prevent SQL injection
    const allowed = [
      'auto_trade', 'leverage', 'risk_per_trade', 'max_open_trades',
      'daily_loss_limit', 'confidence_threshold', 'break_even_enabled',
      'trailing_stop_enabled', 'trailing_stop_pct', 'max_drawdown',
    ];
    if (!allowed.includes(key)) {
      logger.warn(`[DB] setUserSetting: key '${key}' is not allowed`);
      return;
    }
    getDb().prepare(`UPDATE users SET ${key} = ?, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(value, telegramId);
  },
};
