import { v4 as uuidv4 } from 'uuid';
import { Kline, calcEMA, calcRSI, calcMACD, calcBollinger, calcATR, calcADX, calcVWAP, calcSupertrend, calcOBV, detectOrderBlocks, detectFVG, detectLiquiditySweep, detectSupportResistance, last } from './utils';
import { getPublicFundingRate, getPublicOpenInterest } from './binance';
import { db } from './database';

export interface TradingSignal {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confidence: number;
  probability: number;
  trendSummary: string;
  marketStructure: string;
  entryReason: string;
  timeframe: string;
  expectedDuration: string;
  volumeConfirmation: string;
  uuid: string;
}

// Session filter: London 07:00–16:00 UTC, New York 12:00–21:00 UTC
function isTradingSession(): boolean {
  const h = new Date().getUTCHours();
  const london = h >= 7 && h < 16;
  const newYork = h >= 12 && h < 21;
  return london || newYork;
}

function getSessionName(): string {
  const h = new Date().getUTCHours();
  if (h >= 7 && h < 12) return 'London';
  if (h >= 12 && h < 16) return 'London+NY Overlap';
  if (h >= 16 && h < 21) return 'New York';
  return 'Asian (low liquidity)';
}

// Deduplication: reject same symbol/direction within 4 hours
const recentSignals = new Map<string, number>();
function isDuplicate(symbol: string, direction: string): boolean {
  const key = `${symbol}-${direction}`;
  const last = recentSignals.get(key) || 0;
  const now = Date.now();
  if (now - last < 4 * 60 * 60 * 1000) return true;
  recentSignals.set(key, now);
  return false;
}

export async function analyseSymbol(
  symbol: string,
  klines1h: Kline[],
  klines15m: Kline[],
  klines4h: Kline[],
  confidenceThreshold = 90
): Promise<TradingSignal | null> {
  try {
    if (klines1h.length < 100 || klines15m.length < 60) return null;

    // ── 4H Trend Context ──────────────────────────────────────────────────────
    const closes4h = klines4h.map(k => k.close);
    const ema21_4h = calcEMA(closes4h, 21);
    const ema55_4h = calcEMA(closes4h, 55);
    const rsi4h = calcRSI(closes4h, 14);
    const trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      last(ema21_4h)! > last(ema55_4h)! && last(rsi4h)! > 50 ? 'BULLISH' :
      last(ema21_4h)! < last(ema55_4h)! && last(rsi4h)! < 50 ? 'BEARISH' : 'NEUTRAL';
    if (trend4h === 'NEUTRAL') return null;

    // ── 1H Analysis ───────────────────────────────────────────────────────────
    const closes1h = klines1h.map(k => k.close);
    const highs1h = klines1h.map(k => k.high);
    const lows1h = klines1h.map(k => k.low);
    const vols1h = klines1h.map(k => k.volume);

    const ema9 = calcEMA(closes1h, 9);
    const ema21 = calcEMA(closes1h, 21);
    const ema50 = calcEMA(closes1h, 50);
    const ema200 = calcEMA(closes1h, 200);
    const rsi1h = calcRSI(closes1h, 14);
    const macd = calcMACD(closes1h);
    const boll = calcBollinger(closes1h, 20, 2);
    const atr = calcATR(klines1h, 14);
    const adx = calcADX(klines1h, 14);
    const vwap = calcVWAP(klines1h);
    const supertrend = calcSupertrend(klines1h, 10, 3);
    const obv = calcOBV(klines1h);
    const { bullish: bullOB, bearish: bearOB } = detectOrderBlocks(klines1h);
    const { bullishFVG, bearishFVG } = detectFVG(klines1h);
    const liqSweep = detectLiquiditySweep(klines1h);
    const { supports, resistances } = detectSupportResistance(klines1h);

    const price = last(closes1h)!;
    const atrVal = last(atr)!;
    const rsiVal = last(rsi1h)!;
    const macdHist = last(macd.histogram)!;
    const macdLine = last(macd.MACD)!;
    const adxVal = last(adx.adx)!;
    const stDir = last(supertrend.direction)!;
    const vwapVal = last(vwap)!;
    const bollUpper = last(boll.upper)!;
    const bollLower = last(boll.lower)!;
    const bollBw = last(boll.bandwidth)!;

    // ── Volatility filter: skip if too choppy (narrow BB) ────────────────────
    if (bollBw < 0.005) return null;
    // ── ADX filter: only trade trending markets ───────────────────────────────
    if (adxVal < 20) return null;
    // ── Session filter ────────────────────────────────────────────────────────
    if (!isTradingSession()) return null;

    // ── EMA Alignment score ────────────────────────────────────────────────────
    const e9 = last(ema9)!, e21 = last(ema21)!, e50 = last(ema50)!;
    const emaLongAligned = e9 > e21 && e21 > e50;
    const emaShortAligned = e9 < e21 && e21 < e50;

    // ── Volume: current vs avg ────────────────────────────────────────────────
    const avgVol = vols1h.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const lastVol = last(vols1h)!;
    const volConfirmed = lastVol > avgVol * 1.2;

    // ── OBV trend ─────────────────────────────────────────────────────────────
    const obvArr = obv;
    const obvRising = obvArr[obvArr.length - 1] > obvArr[obvArr.length - 5];
    const obvFalling = obvArr[obvArr.length - 1] < obvArr[obvArr.length - 5];

    // ── 15m confirmation ──────────────────────────────────────────────────────
    const closes15m = klines15m.map(k => k.close);
    const rsi15m = calcRSI(closes15m, 14);
    const ema21_15m = calcEMA(closes15m, 21);
    const rsi15mVal = last(rsi15m)!;
    const price15m = last(closes15m)!;
    const ema21_15m_val = last(ema21_15m)!;

    // ── Candlestick confirmation (last 3 candles) ─────────────────────────────
    const n = klines1h.length;
    const lastCandle = klines1h[n - 1];
    const prevCandle = klines1h[n - 2];
    const candleBullish = lastCandle.close > lastCandle.open && lastCandle.close > prevCandle.close;
    const candleBearish = lastCandle.close < lastCandle.open && lastCandle.close < prevCandle.close;

    // ── Funding rate (sentiment) ──────────────────────────────────────────────
    let fundingRate = 0;
    try { fundingRate = await getPublicFundingRate(symbol); } catch {}
    const fundingLong = fundingRate < 0.0003;    // low/negative = no crowd euphoria for longs
    const fundingShort = fundingRate > -0.0003;

    // ── LONG scoring ──────────────────────────────────────────────────────────
    let longScore = 0;
    const longReasons: string[] = [];

    if (trend4h === 'BULLISH') { longScore += 20; longReasons.push('4H bullish trend'); }
    if (emaLongAligned) { longScore += 15; longReasons.push('EMA9>21>50 aligned'); }
    if (stDir === 1) { longScore += 10; longReasons.push('Supertrend UP'); }
    if (price > vwapVal) { longScore += 8; longReasons.push('Price above VWAP'); }
    if (rsiVal > 50 && rsiVal < 70) { longScore += 8; longReasons.push(`RSI ${rsiVal.toFixed(0)} bullish`); }
    if (macdHist > 0 && macdLine > 0) { longScore += 8; longReasons.push('MACD bullish'); }
    if (volConfirmed && obvRising) { longScore += 8; longReasons.push('Volume + OBV rising'); }
    if (price > ema21_15m_val && rsi15mVal > 50) { longScore += 7; longReasons.push('15m confirms long'); }
    if (liqSweep.type === 'bullish') { longScore += 6; longReasons.push('Liquidity sweep bullish'); }
    if (bullOB.length > 0 && price > Math.min(...bullOB)) { longScore += 5; longReasons.push('Bullish order block'); }
    if (bullishFVG.length > 0) { longScore += 4; longReasons.push('Bullish FVG present'); }
    if (candleBullish) { longScore += 5; longReasons.push('Bullish candle'); }
    if (supports.length > 0 && price < Math.min(...supports) * 1.02) { longScore += 4; longReasons.push('Near support'); }
    if (adxVal > 30) { longScore += 4; longReasons.push(`ADX ${adxVal.toFixed(0)} strong trend`); }
    if (fundingLong) { longScore += 3; longReasons.push('Funding rate favorable'); }
    if (rsi15mVal > 40 && rsi15mVal < 70) { longScore += 3; longReasons.push('15m RSI healthy'); }

    // ── SHORT scoring ─────────────────────────────────────────────────────────
    let shortScore = 0;
    const shortReasons: string[] = [];

    if (trend4h === 'BEARISH') { shortScore += 20; shortReasons.push('4H bearish trend'); }
    if (emaShortAligned) { shortScore += 15; shortReasons.push('EMA9<21<50 aligned'); }
    if (stDir === -1) { shortScore += 10; shortReasons.push('Supertrend DOWN'); }
    if (price < vwapVal) { shortScore += 8; shortReasons.push('Price below VWAP'); }
    if (rsiVal < 50 && rsiVal > 30) { shortScore += 8; shortReasons.push(`RSI ${rsiVal.toFixed(0)} bearish`); }
    if (macdHist < 0 && macdLine < 0) { shortScore += 8; shortReasons.push('MACD bearish'); }
    if (volConfirmed && obvFalling) { shortScore += 8; shortReasons.push('Volume + OBV falling'); }
    if (price < ema21_15m_val && rsi15mVal < 50) { shortScore += 7; shortReasons.push('15m confirms short'); }
    if (liqSweep.type === 'bearish') { shortScore += 6; shortReasons.push('Liquidity sweep bearish'); }
    if (bearOB.length > 0 && price < Math.max(...bearOB)) { shortScore += 5; shortReasons.push('Bearish order block'); }
    if (bearishFVG.length > 0) { shortScore += 4; shortReasons.push('Bearish FVG present'); }
    if (candleBearish) { shortScore += 5; shortReasons.push('Bearish candle'); }
    if (resistances.length > 0 && price > Math.max(...resistances) * 0.98) { shortScore += 4; shortReasons.push('Near resistance'); }
    if (adxVal > 30) { shortScore += 4; shortReasons.push(`ADX ${adxVal.toFixed(0)} strong trend`); }
    if (fundingShort) { shortScore += 3; shortReasons.push('Funding rate favorable'); }
    if (rsi15mVal > 30 && rsi15mVal < 60) { shortScore += 3; shortReasons.push('15m RSI confirms'); }

    // Max score = 131
    const maxScore = 131;
    const longConf = Math.min(99, (longScore / maxScore) * 100);
    const shortConf = Math.min(99, (shortScore / maxScore) * 100);

    let direction: 'LONG' | 'SHORT';
    let confidence: number;
    let reasons: string[];
    let score: number;

    if (longConf >= shortConf && longConf >= confidenceThreshold) {
      direction = 'LONG'; confidence = longConf; reasons = longReasons; score = longScore;
    } else if (shortConf > longConf && shortConf >= confidenceThreshold) {
      direction = 'SHORT'; confidence = shortConf; reasons = shortReasons; score = shortScore;
    } else {
      return null; // confidence too low
    }

    // ── Reject duplicates ─────────────────────────────────────────────────────
    if (isDuplicate(symbol, direction)) return null;

    // ── Calculate SL/TP ───────────────────────────────────────────────────────
    const atrMult = 1.5;
    let stopLoss: number, takeProfit: number;

    if (direction === 'LONG') {
      const nearestSupport = supports.length ? Math.min(...supports) : price - atrVal * 2;
      stopLoss = Math.min(price - atrVal * atrMult, nearestSupport - atrVal * 0.5);
      const nearestResistance = resistances.length ? Math.max(...resistances) : price + atrVal * 4;
      takeProfit = Math.min(nearestResistance, price + atrVal * 3);
    } else {
      const nearestResistance = resistances.length ? Math.max(...resistances) : price + atrVal * 2;
      stopLoss = Math.max(price + atrVal * atrMult, nearestResistance + atrVal * 0.5);
      const nearestSupport = supports.length ? Math.min(...supports) : price - atrVal * 4;
      takeProfit = Math.max(nearestSupport, price - atrVal * 3);
    }

    const riskPips = Math.abs(price - stopLoss);
    const rewardPips = Math.abs(takeProfit - price);
    const riskReward = rewardPips / riskPips;

    // Reject poor RR
    if (riskReward < 1.5) return null;

    // ── Fake breakout filter ───────────────────────────────────────────────────
    if (direction === 'LONG' && price > bollUpper && rsiVal > 75) return null;
    if (direction === 'SHORT' && price < bollLower && rsiVal < 25) return null;

    const session = getSessionName();
    const prob = Math.min(99, confidence * 0.95);

    const signal: TradingSignal = {
      symbol, direction,
      entryPrice: parseFloat(price.toFixed(8)),
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat(riskReward.toFixed(2)),
      confidence: parseFloat(confidence.toFixed(1)),
      probability: parseFloat(prob.toFixed(1)),
      trendSummary: `4H ${trend4h} | 1H EMA ${emaLongAligned || emaShortAligned ? 'aligned' : 'mixed'} | ADX ${adxVal.toFixed(0)} | Session: ${session}`,
      marketStructure: `Supertrend ${stDir === 1 ? 'UP' : 'DOWN'} | VWAP ${price > vwapVal ? 'above' : 'below'} | ${liqSweep.type !== 'none' ? `Liq sweep: ${liqSweep.type}` : 'No sweep'}`,
      entryReason: reasons.slice(0, 5).join(', '),
      timeframe: '1H + 15M + 4H confluence',
      expectedDuration: adxVal > 35 ? '4–12 hours' : '2–6 hours',
      volumeConfirmation: `Vol ${volConfirmed ? '✅ above avg' : '⚠️ below avg'} | OBV ${obvRising ? 'rising' : obvFalling ? 'falling' : 'flat'}`,
      uuid: uuidv4()
    };

    // Save to DB
    db.insertSignal({
      signal_uuid: signal.uuid, symbol, direction,
      entry_price: signal.entryPrice, stop_loss: signal.stopLoss, take_profit: signal.takeProfit,
      risk_reward: signal.riskReward, confidence: signal.confidence, probability: signal.probability,
      trend_summary: signal.trendSummary, volume_confirmation: signal.volumeConfirmation,
      market_structure: signal.marketStructure, entry_reason: signal.entryReason,
      timeframe: signal.timeframe, expected_duration: signal.expectedDuration,
      status: 'PENDING', expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    });

    return signal;
  } catch (err) {
    return null;
  }
}

export function formatSignalMessage(s: TradingSignal): string {
  const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const pnlEmoji = s.direction === 'LONG' ? '📈' : '📉';
  return (
    `🚨 *NEW AI SIGNAL*\n\n` +
    `${pnlEmoji} *Pair:* \`${s.symbol}\`\n` +
    `*Direction:* ${dir}\n` +
    `*Entry:* \`${s.entryPrice}\`\n` +
    `*Stop Loss:* \`${s.stopLoss}\`\n` +
    `*Take Profit:* \`${s.takeProfit}\`\n` +
    `*Risk/Reward:* \`${s.riskReward}R\`\n` +
    `*Confidence:* \`${s.confidence}%\`\n` +
    `*Probability:* \`${s.probability}%\`\n` +
    `*Timeframe:* ${s.timeframe}\n` +
    `*Duration:* ${s.expectedDuration}\n\n` +
    `📊 *Market Structure*\n${s.marketStructure}\n\n` +
    `📈 *Trend Summary*\n${s.trendSummary}\n\n` +
    `💡 *Entry Reason*\n${s.entryReason}\n\n` +
    `🔊 *Volume*\n${s.volumeConfirmation}`
  );
}
