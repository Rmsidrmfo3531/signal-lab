// Diagnostic calculations from the shared AI Lens settings, on confirmed bars.
import {adx14, rsi14, seededEMA} from './indicators.mjs';

export const LENS_HIGHER_INTERVAL_MS = 4 * 60 * 60_000;
const EMA_SLOPE_BARS = 5;
const SLOW_EMA_BARS = 200;
const VOLUME_BARS = 20;
const ATR_RANK_BARS = 100;
const HIGH_VOLATILITY_RANK = 90;
const PIVOT_BARS = 5;

export function aiLensStatus(status) {
  return {version: 1, model: 'AI_LENS_SETTINGS_OBSERVATION', timeframe: '15m', status};
}

function latestPivots(bars) {
  let high = null;
  let low = null;
  for (let i = bars.length - 1 - PIVOT_BARS; i >= PIVOT_BARS && !(high && low); i--) {
    const bar = bars[i];
    const neighbors = bars.slice(i - PIVOT_BARS, i + PIVOT_BARS + 1);
    const confirmedAt = bars[i + PIVOT_BARS].at;
    if (!high && neighbors.every(b => b === bar || b.high < bar.high)) {
      high = {price: bar.high, at: bar.at, confirmedAt};
    }
    if (!low && neighbors.every(b => b === bar || b.low > bar.low)) {
      low = {price: bar.low, at: bar.at, confirmedAt};
    }
  }
  return {high, low};
}

export function observeAiLens(bars) {
  if (bars.length < SLOW_EMA_BARS + EMA_SLOPE_BARS) return aiLensStatus('INSUFFICIENT_CANDLES');
  const last = bars.at(-1);
  const closes = bars.map(b => b.close);
  const slow = seededEMA(closes, SLOW_EMA_BARS);
  const rsi = rsi14(bars);
  const dmi = adx14(bars);
  const volumeSma20 = bars.slice(-VOLUME_BARS).reduce((sum, bar) => sum + bar.volume, 0) / VOLUME_BARS;
  // Rank the latest ATR against the last 100 ATR readings including itself.
  const atrPercentRank = 100 * bars.slice(-ATR_RANK_BARS).filter(bar => bar.atr <= last.atr).length / ATR_RANK_BARS;
  return {
    ...aiLensStatus('OK'), closedCandleAt: last.at, close: last.close,
    ema20: seededEMA(closes, 20).at(-1),
    ema50: seededEMA(closes, 50).at(-1),
    ema200: slow.at(-1),
    ema200Change5: slow.at(-1) - slow.at(-1 - EMA_SLOPE_BARS),
    rsi14: rsi, rsiOverbought: rsi >= 75, rsiOversold: rsi <= 25,
    adx14: dmi.adx, plusDI14: dmi.plusDI, minusDI14: dmi.minusDI, adxTrend: dmi.adx >= 20,
    volume: last.volume, volumeSma20, volumeRatio: volumeSma20 > 0 ? last.volume / volumeSma20 : null,
    atr14: last.atr, atrPercentRank100: atrPercentRank, highVolatility: atrPercentRank >= HIGH_VOLATILITY_RANK,
    pivots: latestPivots(bars),
  };
}

export function aiLensHigherTimeframe(bars) {
  if (bars.length < 50) return null;
  const last = bars.at(-1);
  return {timeframe: '4h', closedCandleAt: last.at, close: last.close, ema50: seededEMA(bars.map(b => b.close), 50).at(-1)};
}

export function aiLensRiskMap(referenceEntry, direction, atr) {
  if (!Number.isFinite(referenceEntry) || referenceEntry <= 0 || !Number.isFinite(atr) || atr <= 0) return null;
  if (!['LONG', 'SHORT'].includes(direction)) return null;
  const sign = direction === 'LONG' ? 1 : -1;
  const risk = 1.5 * atr;
  const stop = referenceEntry - sign * risk;
  const target1 = referenceEntry + sign * risk * 1.5;
  const target2 = referenceEntry + sign * risk * 3;
  if (![stop, target1, target2].every(level => Number.isFinite(level) && level > 0)) return null;
  return {referenceEntry, stop, target1, target2};
}
