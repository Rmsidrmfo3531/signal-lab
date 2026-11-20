import test from 'node:test';
import assert from 'node:assert/strict';
import {observeVsa} from '../scalp_vsa.mjs';

const I = 900_000;
const fixtures = (direction = 1) => {
  const bars = Array.from({length: 80}, (_, i) => ({
    at: (i + 1) * I, high: 108, low: 102 + (i % 2) * .1, close: 105, volume: 100, atr: 1,
  }));
  const box = {low: 100, high: 110, direction, startIndex: 50, arIndex: 54, arConfirmedIndex: 56};
  bars[50].volume = 1000;
  for (const b of bars.slice(51)) b.low = 105;
  for (const b of bars.slice(51)) b.high = 105.5;
  return {bars, box};
};
const observe = (bars, box) => observeVsa(bars, box, 3);

test('VSA default uses 50 volumes including the candle being evaluated', () => {
  const {bars} = fixtures();
  const flat = bars.slice(0, 50);
  assert.equal(observe(flat.slice(1), null).status, 'INSUFFICIENT_CANDLES');
  assert.equal(observe(flat, null).volumeZ, 0);

  flat[49] = {...flat[49], volume: 10_000};
  const last = observe(flat, null);
  assert.ok(Math.abs(last.volumeZ - 7) < 1e-12);
  assert.equal(last.climaxVolume, true);
  assert.equal(last.expansionVolume, true);

  for (const bar of flat.slice(35)) bar.volume = 200;
  const expansion = observe(flat, null);
  assert.equal(expansion.climaxVolume, false);
  assert.equal(expansion.expansionVolume, true);
});

test('relaxed ST waits for three right-side candles and mirrors the upper 40% for distribution', () => {
  for (const direction of [1, -1]) {
    const {bars, box} = fixtures(direction);
    Object.assign(bars[60], direction === 1 ? {low: 103.9, volume: 25} : {high: 106.1, volume: 25});
    assert.equal(observe(bars.slice(0, 63), box).status, 'WAITING_FOR_ST');
    const confirmed = observe(bars.slice(0, 64), box);
    assert.equal(confirmed.status, 'ST_CONFIRMED');
    assert.equal(confirmed.st.type, 'RELAXED');
    assert.equal(confirmed.st.at, bars[60].at);
    assert.equal(confirmed.st.confirmedAt, bars[63].at);
  }
});

test('strict ST can precede a relaxed pivot, and breakout waits for three 1 ATR closes after the minimum range age', () => {
  const {bars, box} = fixtures();
  Object.assign(bars[55], {low: 100.8, volume: 25});
  assert.equal(observe(bars.slice(0, 57), box).st.type, 'STRICT');
  assert.equal(observe(bars.slice(0, 57), box).st.confirmedAt, bars[56].at);

  for (const i of [64, 65, 66, 70, 71, 72, 73, 74]) {
    Object.assign(bars[i], {high: 111.4, close: i === 71 ? 110.9 : 111.2});
  }
  assert.equal(observe(bars.slice(0, 73), box).breakout, null);
  const result = observe(bars.slice(0, 75), box);
  assert.equal(result.status, 'BREAKOUT_CONFIRMED');
  assert.deepEqual(result.breakout, {direction: 'LONG', at: bars[72].at, confirmedAt: bars[74].at});
});

test('a Map stop below the VSA climax threshold does not confirm a VSA ST', () => {
  const {bars, box} = fixtures();
  bars[50].volume = 100;
  Object.assign(bars[55], {low: 100.8, volume: 25});
  const result = observe(bars, box);
  assert.equal(result.status, 'MAP_STOP_BELOW_VSA_CLIMAX');
  assert.equal(result.stopVolumeZ, 0);
});
