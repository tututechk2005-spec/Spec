import axios, { AxiosInstance, AxiosError } from 'axios';
import crypto from 'crypto';
import WebSocket from 'ws';
import { logger } from './utils';
import { decrypt } from './config';
import { User } from './database';

// ── Endpoints ─────────────────────────────────────────────────────────────────
export const LIVE_REST   = 'https://fapi.binance.com';
export const TESTNET_REST = 'https://testnet.binancefutures.com';
export const LIVE_WS     = 'wss://fstream.binance.com';
export const TESTNET_WS  = 'wss://stream.binancefutures.com';

// Legacy aliases kept so other files don't break
export const BASE_URL    = LIVE_REST;
export const TESTNET_URL = TESTNET_REST;
export const WS_BASE     = LIVE_WS;
export const WS_TESTNET  = TESTNET_WS;

// ── Binance error-code catalogue ──────────────────────────────────────────────
const BINANCE_ERRORS: Record<number, string> = {
  [-1000]: 'Unknown Binance error',
  [-1001]: 'Disconnected — internal Binance error',
  [-1002]: 'Unauthorized — check your API key',
  [-1003]: 'Too many requests — rate-limited',
  [-1006]: 'Unexpected Binance response',
  [-1007]: 'Timeout from Binance',
  [-1013]: 'Invalid quantity — below minimum or step size',
  [-1021]: 'Timestamp out of sync — check server time',
  [-1022]: 'Invalid signature — your API Secret is wrong',
  [-1100]: 'Illegal characters in parameter',
  [-1102]: 'Mandatory parameter missing',
  [-1111]: 'Precision exceeds maximum for this symbol',
  [-1121]: 'Invalid symbol',
  [-2010]: 'Order would immediately trigger',
  [-2014]: 'API key format invalid',
  [-2015]: 'API key invalid, IP not whitelisted, or Futures permission disabled',
  [-2018]: 'Balance is insufficient',
  [-2019]: 'Margin is insufficient',
  [-4003]: 'Quantity below minimum',
  [-4061]: 'Order quantity insufficient for this operation',
  [-4131]: 'Percentage too high (notional exceeds limit)',
};

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AccountInfo {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  totalInitialMargin: number;
  totalMaintMargin: number;
  totalAvailableBalance: number;
  totalCrossWalletBalance: number;
  assets: Array<{
    asset: string;
    walletBalance: string;
    unrealizedProfit: string;
    marginBalance: string;
    availableBalance: string;
  }>;
}

export interface Position {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  isolatedMargin: number;
  initialMargin: number;
  maintMargin: number;
  notional: number;
  isAutoAddMargin: boolean;
  maxNotionalValue: number;
  updateTime: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface OrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  side: string;
  type: string;
}

export interface FundingRate {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

export interface ExchangeInfo {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<{ filterType: string; minQty?: string; stepSize?: string; minNotional?: string }>;
  }>;
}

// ── Binance Client ────────────────────────────────────────────────────────────
export class BinanceClient {
  readonly http: AxiosInstance;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl: string;
  readonly testnet: boolean;

  constructor(apiKey: string, apiSecret: string, testnet = false) {
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.testnet   = testnet;
    this.baseUrl   = testnet ? TESTNET_REST : LIVE_REST;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 12000,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
  }

  sign(params: Record<string, string | number>): string {
    const ts = Date.now();
    const qs = Object.entries({ ...params, timestamp: ts, recvWindow: 5000 })
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const qs = this.sign({});
    const r = await this.http.get(`/fapi/v2/account?${qs}`);
    const d = r.data;
    return {
      totalWalletBalance:     parseFloat(d.totalWalletBalance),
      totalUnrealizedProfit:  parseFloat(d.totalUnrealizedProfit),
      totalMarginBalance:     parseFloat(d.totalMarginBalance),
      totalInitialMargin:     parseFloat(d.totalInitialMargin),
      totalMaintMargin:       parseFloat(d.totalMaintMargin),
      totalAvailableBalance:  parseFloat(d.availableBalance),
      totalCrossWalletBalance: parseFloat(d.totalCrossWalletBalance),
      assets: d.assets,
    };
  }

  async getPositions(): Promise<Position[]> {
    const qs = this.sign({});
    const r = await this.http.get(`/fapi/v2/positionRisk?${qs}`);
    return (r.data as any[])
      .filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0)
      .map((p: any) => ({
        symbol:            p.symbol,
        positionSide:      p.positionSide,
        positionAmt:       parseFloat(p.positionAmt),
        entryPrice:        parseFloat(p.entryPrice),
        markPrice:         parseFloat(p.markPrice),
        unRealizedProfit:  parseFloat(p.unRealizedProfit),
        liquidationPrice:  parseFloat(p.liquidationPrice),
        leverage:          parseInt(p.leverage),
        marginType:        p.marginType,
        isolatedMargin:    parseFloat(p.isolatedMargin),
        initialMargin:     parseFloat(p.initialMargin),
        maintMargin:       parseFloat(p.maintMargin),
        notional:          Math.abs(parseFloat(p.notional)),
        isAutoAddMargin:   p.isAutoAddMargin === 'true',
        maxNotionalValue:  parseFloat(p.maxNotionalValue),
        updateTime:        p.updateTime,
      }));
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.http.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    return parseFloat(r.data.markPrice);
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const p: Record<string, string | number> = {};
    if (symbol) p.symbol = symbol;
    const qs = this.sign(p);
    const r = await this.http.get(`/fapi/v1/openOrders?${qs}`);
    return r.data;
  }

  async placeMarketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, reduceOnly = false): Promise<OrderResult> {
    const p: Record<string, string | number> = { symbol, side, type: 'MARKET', quantity };
    if (reduceOnly) p.reduceOnly = 'true';
    const qs = this.sign(p);
    const r = await this.http.post(`/fapi/v1/order?${qs}`);
    return r.data;
  }

  async placeStopLoss(symbol: string, side: 'BUY' | 'SELL', quantity: number, stopPrice: number): Promise<OrderResult> {
    const qs = this.sign({ symbol, side, type: 'STOP_MARKET', stopPrice: stopPrice.toFixed(8), quantity, reduceOnly: 'true', closePosition: 'false' });
    const r = await this.http.post(`/fapi/v1/order?${qs}`);
    return r.data;
  }

  async placeTakeProfit(symbol: string, side: 'BUY' | 'SELL', quantity: number, stopPrice: number): Promise<OrderResult> {
    const qs = this.sign({ symbol, side, type: 'TAKE_PROFIT_MARKET', stopPrice: stopPrice.toFixed(8), quantity, reduceOnly: 'true', closePosition: 'false' });
    const r = await this.http.post(`/fapi/v1/order?${qs}`);
    return r.data;
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    const qs = this.sign({ symbol, orderId });
    await this.http.delete(`/fapi/v1/order?${qs}`);
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    const qs = this.sign({ symbol });
    await this.http.delete(`/fapi/v1/allOpenOrders?${qs}`);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const qs = this.sign({ symbol, leverage });
    await this.http.post(`/fapi/v1/leverage?${qs}`);
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    const r = await this.http.get('/fapi/v1/exchangeInfo');
    return r.data;
  }

  async closePosition(symbol: string, positionAmt: number): Promise<OrderResult> {
    const isLong = positionAmt > 0;
    const side: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    return this.placeMarketOrder(symbol, side, Math.abs(positionAmt), true);
  }

  async closePartialPosition(symbol: string, positionAmt: number, pct: number): Promise<OrderResult> {
    const isLong = positionAmt > 0;
    const side: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    const qty = parseFloat((Math.abs(positionAmt) * pct).toFixed(6));
    return this.placeMarketOrder(symbol, side, qty, true);
  }

  async reversePosition(symbol: string, positionAmt: number): Promise<OrderResult> {
    const isLong = positionAmt > 0;
    const side: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    const qty = parseFloat((Math.abs(positionAmt) * 2).toFixed(6));
    return this.placeMarketOrder(symbol, side, qty, false);
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const r = await this.http.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    return { symbol: r.data.symbol, fundingRate: parseFloat(r.data.lastFundingRate), fundingTime: r.data.nextFundingTime };
  }

  async getOpenInterest(symbol: string): Promise<number> {
    const r = await this.http.get(`/fapi/v1/openInterest?symbol=${symbol}`);
    return parseFloat(r.data.openInterest);
  }

  async getKlines(symbol: string, interval: string, limit = 200): Promise<any[][]> {
    const r = await this.http.get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return r.data;
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const r = await this.http.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
    return parseFloat(r.data.price);
  }

  async get24hrTicker(symbol?: string): Promise<any> {
    const url = symbol ? `/fapi/v1/ticker/24hr?symbol=${symbol}` : '/fapi/v1/ticker/24hr';
    const r = await this.http.get(url);
    return r.data;
  }

  async getListenKey(): Promise<string> {
    const r = await this.http.post('/fapi/v1/listenKey');
    return r.data.listenKey;
  }

  async keepAliveListenKey(listenKey: string): Promise<void> {
    await this.http.put(`/fapi/v1/listenKey?listenKey=${listenKey}`);
  }

  // Simple ping — used by health checks only, NOT for API key validation
  async ping(): Promise<boolean> {
    try { await this.http.get('/fapi/v1/ping'); return true; } catch { return false; }
  }
}

// ── Strict API key validation ─────────────────────────────────────────────────
// NEVER tries both endpoints. Uses EXACTLY the endpoint the user selected.
// Returns a precise, human-readable failure reason for every Binance error code.

export interface ValidateResult {
  valid: boolean;
  testnet: boolean;
  reason?: string;           // shown to user on failure
  permissions?: {            // shown on success
    read: boolean;
    futures: boolean;
  };
}

export async function validateApiKeys(
  apiKey: string,
  apiSecret: string,
  testnet: boolean,          // REQUIRED — must match user selection exactly
): Promise<ValidateResult> {
  const endpoint = testnet ? TESTNET_REST : LIVE_REST;
  const label    = testnet ? 'Testnet (testnet.binancefutures.com)' : 'Live (fapi.binance.com)';

  logger.info(`[Validate] Checking keys on ${label}`);

  // Step 1 — validate key format before hitting Binance
  if (!apiKey || apiKey.length < 10) {
    return { valid: false, testnet, reason: '❌ API Key is too short or empty.' };
  }
  if (!apiSecret || apiSecret.length < 10) {
    return { valid: false, testnet, reason: '❌ API Secret is too short or empty.' };
  }

  const http = axios.create({
    baseURL:  endpoint,
    timeout:  12000,
    headers:  { 'X-MBX-APIKEY': apiKey },
  });

  function sign(params: Record<string, string | number>): string {
    const qs = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5000 })
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  try {
    const qs = sign({});
    const r  = await http.get(`/fapi/v2/account?${qs}`);

    // ── Success ───────────────────────────────────────────────────────────────
    const data = r.data;
    logger.info(`[Validate] ✅ Keys valid on ${label}`);
    return {
      valid: true,
      testnet,
      permissions: { read: true, futures: true },
    };
  } catch (err: any) {
    return { valid: false, testnet, reason: interpretError(err, testnet) };
  }
}

// ── Interpret every possible Binance / network error precisely ────────────────
function interpretError(err: any, isTestnet: boolean): string {
  const isAxiosErr = err?.isAxiosError === true;

  // Network-level errors (no response received)
  if (!isAxiosErr || !err.response) {
    const code = err?.code ?? '';
    if (code === 'ECONNREFUSED')  return '🌐 Connection refused — Binance endpoint unreachable.';
    if (code === 'ETIMEDOUT')     return '⏱ Connection timed out — Binance did not respond. Try again.';
    if (code === 'ENOTFOUND')     return '🌐 DNS resolution failed — check your internet connection.';
    if (code === 'ECONNRESET')    return '🌐 Connection reset by server. Try again.';
    return `🌐 Network error: ${err?.message ?? 'Unknown'}`;
  }

  const status    = err.response.status as number;
  const body      = err.response.data ?? {};
  const binCode   = body.code as number | undefined;
  const binMsg    = body.msg  as string | undefined;

  logger.warn(`[Validate] HTTP ${status} | code=${binCode} | msg=${binMsg}`);

  // ── HTTP 403 ──────────────────────────────────────────────────────────────
  if (status === 403) {
    return '🚫 Access denied (HTTP 403) — your IP may be banned or the API key is disabled on Binance.';
  }

  // ── HTTP 401 ──────────────────────────────────────────────────────────────
  if (status === 401) {
    return '🔑 Unauthorized (HTTP 401) — invalid API key.';
  }

  // ── HTTP 5xx — Binance server errors ─────────────────────────────────────
  if (status >= 500) {
    return `🔧 Binance server error (HTTP ${status}) — not your fault. Try again in a few seconds.`;
  }

  // ── Map exact Binance error codes ─────────────────────────────────────────
  if (binCode !== undefined) {
    switch (binCode) {
      case -1021:
        return '⏱ Timestamp out of sync — your system clock is off. Sync it and try again.';
      case -1022:
        return '🔐 Invalid signature — your *API Secret* is incorrect. Double-check it.';
      case -2014:
        return '🔑 Invalid API Key format — the key you entered is malformed or does not exist.';
      case -2015:
        // Binance returns -2015 for: wrong key, IP blocked, OR no Futures permission
        // We give all three causes so user knows exactly what to check
        if (isTestnet) {
          return (
            '❌ Rejected by Testnet (code -2015).\n\n' +
            'Possible causes:\n' +
            '• This is a *Live* API key — you must select 💰 Real Account instead\n' +
            '• The key does not exist on testnet.binancefutures.com\n' +
            '• IP restriction is blocking access\n' +
            '• Futures permission is disabled on the key'
          );
        } else {
          return (
            '❌ Rejected by Live endpoint (code -2015).\n\n' +
            'Possible causes:\n' +
            '• This is a *Testnet* API key — you must select 🧪 Testnet instead\n' +
            '• The API key does not exist on fapi.binance.com\n' +
            '• IP restriction is blocking access\n' +
            '• Futures Trading permission is *not enabled* on this key'
          );
        }
      case -2018:
        return '💰 Insufficient balance — account has no USDT available.';
      case -2019:
        return '💰 Insufficient margin — account cannot cover required margin.';
      case -1100:
      case -1102:
        return `📝 Bad request parameters (code ${binCode}): ${binMsg ?? ''}`;
      default:
        if (BINANCE_ERRORS[binCode]) {
          return `⚠️ ${BINANCE_ERRORS[binCode]} (code ${binCode})`;
        }
        return `⚠️ Binance error code ${binCode}: ${binMsg ?? 'No details'}`;
    }
  }

  // Fallback: use HTTP status + raw message
  return `❌ HTTP ${status}: ${binMsg ?? err?.message ?? 'Unknown error from Binance'}`;
}

// ── Build authenticated client from stored user ───────────────────────────────
export function buildClientForUser(user: User): BinanceClient | null {
  if (!user.api_key_enc || !user.api_secret_enc) return null;
  try {
    const key    = decrypt(user.api_key_enc);
    const secret = decrypt(user.api_secret_enc);
    return new BinanceClient(key, secret, user.testnet === 1);
  } catch {
    return null;
  }
}

// ── Public data helpers (no auth, always Live endpoint) ───────────────────────
const publicHttp = axios.create({ baseURL: LIVE_REST, timeout: 10000 });

export async function getPublicKlines(symbol: string, interval: string, limit = 200): Promise<any[][]> {
  const r = await publicHttp.get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return r.data;
}

export async function getPublicMarkPrice(symbol: string): Promise<number> {
  const r = await publicHttp.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
  return parseFloat(r.data.markPrice);
}

export async function getPublicFundingRate(symbol: string): Promise<number> {
  const r = await publicHttp.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
  return parseFloat(r.data.lastFundingRate);
}

export async function getPublicOpenInterest(symbol: string): Promise<number> {
  try {
    const r = await publicHttp.get(`/fapi/v1/openInterest?symbol=${symbol}`);
    return parseFloat(r.data.openInterest);
  } catch { return 0; }
}

export async function getTopFuturesPairs(limit = 60): Promise<string[]> {
  const r = await publicHttp.get('/fapi/v1/ticker/24hr');
  return (r.data as any[])
    .filter((t: any) => t.symbol.endsWith('USDT'))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map((t: any) => t.symbol);
}

// ── Price WebSocket ───────────────────────────────────────────────────────────
export class PriceWebSocket {
  private ws: WebSocket | null = null;
  private prices: Map<string, number> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private url: string = '';
  private testnet: boolean;

  constructor(testnet = false) {
    this.testnet = testnet;
  }

  subscribe(symbols: string[]): void {
    if (this.ws) { this.ws.terminate(); this.ws = null; }
    if (!symbols.length) return;
    const base    = this.testnet ? TESTNET_WS : LIVE_WS;
    const streams = symbols.map(s => `${s.toLowerCase()}@markPrice`).join('/');
    this.url = `${base}/stream?streams=${streams}`;
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const d   = msg.data || msg;
        if (d.e === 'markPriceUpdate') this.prices.set(d.s, parseFloat(d.p));
      } catch {}
    });
    this.ws.on('close', () => {
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
    this.ws.on('error', (e) => {
      logger.warn(`[WS] Error: ${e.message}`);
    });
  }

  getPrice(symbol: string): number | undefined { return this.prices.get(symbol); }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.terminate(); this.ws = null; }
  }
}
