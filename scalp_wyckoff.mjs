// Independent Wyckoff structure observation using the shared Map inputs.
// The protected Pine engine was not available. Keep this out of order decisions.
import {observeVsa} from './scalp_vsa.mjs';

export const WYCKOFF_INTERVAL_MS = 15 * 60_000;
export const WYCKOFF_CANDLES = 1250;
const I = WYCKOFF_INTERVAL_MS;
const PIVOT_BARS = 3;
const TREND_WINDOW = 60;
const EXTREME_LOOKBACK = 30;
const ATR_PERIOD = 14;
const VOLUME_PERIOD = 20;

function closedBars(rows, asOf) {
  const byTime = new Map();
  for (const row of rows ?? []) {
    if (!Array.isArray(row)) continue;
    const [openAt, open, high, low, close, volume, end] = row.map(Number);
    if (![openAt, open, high, low, close, volume, end].every(Number.isFinite)) continue;
    if (openAt % I !== 0 || end !== openAt + I - 1 || end >= asOf) continue;
    if (low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) continue;
    byTime.set(openAt, {openAt, at: end + 1, high, low, close, volume, spread: high - low});
  }
  const bars = [...byTime.values()].sort((a, b) => a.at - b.at);
  const latest = Math.floor(asOf / I) * I;
  if (bars.at(-1)?.at !== latest) return [];
  // A missing candle breaks the sequence used for pivots and consecutive closes.
  let start = bars.length - 1;
  while (start > 0 && bars[start].at - bars[start - 1].at === I) start--;
  return bars.slice(start);
}

function addMetrics(bars) {
  let atr = 0;
  let volumeSum = 0;
  for (const [i, bar] of bars.entries()) {
    const previous = bars[i - 1];
    if (previous) {
      const range = Math.max(bar.spread, bar.high - previous.close, previous.close - bar.low);
      atr += (range - atr) / Math.min(i, ATR_PERIOD);
    }
    volumeSum += bar.volume;
    if (i >= VOLUME_PERIOD) volumeSum -= bars[i - VOLUME_PERIOD].volume;
    bar.atr = atr;
    bar.volumeRatio = volumeSum > 0 ? bar.volume * VOLUME_PERIOD / volumeSum : 0;
  }
}

// Measure in the direction of the reaction, so the same thresholds apply to SC and BC.
function edge(bar, direction) {
  return direction === 1 ? bar.low : -bar.high;
}
function farEdge(bar, direction) {
  return direction === 1 ? bar.high : -bar.low;
}

function findStop(bars, i, direction) {
  const bar = bars[i];
  const near = edge(bar, direction);
  const before = bars.slice(i - TREND_WINDOW, i);
  if (bars.slice(i - EXTREME_LOOKBACK + 1, i + PIVOT_BARS + 1)
    .some(other => edge(other, direction) < near || (other.at < bar.at && edge(other, direction) === near))) return null;
  const run = Math.max(...before.map(other => farEdge(other, direction))) - near;
  const atr = bars[i - 1].atr;
  if (atr <= 0 || run < 6 * atr || direction * bars[i - TREND_WINDOW].close <= direction * bar.close) return null;
  const neighborhood = bars.slice(i - 2, i + 3);
  const climax = neighborhood.some(other => other.volumeRatio >= 2.5)
    && neighborhood.some(other => other.spread >= 1.8 * atr);
  if (!climax && bar.volumeRatio < 1) return null;
  return {direction, stop: bar, near, run, atr, i, climax, peak: null, ar: null, st: null, inside: 0};
}

function advanceCandidate(candidate, bars, i) {
  const {direction, stop, near, atr} = candidate;
  const bar = bars[i];
  const close = bar.close * direction;
  const low = edge(bar, direction);
  const high = farEdge(bar, direction);
  if (!candidate.ar) {
    if (i - candidate.i > 30 || low < near - atr) return null;
    if (!candidate.peak || high > candidate.peak.level) candidate.peak = {level: high, i};
    const {level, i: arIndex} = candidate.peak;
    const height = level - near;
    if (arIndex === i || height < Math.max(3 * atr, .2 * candidate.run)
      || level - close < Math.max(atr, .3 * height)) return candidate;
    candidate.ar = {level, i: arIndex, confirmedIndex: Math.max(i, candidate.i + PIVOT_BARS)};
    candidate.inside = bars.slice(arIndex + 1, i).filter(b => b.close * direction >= near && b.close * direction <= level).length;
  }
  const far = candidate.ar.level;
  const age = i - candidate.ar.i;
  if (i - candidate.i > 150 || close < near - 1.5 * atr || close > far + 1.5 * atr) return null;
  candidate.inside += Number(close >= near && close <= far);
  // The screenshot supplies "Standard", without its formula. Use the documented quieter retest
  // and interpret the stop area as one ATR, for observation purposes only.
  if (low <= near + atr && close >= near && close <= far && bar.volume < stop.volume && bar.spread < stop.spread) candidate.st ??= i;
  const minimumAge = Math.max(15, 2 * (candidate.ar.i - candidate.i));
  const stOrTimeout = candidate.st !== null || age >= 20;
  if (age >= minimumAge && stOrTimeout && candidate.inside / age >= .7) {
    return {
      phase: 'B', confirmedAt: bar.at, startedAt: stop.at, ...candidateBox(candidate),
      stopEvent: direction === 1 ? (candidate.climax ? 'SC' : 'PS') : (candidate.climax ? 'BC' : 'PSY'),
      verdict: null, lastEvent: candidate.st === null ? 'RANGE_CONFIRMED' : 'ST',
      eventAt: candidate.st === null ? bar.at : bars[candidate.st].at, eventConfirmedAt: bar.at,
      excursion: null, beyond: 0, beyondDirection: 0,
    };
  }
  return candidate;
}

function candidateBox({direction, near, i, ar}) {
  return {
    direction, startIndex: i, arIndex: ar.i, arConfirmedIndex: ar.confirmedIndex,
    low: direction === 1 ? near : -ar.level, high: direction === 1 ? ar.level : -near,
  };
}

function advanceRange(range, bars, i) {
  const bar = bars[i];
  const atr = bars[i - 1].atr;
  const {low, high} = range;
  const height = high - low;
  const direction = bar.close > high ? 1 : bar.close < low ? -1 : 0;
  const distance = direction === 1 ? bar.close - high : direction === -1 ? low - bar.close : 0;
  const penetrationUp = bar.high - high;
  const penetrationDown = low - bar.low;
  const excursionDirection = direction || (penetrationUp > penetrationDown ? 1 : -1);
  const penetration = excursionDirection === 1 ? penetrationUp : penetrationDown;

  if (range.phase !== 'D' && i - range.arIndex >= 15) {
    if (range.excursion && i - range.excursion.i > 3) range.excursion = null;
    if (penetration >= .1 * atr && (direction !== 0 || !range.excursion)) {
      if (!range.excursion || range.excursion.direction !== excursionDirection) {
        range.excursion = {i, direction: excursionDirection, depth: penetration};
      } else {
        range.excursion.depth = Math.max(range.excursion.depth, penetration);
      }
    }
    if (range.excursion && direction === 0) {
      const excursion = range.excursion;
      if (range.breakout) {
        range.lastEvent = excursion.direction === 1 ? 'UT_CANDIDATE' : 'SPRING_CANDIDATE';
      } else {
        range.phase = 'C';
        range.verdict = excursion.direction === 1 ? 'SHORT' : 'LONG';
        range.lastEvent = excursion.direction === 1 ? 'UTAD' : excursion.depth >= atr ? 'SHAKEOUT' : 'SPRING';
      }
      range.eventAt = bars[excursion.i].at;
      range.eventConfirmedAt = bar.at;
      range.excursion = null;
    }
  }

  if (!direction || range.breakout?.direction !== direction) range.breakout = null;
  if (direction && !range.breakout && bar.spread >= 1.3 * atr && bar.volumeRatio >= 1.3) {
    range.breakout = {i, direction};
  }
  if (range.breakout && i - range.breakout.i >= 2 && range.phase !== 'D') {
    const verdict = direction === 1 ? 'LONG' : 'SHORT';
    if (range.verdict && range.verdict !== verdict) range.failedVerdict = range.verdict;
    range.phase = 'D';
    range.verdict = verdict;
    range.lastEvent = direction === 1 ? 'SOS' : 'SOW';
    range.eventAt = bars[range.breakout.i].at;
    range.eventConfirmedAt = bar.at;
  }

  const outsideBuffer = distance > Math.max(.5 * atr, .1 * height);
  if (!outsideBuffer) {
    range.beyond = 0;
    range.beyondDirection = 0;
  } else {
    range.beyond = range.beyondDirection === direction ? range.beyond + 1 : 1;
    range.beyondDirection = direction;
  }
  // Preserve the confirmed D event on the close that also resolves the range.
  if (range.beyond >= 3 || distance >= height || i - range.startIndex >= 1000) {
    range.closedAt = bar.at;
    range.exitDirection = distance >= height || range.beyond >= 3 ? (direction === 1 ? 'LONG' : 'SHORT') : null;
    if (range.exitDirection && range.verdict && range.exitDirection !== range.verdict) range.failedVerdict = range.verdict;
  }
}

function analyzeMap(bars) {
  const result = {version: 1, model: 'WYCKOFF_STRUCTURE_OBSERVATION', timeframe: '15m'};
  if (bars.length < TREND_WINDOW + PIVOT_BARS + 1) {
    return {map: {...result, status: 'INSUFFICIENT_CANDLES'}, box: null};
  }
  addMetrics(bars);
  let candidate = null;
  let range = null;
  for (let i = TREND_WINDOW; i < bars.length; i++) {
    if (range && !range.closedAt) {
      advanceRange(range, bars, i);
      continue;
    }
    const pivotIndex = i - PIVOT_BARS;
    if (pivotIndex >= TREND_WINDOW && !candidate?.ar) {
      const stop = findStop(bars, pivotIndex, 1) ?? findStop(bars, pivotIndex, -1);
      if (stop && (!candidate || candidate.direction !== stop.direction || stop.near < candidate.near)) {
        candidate = stop;
        for (let j = pivotIndex + 1; candidate && j < i; j++) candidate = advanceCandidate(candidate, bars, j);
      }
    }
    if (!candidate) continue;
    candidate = advanceCandidate(candidate, bars, i);
    if (candidate?.phase === 'B') {
      range = candidate;
      candidate = null;
    }
  }
  const closedCandleAt = bars.at(-1).at;
  if (candidate && (!range || range.closedAt)) {
    return {map: {...result, status: 'CANDIDATE', phase: 'A', closedCandleAt}, box: candidate.ar ? candidateBox(candidate) : null};
  }
  if (!range) return {map: {...result, status: 'NO_RANGE', closedCandleAt}, box: null};
  const {phase, low, high, stopEvent, startedAt, confirmedAt, verdict, lastEvent, eventAt, eventConfirmedAt, closedAt, exitDirection, failedVerdict} = range;
  const active = !closedAt;
  return {
    map: {...result, status: active ? 'CONFIRMED_RANGE' : 'ENDED_RANGE', phase, low, high, stopEvent, startedAt, confirmedAt,
      verdict, lastEvent, eventAt, eventConfirmedAt, closedAt: closedAt ?? null, exitDirection: exitDirection ?? null,
      failedVerdict: failedVerdict ?? null, closedCandleAt},
    box: range,
  };
}

export function observeScalpStructure(rows, {asOf} = {}) {
  const bars = Array.isArray(rows) && Number.isSafeInteger(asOf) ? closedBars(rows, asOf) : [];
  const {map, box} = analyzeMap(bars);
  return {map, vsa: observeVsa(bars, box, PIVOT_BARS)};
}

export function observeWyckoff(rows, options) {
  return observeScalpStructure(rows, options).map;
}
