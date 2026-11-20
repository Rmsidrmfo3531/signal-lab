import test from 'node:test';
import assert from 'node:assert/strict';
import {aiLensHigherTimeframe, aiLensRiskMap, LENS_HIGHER_INTERVAL_MS as H4} from '../scalp_ai_lens.mjs';
import {closedScalpBars, observeScalpStructure, WYCKOFF_INTERVAL_MS as I} from '../scalp_wyckoff.mjs';

function risingRows(count, interval = I) {
  return Array.from({length: count}, (_, i) => {
    const t = i * interval;
    const c = 100 + i;
    return [t, c, c + .5, c - .5, c, 100, t + interval - 1];
  });
}

test('uses 205 contiguous closed candles for the EMA200 five-bar change', () => {
  const rows = risingRows(207);
  assert.equal(observeScalpStructure(rows, {asOf: 205 * I - 1}).aiLens.status, 'INSUFFICIENT_CANDLES');
  const {aiLens: o} = observeScalpStructure(rows, {asOf: 205 * I});
  assert.equal(o.status, 'OK');
  assert.equal(o.closedCandleAt, 205 * I);
  assert.equal(o.close, 304);
  assert.equal(o.ema20, 294.5);
  assert.equal(o.ema50, 279.5);
  assert.equal(o.ema200, 204.5);
  assert.equal(o.ema200Change5, 5);
  assert.equal(o.rsi14, 100);
  assert.equal(o.adx14, 100);
  assert.equal(o.adxTrend, true);
  assert.equal(o.atr14, 1.5);
  assert.equal(o.volumeSma20, 100);
  assert.equal(o.volumeRatio, 1);
  const withGap = rows.filter((_, i) => i !== 99);
  assert.equal(observeScalpStructure(withGap, {asOf: 205 * I}).aiLens.status, 'INSUFFICIENT_CANDLES');
});

test('confirms a swing only after five right-hand candles close', () => {
  const rows = risingRows(230);
  rows[219][2] = 1000;
  rows[219][3] = 80;
  const before = observeScalpStructure(rows, {asOf: 225 * I - 1}).aiLens;
  assert.equal(before.pivots.high, null);
  assert.equal(before.pivots.low, null);
  const after = observeScalpStructure(rows, {asOf: 225 * I}).aiLens;
  assert.deepEqual(after.pivots.high, {price: 1000, at: 220 * I, confirmedAt: 225 * I});
  assert.deepEqual(after.pivots.low, {price: 80, at: 220 * I, confirmedAt: 225 * I});
  assert.equal(after.highVolatility, true);
  const later = observeScalpStructure(rows, {asOf: 230 * I}).aiLens;
  assert.ok(later.atrPercentRank100 < after.atrPercentRank100);
});

test('4H context is based on the closed 4H candle and risk references are side-specific', () => {
  const rows = risingRows(51, H4);
  assert.equal(aiLensHigherTimeframe(closedScalpBars(rows, 50 * H4 - 1, H4)), null);
  assert.deepEqual(aiLensHigherTimeframe(closedScalpBars(rows, 50 * H4, H4)), {
    timeframe: '4h', closedCandleAt: 50 * H4, close: 149, ema50: 124.5,
  });
  assert.deepEqual(aiLensRiskMap(100, 'LONG', 2), {referenceEntry: 100, stop: 97, target1: 104.5, target2: 109});
  assert.deepEqual(aiLensRiskMap(100, 'SHORT', 2), {referenceEntry: 100, stop: 103, target1: 95.5, target2: 91});
  assert.equal(aiLensRiskMap(2, 'LONG', 2), null);
  assert.equal(aiLensRiskMap(100, 'LONG', 0), null);
});
