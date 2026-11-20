import {validateKlineSeries} from './engine.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PIVOT = 2;
const LOOKBACK = 20;
export const WYCKOFF_MODEL = 'WYCKOFF_OBSERVATION_V1';

function wilder(values, period) {
  let value = 0;
  return values.map((current, index) => {
    if (index < period) {
      value += current / period;
      return index === period - 1 ? value : null;
    }
    value += (current - value) / period;
    return value;
  });
}

function inputs(candles) {
  const volumes = candles.map(bar => bar.volume);
  const spreads = candles.map(bar => bar.high - bar.low);
  const trueRanges = candles.map((bar, index) => {
    const previous = candles[index - 1]?.close ?? bar.close;
    return Math.max(spreads[index], Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  });
  const volumeAverage = wilder(volumes, LOOKBACK);
  const atr = wilder(trueRanges, 14);
  return {volumes, spreads, volumeAverage, atr};
}

function priorStop(candles, metrics, index) {
  const bar = candles[index];
  const history = candles.slice(index - LOOKBACK, index);
  const future = candles.slice(index + 1, index + PIVOT + 1);
  const atr = metrics.atr[index - 1];
  const average = metrics.volumeAverage[index - 1];
  if (!(atr > 0 && average > 0) || metrics.volumes[index] < 1.15 * average) return null;
  const spread = metrics.spreads[index];
  const from = history[0].close;
  const low = [...history, ...future].every(other => bar.low <= other.low) && from - bar.close >= 2 * atr;
  const high = [...history, ...future].every(other => bar.high >= other.high) && bar.close - from >= 2 * atr;
  if (spread < 0.8 * atr || (!low && !high)) return null;
  const climax = bar.volume >= 1.8 * average && spread >= 1.25 * atr;
  return {side: low ? 'LOW' : 'HIGH', climax, bar, index, atr, spread, strength: bar.volume / average * spread / atr};
}

function event(label, bar, confirmedBar = bar) {
  return {label, at: bar.closeTime, confirmedAt: confirmedBar.closeTime};
}

function findRanges(candles, holdBars) {
  const metrics = inputs(candles);
  let box = null;
  let latest = null;
  for (let index = LOOKBACK + PIVOT; index < candles.length; index++) {
    const bar = candles[index];
    const pivot = index - PIVOT;
    if (!box || box.status === 'CANDIDATE') {
      const stop = priorStop(candles, metrics, pivot);
      if (stop && (!box || stop.strength > box.stop.strength)) {
        const label = stop.side === 'LOW' ? (stop.climax ? 'SC' : 'PS') : (stop.climax ? 'BC' : 'PSY');
        box = {stop, status:'CANDIDATE', phase:'A', verdict:'UNDETERMINED', events:[event(label, stop.bar, bar)],
          lower:null, upper:null, direction:null, breakout:null, failedVerdict:null, pending:null};
      }
      if (!box) continue;
      const {stop: anchor} = box;
      const lowerStop = anchor.side === 'LOW';
      const edge = lowerStop ? anchor.bar.low : anchor.bar.high;
      if (index - anchor.index > 24 || (lowerStop ? bar.close < edge - anchor.atr * 0.25 : bar.close > edge + anchor.atr * 0.25)) {
        box = null;
        continue;
      }
      const swing = candles[pivot];
      const neighbors = candles.slice(pivot - PIVOT, index + 1);
      if (box.lower === null && pivot > anchor.index) {
        const ar = lowerStop ? swing.high : swing.low;
        const distance = lowerStop ? ar - edge : edge - ar;
        const isReaction = distance >= 1.5 * anchor.atr &&
          neighbors.every(other => lowerStop ? other.high <= ar : other.low >= ar);
        if (isReaction) {
          box.lower = lowerStop ? edge : ar;
          box.upper = lowerStop ? ar : edge;
          box.arIndex = pivot;
          box.events.push(event('AR', swing, bar));
        }
      }
      if (box.lower === null) continue;
      const buffer = anchor.atr * 0.25;
      if (bar.close > box.upper + buffer || bar.close < box.lower - buffer) {
        box = null;
        continue;
      }
      const testPosition = lowerStop ? swing.low : swing.high;
      const isTest = pivot > box.arIndex && Math.abs(testPosition - edge) <= anchor.atr * 0.6 &&
        neighbors.every(other => lowerStop ? other.low >= testPosition : other.high <= testPosition) &&
        swing.volume < anchor.bar.volume && metrics.spreads[pivot] < anchor.spread;
      if (isTest && !box.test) box.test = event('ST', swing, bar);
      const sinceAr = candles.slice(box.arIndex + 1, index + 1);
      const inside = sinceAr.filter(c => c.close >= box.lower && c.close <= box.upper).length;
      if (sinceAr.length >= 5 && inside / sinceAr.length >= 0.7 && (box.test || sinceAr.length >= 10)) {
        if (box.test) box.events.push(box.test);
        box.status = 'ACTIVE';
        box.phase = 'B';
        box.confirmedAt = bar.closeTime;
        box.exitCount = 0;
        box.exitSide = null;
      }
      continue;
    }

    const {lower, upper, stop} = box;
    const buffer = 0.25 * stop.atr;
    const side = bar.close > upper ? 'UP' : bar.close < lower ? 'DOWN' : null;
    const beyond = bar.close > upper + buffer ? 'UP' : bar.close < lower - buffer ? 'DOWN' : null;
    box.exitCount = beyond ? (beyond === box.exitSide ? box.exitCount + 1 : 1) : 0;
    box.exitSide = beyond;
    const outsized = bar.close >= upper + (upper - lower) || bar.close <= lower - (upper - lower);

    const failedBreak = box.pending && side !== box.pending.side;
    if (failedBreak) {
      const failed = box.pending;
      box.events.push(event(failed.side === 'UP' ? 'UT?' : 'Spring?', failed.bar, bar));
      box.pending = null;
    }
    if (!box.breakout && beyond && !box.pending) box.pending = {side:beyond, bar, index};
    if (!box.breakout && box.pending && index - box.pending.index + 1 >= holdBars) {
      const {side: direction, bar: first} = box.pending;
      box.breakout = event(direction === 'UP' ? 'SOS' : 'SOW', first, bar);
      box.direction = direction;
      box.phase = 'D';
      box.events.push(box.breakout);
      if (box.verdict === 'UNDETERMINED') box.verdict = verdictFor(stop.side, direction);
      box.pending = null;
    }
    if (!box.breakout && !side && !failedBreak) {
      const spring = bar.low < lower - buffer;
      const upthrust = bar.high > upper + buffer;
      if (spring !== upthrust && box.phase === 'B') {
        box.phase = 'C';
        box.verdict = verdictFor(stop.side, spring ? 'UP' : 'DOWN');
        box.events.push(event(spring ? 'Spring' : 'UTAD', bar));
      }
    }
    if (box.exitCount >= 4 || outsized) {
      const verdict = verdictFor(stop.side, side);
      if (box.verdict !== 'UNDETERMINED' && verdict !== box.verdict) box.failedVerdict = box.verdict;
      box.pending = null;
      box.verdict = verdict;
      box.exitDirection = side;
      box.status = 'CLOSED';
      box.phase = 'E';
      box.events.push(event('E', bar));
      latest = box;
      box = null;
    }
  }
  return box?.status === 'ACTIVE' ? box : latest ?? box;
}

function verdictFor(stopSide, direction) {
  if (direction === 'UP') return stopSide === 'LOW' ? 'ACCUMULATION' : 'RE_ACCUMULATION';
  return stopSide === 'HIGH' ? 'DISTRIBUTION' : 'RE_DISTRIBUTION';
}

function retest(box, candles) {
  if (!box.breakout) return {status:box.exitDirection ? 'EXIT_WITHOUT_D' : 'WAIT_BREAKOUT'};
  if (box.exitDirection && box.exitDirection !== box.direction) return {status:'INVALIDATED'};
  const {confirmedAt} = box.breakout;
  if (!candles.length || candles[0].time > confirmedAt + 1) return {status:'INSUFFICIENT_HISTORY'};
  const up = box.direction === 'UP';
  const level = up ? box.upper : box.lower;
  const tolerance = 0.25 * box.stop.atr;
  let result = {status:'WAIT_RETEST', level};
  for (const bar of candles) {
    if (bar.time <= confirmedAt) continue;
    if (up ? bar.close < level - tolerance : bar.close > level + tolerance) return {status:'INVALIDATED', level, at:bar.closeTime};
    if (bar.low <= level + tolerance && bar.high >= level - tolerance && (up ? bar.close > level : bar.close < level)) {
      result = {status:'CONFIRMED', level, at:bar.closeTime};
    }
  }
  return result;
}

function publicBox(box, candles) {
  if (!box) return {status:'NONE'};
  return {status:box.status, lower:box.lower, upper:box.upper, phase:box.phase, verdict:box.verdict,
    failedVerdict:box.failedVerdict, confirmedAt:box.confirmedAt ?? null, breakout:box.breakout,
    direction:box.exitDirection ?? box.direction, pendingDirection:box.pending?.side ?? null,
    retest:retest(box, candles), events:box.events.slice(-12)};
}

const volumeBands = [0.55, 0.8, 1.2, 1.6, 2.2, 3];
function volumeReading(candles) {
  if (candles.length < 21) return {status:'INSUFFICIENT_HISTORY'};
  const {volumes, volumeAverage, atr} = inputs(candles);
  const bar = candles.at(-1);
  const average = volumeAverage.at(-1);
  const ratio = average > 0 ? bar.volume / average : null;
  if (ratio === null) return {status:'INSUFFICIENT_VOLUME'};
  const long = wilder(volumes, 50).at(-1);
  const dryUpRatio = long > 0 ? wilder(volumes, 5).at(-1) / long : null;
  const closePosition = bar => bar.high === bar.low ? 0.5 : (bar.close - bar.low) / (bar.high - bar.low);
  let latestEvent = null;
  for (let index = LOOKBACK; index < candles.length - 1; index++) {
    const candidate = candles[index];
    const confirm = candles[index + 1];
    const prior = candles.slice(index - LOOKBACK, index);
    const low = Math.min(...prior.map(b => b.low));
    const high = Math.max(...prior.map(b => b.high));
    const strength = atr[index - 1];
    if (!(strength > 0 && volumeAverage[index - 1] > 0 && high > low)) continue;
    const priorMove = prior.at(-1).close - prior[0].close;
    const spread = candidate.high - candidate.low;
    const nearLow = candidate.low <= low + 0.3 * (high - low);
    if (priorMove <= -2 * strength && nearLow && candidate.volume >= 1.8 * volumeAverage[index - 1] &&
        spread >= 1.25 * strength && closePosition(candidate) >= 0.4 && confirm.close > candidate.close) {
      latestEvent = event('SV', candidate, confirm);
    }
    if (priorMove >= 2 * strength && candidate.high > high && candidate.close < high &&
        candidate.close >= low + 0.65 * (high - low) && closePosition(candidate) <= 0.45 && confirm.close < candidate.close) {
      latestEvent = event('UT', candidate, confirm);
    }
  }
  return {status:'OK', at:bar.closeTime, ratio, band:1 + volumeBands.filter(threshold => ratio >= threshold).length,
    dryUpRatio, dryUp:dryUpRatio === null ? null : dryUpRatio < 0.7,
    estimatedBuyPct:bar.volume > 0 ? 100 * closePosition(bar) : null, latestEvent};
}

export function wyckoffObservation({daily, fourHour, now = Date.now()}) {
  const day = validateKlineSeries(daily, DAY, now);
  const h4 = validateKlineSeries(fourHour, 4 * HOUR, now);
  const dayFresh = day.valid && day.candles.at(-1)?.time === Math.floor(now / DAY) * DAY - DAY;
  const h4Fresh = h4.valid && h4.candles.at(-1)?.time === Math.floor(now / (4 * HOUR)) * 4 * HOUR - 4 * HOUR;
  const h4Bars = h4Fresh ? h4.candles : [];
  const ready = dayFresh && day.candles.length >= LOOKBACK + PIVOT + 1;
  const unavailable = {status:dayFresh ? 'INSUFFICIENT_HISTORY' : 'DATA_UNAVAILABLE'};
  return {model:WYCKOFF_MODEL, asOf:now, dailyAt:dayFresh ? day.candles.at(-1).closeTime : null,
    fourHourAt:h4Fresh ? h4Bars.at(-1).closeTime : null,
    range:ready ? publicBox(findRanges(day.candles, 1), h4Bars) : unavailable,
    structureMap:ready ? publicBox(findRanges(day.candles, 3), h4Bars) : unavailable,
    vsa:h4Fresh ? volumeReading(h4Bars) : {status:'DATA_UNAVAILABLE'}};
}
