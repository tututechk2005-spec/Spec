import { EventEmitter } from 'events';
import { logger } from './utils';
import { getPublicKlines, getTopFuturesPairs } from './binance';
import { analyseSymbol, TradingSignal } from './strategy';
import { Kline } from './utils';

function toKline(raw: any[]): Kline {
  return {
    openTime: raw[0], open: parseFloat(raw[1]), high: parseFloat(raw[2]),
    low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]),
    closeTime: raw[6], quoteVolume: parseFloat(raw[7]), trades: raw[8]
  };
}

export class MarketScanner extends EventEmitter {
  private running = false;
  private pairs: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private confidenceThreshold: number;
  private scanInterval: number;

  constructor(_testnet = false, confidenceThreshold = 90, scanInterval = 60_000) {
    super();
    this.confidenceThreshold = confidenceThreshold;
    this.scanInterval = scanInterval;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('[Scanner] Starting market scanner...');
    try {
      this.pairs = await getTopFuturesPairs(60);
      logger.info(`[Scanner] Watching ${this.pairs.length} pairs`);
    } catch (e) {
      logger.error('[Scanner] Failed to load pairs: ' + e);
      this.pairs = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
    }
    await this.scan();
    this.timer = setInterval(() => this.scan(), this.scanInterval);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getPairCount(): number { return this.pairs.length; }
  isRunning(): boolean { return this.running; }

  async scanSingle(symbol: string): Promise<TradingSignal | null> {
    try {
      const [raw1h, raw15m, raw4h] = await Promise.all([
        getPublicKlines(symbol, '1h', 200),
        getPublicKlines(symbol, '15m', 100),
        getPublicKlines(symbol, '4h', 100)
      ]);
      const k1h = raw1h.map(toKline);
      const k15m = raw15m.map(toKline);
      const k4h = raw4h.map(toKline);
      return analyseSymbol(symbol, k1h, k15m, k4h, this.confidenceThreshold);
    } catch { return null; }
  }

  private async scan(): Promise<void> {
    if (!this.running) return;
    logger.info(`[Scanner] Scanning ${this.pairs.length} pairs...`);
    let found = 0;
    const batch = 8;
    for (let i = 0; i < this.pairs.length; i += batch) {
      if (!this.running) break;
      const chunk = this.pairs.slice(i, i + batch);
      await Promise.all(chunk.map(async (symbol) => {
        try {
          const signal = await this.scanSingle(symbol);
          if (signal) { found++; this.emit('signal', signal); }
        } catch {}
      }));
      await new Promise(r => setTimeout(r, 300));
    }
    logger.info(`[Scanner] Scan complete — ${found} signal(s) found`);
  }
}
