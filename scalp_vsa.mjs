// Observations from the supplied VSA 6.2 settings, using the Map stop and AR boundaries.
const VOLUME_WINDOW = 50;
const CLIMAX_Z = 2.5;
const EXPANSION_Z = 1;
const RELAXED_BAND = .4;
const EXIT_CLOSES = 3;
const PHASE_MIN_BARS = 15;
const RANGE_MAX_BARS = 1000;

export function vsaStatus(status) {
  return {version: 1, model: 'VSA_6_2_MAP_CONTEXT', timeframe: '15m', status};
}

function volumeZ(bars, index) {
  if (index + 1 < VOLUME_WINDOW) return null;
  let mean = 0;
  let varianceSum = 0;
  // Population standard deviation, including the candle being scored.
  for (let i = index + 1 - VOLUME_WINDOW, count = 1; i <= index; i++, count++) {
    const delta = bars[i].volume - mean;
    mean += delta / count;
    varianceSum += delta * (bars[i].volume - mean);
  }
  const deviation = Math.sqrt(Math.max(0, varianceSum / VOLUME_WINDOW));
  return deviation > 0 ? (bars[index].volume - mean) / deviation : 0;
}

function secondaryTest(bars, box, end, pivotBars) {
  const {low, high, arIndex, arConfirmedIndex, direction} = box;
  const height = high - low;
  const start = direction === 1 ? low : -high;
  const near = bar => direction === 1 ? bar.low : -bar.high;
  const inside = bar => bar.close >= low && bar.close <= high;
  const record = (type, pivot, confirmedIndex, z) => ({type, at: bars[pivot].at, confirmedAt: bars[confirmedIndex].at, volumeZ: z});
  // Low-volume formula is private. Compare against the documented 50-bar mean.
  function testVolume(index) {
    const value = volumeZ(bars, index);
    return value !== null && value < 0 ? value : null;
  }

  for (let i = arIndex + 1; i <= end; i++) {
    const bar = bars[i];
    if (bar.atr > 0 && inside(bar) && Math.abs(near(bar) - start) <= bar.atr) {
      const z = testVolume(i);
      if (z !== null) return record('STRICT', i, Math.max(i, arConfirmedIndex), z);
    }
    const pivot = i - pivotBars;
    if (pivot <= arIndex || pivot < pivotBars) continue;
    const b = bars[pivot];
    const level = near(b);
    if (!inside(b) || level < start || level > start + RELAXED_BAND * height) continue;
    const neighborhood = bars.slice(pivot - pivotBars, i + 1);
    const isPivot = neighborhood.every(other =>
      other === b || (other.at < b.at ? near(other) > level : near(other) >= level));
    if (!isPivot) continue;
    const z = testVolume(pivot);
    if (z !== null) return record('RELAXED', pivot, Math.max(i, arConfirmedIndex), z);
  }
  return null;
}

function confirmedBreak(bars, box, end, after) {
  let side = null;
  let consecutive = 0;
  for (let i = Math.max(box.arIndex + PHASE_MIN_BARS, box.arConfirmedIndex); i <= end; i++) {
    const bar = bars[i];
    if (bar.at < after) continue;
    const next = bar.atr <= 0 ? null
      : bar.close >= box.high + bar.atr ? 'LONG'
      : bar.close <= box.low - bar.atr ? 'SHORT' : null;
    consecutive = !next ? 0 : next === side ? consecutive + 1 : 1;
    side = next;
    if (consecutive === EXIT_CLOSES) {
      return {direction: side, at: bars[i - EXIT_CLOSES + 1].at, confirmedAt: bar.at};
    }
  }
  return null;
}

export function observeVsa(bars, box, pivotBars) {
  const lastIndex = bars.length - 1;
  const z = volumeZ(bars, lastIndex);
  if (z === null) return vsaStatus('INSUFFICIENT_CANDLES');
  const observation = {
    ...vsaStatus('NO_MAP_BOX'), closedCandleAt: bars[lastIndex].at, volumeZ: z,
    climaxVolume: z >= CLIMAX_Z, expansionVolume: z >= EXPANSION_Z,
  };
  if (!box) return observation;

  const context = {
    ...observation, boxLow: box.low, boxHigh: box.high, arAt: bars[box.arIndex].at,
    arConfirmedAt: bars[box.arConfirmedIndex].at, stopAt: bars[box.startIndex].at,
    stopVolumeZ: volumeZ(bars, box.startIndex),
  };
  if (context.stopVolumeZ === null) return {...context, status: 'INSUFFICIENT_STOP_CANDLES'};
  if (context.stopVolumeZ < CLIMAX_Z) return {...context, status: 'MAP_STOP_BELOW_VSA_CLIMAX'};

  const end = Math.min(lastIndex, box.startIndex + RANGE_MAX_BARS);
  const st = secondaryTest(bars, box, end, pivotBars);
  const breakout = st ? confirmedBreak(bars, box, end, st.confirmedAt) : null;
  const status = breakout ? 'BREAKOUT_CONFIRMED'
    : lastIndex > end ? 'RANGE_EXPIRED'
    : st ? 'ST_CONFIRMED' : 'WAITING_FOR_ST';
  return {...context, status, st, breakout};
}
