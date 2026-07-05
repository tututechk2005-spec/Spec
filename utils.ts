import winston from 'winston';
import path from 'path';
import fs from 'fs';

// ── Logger ────────────────────────────────────────────────────────────────────

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) =>
    `[${timestamp}] [${level.toUpperCase()}] ${stack || message}`
  )
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat)
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10485760,
      maxFiles: 10
    })
  ]
});

export function getRecentLogs(_n = 50): string[] { return []; }

// ── Technical Indicators ──────────────────────────────────────────────────────

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export function last<T>(arr: T[]): T | undefined { return arr[arr.length - 1]; }

export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [prev];
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function calcSMA(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    result.push(data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

export function calcRSI(closes: number[], period = 14): number[] {
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? Math.abs(d) : 0);
  }
  if (gains.length < period) return [];
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const values: number[] = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period; i < gains.length; i++) {
    ag = (ag * (period - 1) + gains[i]) / period;
    al = (al * (period - 1) + losses[i]) / period;
    values.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return values;
}

export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9): { MACD: number[]; signal: number[]; histogram: number[] } {
  const fastEMA = calcEMA(closes, fast);
  const slowEMA = calcEMA(closes, slow);
  const offset = slow - fast;
  const macdLine = fastEMA.slice(offset).map((v, i) => v - slowEMA[i]);
  const signalLine = calcEMA(macdLine, signal);
  const hist = macdLine.slice(signal - 1).map((v, i) => v - signalLine[i]);
  return { MACD: macdLine, signal: signalLine, histogram: hist };
}

export function calcBollinger(closes: number[], period = 20, mult = 2): { upper: number[]; middle: number[]; lower: number[]; bandwidth: number[] } {
  const middle = calcSMA(closes, period);
  const upper: number[] = [], lower: number[] = [], bandwidth: number[] = [];
  for (let i = 0; i < middle.length; i++) {
    const slice = closes.slice(i + closes.length - middle.length - period + 1 + i, i + closes.length - middle.length + i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length);
    upper.push(middle[i] + mult * std);
    lower.push(middle[i] - mult * std);
    bandwidth.push((2 * mult * std) / middle[i]);
  }
  return { upper, middle, lower, bandwidth };
}

export function calcATR(klines: Kline[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  if (trs.length < period) return [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const values = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    values.push(atr);
  }
  return values;
}

export function calcADX(klines: Kline[], period = 14): { adx: number[]; pdi: number[]; mdi: number[] } {
  const pDM: number[] = [], nDM: number[] = [], trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    pDM.push(up > down && up > 0 ? up : 0);
    nDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  if (trs.length < period * 2) return { adx: [], pdi: [], mdi: [] };
  const smooth = (arr: number[]) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const sTR = smooth(trs), sPDM = smooth(pDM), sNDM = smooth(nDM);
  const pdi = sPDM.map((v, i) => sTR[i] ? (v / sTR[i]) * 100 : 0);
  const mdi = sNDM.map((v, i) => sTR[i] ? (v / sTR[i]) * 100 : 0);
  const dx = pdi.map((v, i) => {
    const sum = v + mdi[i];
    return sum ? (Math.abs(v - mdi[i]) / sum) * 100 : 0;
  });
  const adxArr: number[] = [];
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxArr.push(adxVal);
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    adxArr.push(adxVal);
  }
  return { adx: adxArr, pdi: pdi.slice(period - 1), mdi: mdi.slice(period - 1) };
}

export function calcVWAP(klines: Kline[]): number[] {
  let cumTPV = 0, cumVol = 0;
  return klines.map(k => {
    const tp = (k.high + k.low + k.close) / 3;
    cumTPV += tp * k.volume;
    cumVol += k.volume;
    return cumVol ? cumTPV / cumVol : tp;
  });
}

export function calcSupertrend(klines: Kline[], period = 10, mult = 3): { trend: number[]; direction: number[] } {
  const atrs = calcATR(klines, period);
  const offset = klines.length - atrs.length;
  const trend: number[] = [], direction: number[] = [];
  let prevUp = 0, prevDown = 0, prevDir = 1;

  for (let i = 0; i < atrs.length; i++) {
    const k = klines[i + offset];
    const hl2 = (k.high + k.low) / 2;
    const up = hl2 - mult * atrs[i];
    const down = hl2 + mult * atrs[i];
    const adjUp = (i === 0 || klines[i + offset - 1].close < prevUp) ? up : Math.max(up, prevUp);
    const adjDown = (i === 0 || klines[i + offset - 1].close > prevDown) ? down : Math.min(down, prevDown);

    let dir = prevDir;
    if (prevDir === -1 && k.close > prevDown) dir = 1;
    else if (prevDir === 1 && k.close < prevUp) dir = -1;

    trend.push(dir === 1 ? adjUp : adjDown);
    direction.push(dir);
    prevUp = adjUp; prevDown = adjDown; prevDir = dir;
  }
  return { trend, direction };
}

export function calcOBV(klines: Kline[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < klines.length; i++) {
    const prev = result[result.length - 1];
    if (klines[i].close > klines[i - 1].close) result.push(prev + klines[i].volume);
    else if (klines[i].close < klines[i - 1].close) result.push(prev - klines[i].volume);
    else result.push(prev);
  }
  return result;
}

export function detectOrderBlocks(klines: Kline[]): { bullish: number[]; bearish: number[] } {
  const bullish: number[] = [], bearish: number[] = [];
  for (let i = 2; i < klines.length - 1; i++) {
    if (klines[i - 1].close < klines[i - 1].open && klines[i].close > klines[i].open && klines[i].close > klines[i - 1].open)
      bullish.push(klines[i - 1].low);
    if (klines[i - 1].close > klines[i - 1].open && klines[i].close < klines[i].open && klines[i].close < klines[i - 1].open)
      bearish.push(klines[i - 1].high);
  }
  return { bullish: bullish.slice(-5), bearish: bearish.slice(-5) };
}

export function detectFVG(klines: Kline[]): { bullishFVG: number[]; bearishFVG: number[] } {
  const bullishFVG: number[] = [], bearishFVG: number[] = [];
  for (let i = 2; i < klines.length; i++) {
    if (klines[i].low > klines[i - 2].high) bullishFVG.push((klines[i].low + klines[i - 2].high) / 2);
    if (klines[i].high < klines[i - 2].low) bearishFVG.push((klines[i].high + klines[i - 2].low) / 2);
  }
  return { bullishFVG: bullishFVG.slice(-3), bearishFVG: bearishFVG.slice(-3) };
}

export function detectLiquiditySweep(klines: Kline[]): { type: 'bullish' | 'bearish' | 'none'; level: number } {
  if (klines.length < 20) return { type: 'none', level: 0 };
  const lookback = klines.slice(-20);
  const recent = klines[klines.length - 1];
  const highs = lookback.map(k => k.high);
  const lows = lookback.map(k => k.low);
  const prevHigh = Math.max(...highs.slice(0, -1));
  const prevLow = Math.min(...lows.slice(0, -1));
  if (recent.high > prevHigh && recent.close < prevHigh) return { type: 'bearish', level: prevHigh };
  if (recent.low < prevLow && recent.close > prevLow) return { type: 'bullish', level: prevLow };
  return { type: 'none', level: 0 };
}

export function detectSupportResistance(klines: Kline[]): { supports: number[]; resistances: number[] } {
  const supports: number[] = [], resistances: number[] = [];
  const lookback = klines.slice(-50);
  for (let i = 2; i < lookback.length - 2; i++) {
    const k = lookback[i];
    if (k.low < lookback[i - 1].low && k.low < lookback[i - 2].low &&
        k.low < lookback[i + 1].low && k.low < lookback[i + 2].low) supports.push(k.low);
    if (k.high > lookback[i - 1].high && k.high > lookback[i - 2].high &&
        k.high > lookback[i + 1].high && k.high > lookback[i + 2].high) resistances.push(k.high);
  }
  return { supports: supports.slice(-5), resistances: resistances.slice(-5) };
}
