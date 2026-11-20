import assert from 'node:assert/strict';
import test from 'node:test';
import {sandbox} from './helpers/pipeline_sandbox.mjs';
import {fetchLocal} from './helpers/http_request.mjs';
import {wyckoffObservation} from '../wyckoff_observation.mjs';

const H4 = 14_400_000;
const DAY = 6 * H4;
const START = Date.UTC(2026, 0, 1);
const off = (index, unit = DAY) => START + index * unit;
function makeBar(time, period, close, high = close + 1, low = close - 1, volume = 100, open = close) {
  return [time, open, high, low, close, volume, time + period - 1, 1000];
}
function dailyRange({mirror = false} = {}) {
  const history = Array.from({length:25}, (_, i) => [125 - i, 126 - i, 124 - i]);
  const range = [[99, 102, 93, 400], [101, 103, 97], [103, 105, 100], [106, 109, 102],
    [104, 106, 100], [101, 104, 97], [97, 99, 94], [100, 101, 96], [103, 105, 99], [104, 106, 103]];
  return [...history, ...range].map(([c, h, l, v], i) => makeBar(off(i), DAY,
    mirror ? 210 - c : c, mirror ? 210 - l : h, mirror ? 210 - h : l, v));
}
function simulate(closes, {mirror = false, h4Override, nowOffset = 0} = {}) {
  const daily = dailyRange({mirror});
  daily.push(...closes.map((c, i) => makeBar(off(daily.length + i), DAY, mirror ? 210 - c : c)));
  const count = daily.length * 6;
  const fourHour = Array.from({length:count}, (_, i) => makeBar(off(i, H4), H4, mirror ? 98 : 112));
  if (h4Override) fourHour.push(...h4Override.map(([close, hi, lo], i) => makeBar(off(count + i, H4), H4, close, hi, lo)));
  const now = off(daily.length) + (h4Override?.length ?? 0) * H4 + nowOffset;
  return {daily, fourHour, now};
}

test('Wyckoff Range and Structure Map share a confirmed box, while D uses different confirmation delays', () => {
  const input = simulate([112]);
  // Feed contains an open next daily candle with an extreme price.
  input.daily.push(makeBar(input.now, DAY, 200));
  const result = wyckoffObservation(input);
  assert.deepEqual([result.range.lower, result.range.upper], [93, 109]);
  assert.equal(result.range.phase, 'D');
  assert.equal(result.structureMap.phase, 'B');
  assert.equal(result.structureMap.pendingDirection, 'UP');
  assert.equal(result.structureMap.breakout, null);
  assert.equal(result.structureMap.events.at(-1).label, 'ST');
});

test('failed break stays out of D; the next accepted break records its occurrence and confirmation separately', () => {
  const failed = wyckoffObservation(simulate([112, 105]));
  assert.equal(failed.structureMap.phase, 'B');
  assert.equal(failed.structureMap.events.at(-1).label, 'UT?');
  const accepted = wyckoffObservation(simulate([112, 105, 112, 113, 114]));
  assert.equal(accepted.structureMap.breakout.label, 'SOS');
  assert.equal(accepted.structureMap.breakout.confirmedAt - accepted.structureMap.breakout.at, 2 * DAY);
  assert.equal(accepted.structureMap.retest.status, 'WAIT_RETEST');
});

test('retests use the same daily boundary and only 4H candles starting after daily confirmation', () => {
  const before = simulate([112, 113, 114]);
  before.fourHour[before.fourHour.length - 1] = makeBar(before.now - H4, H4, 111, 112, 109);
  assert.equal(wyckoffObservation(before).structureMap.retest.status, 'WAIT_RETEST');
  const up = wyckoffObservation(simulate([112, 113, 114], {h4Override:[[111, 112, 109]]}));
  assert.deepEqual([up.structureMap.retest.status, up.structureMap.retest.level], ['CONFIRMED', 109]);
  const down = wyckoffObservation(simulate([112, 113, 114], {mirror:true,h4Override:[[99,101,98]]}));
  assert.deepEqual([down.structureMap.direction, down.structureMap.retest.status, down.structureMap.retest.level], ['DOWN','CONFIRMED',101]);
  const expired = wyckoffObservation(simulate([112, 113, 114], {h4Override:[[111,112,109],[106,110,105]]}));
  assert.equal(expired.structureMap.retest.status, 'INVALIDATED');
});

test('a one-range-height move records the separate E exit rule while D is pending', () => {
  const {structureMap} = wyckoffObservation(simulate([126]));
  assert.equal(structureMap.phase, 'E');
  assert.equal(structureMap.direction, 'UP');
  assert.equal(structureMap.breakout, null);
  assert.equal(structureMap.retest.status, 'EXIT_WITHOUT_D');
});

test('VSA waits for the next closed bar and reports stale/gapped series separately', () => {
  const {daily, fourHour, now} = simulate([112, 113, 114]);
  for (let i = fourHour.length - 26; i < fourHour.length; i++) {
    const c = 135 - (i - (fourHour.length - 26));
    fourHour[i] = makeBar(fourHour[i][0], H4, c);
  }
  fourHour[fourHour.length - 2] = makeBar(now - 2 * H4, H4, 111, 113, 107, 400);
  fourHour[fourHour.length - 1] = makeBar(now - H4, H4, 113, 115, 110);
  const first = wyckoffObservation({daily, fourHour, now:now - H4});
  assert.equal(first.vsa.latestEvent, null);
  const second = wyckoffObservation({daily, fourHour, now});
  assert.equal(second.vsa.latestEvent.label, 'SV');
  assert.equal(second.vsa.latestEvent.confirmedAt - second.vsa.latestEvent.at, H4);
  assert.equal(second.vsa.estimatedBuyPct, 60);
  assert.equal(wyckoffObservation({daily, fourHour:fourHour.slice(0, -1), now}).vsa.status, 'DATA_UNAVAILABLE');
  assert.equal(wyckoffObservation({daily, fourHour:fourHour.filter((_, i) => i !== 21), now}).vsa.status, 'DATA_UNAVAILABLE');
});


test('the testnet screen serves a three-reading, GET-only observation for a supported symbol', {timeout:20000}, async () => {
  const sample = simulate([112, 113, 114]);
  const now = Date.now();
  const align = (rows, period) => {
    const lastClosed = Math.floor(now / period) * period - period;
    const shift = lastClosed - rows.at(-1)[0];
    return rows.map(row => [row[0] + shift, ...row.slice(1, 6), row[6] + shift, row[7]]);
  };
  const app = await sandbox({scenarios:{BTCUSDT:'range'}, env:{PAPER_TRADING:'off', LIVE_TRADING_MODE:'TESTNET'},
    observationKlines:{BTCUSDT:{'1d':align(sample.daily, DAY), '4h':align(sample.fourHour, H4)}}});
  try {
    await app.start();
    assert.equal((await app.get('/api/status')).live.mode, 'TESTNET');
    const response = await fetchLocal(app.base);
    assert.match(await response.text(), /id="wyckoffResearch"/);
    const script = await fetchLocal(app.base + '/wyckoff.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /Wyckoff Structure Map v3\.3/);
    const observation = await app.get('/api/wyckoff?symbol=btcusdt');
    assert.equal(observation.symbol, 'BTCUSDT');
    assert.deepEqual([observation.range.lower, observation.range.upper], [93, 109]);
    assert.equal(observation.structureMap.breakout.label, 'SOS');
    assert.equal(observation.vsa.status, 'OK');
    assert.equal((await fetchLocal(app.base + '/api/wyckoff?symbol=DOESNOTEXIST')).status, 404);
    assert.equal((await fetchLocal(app.base + '/api/wyckoff', {method:'POST'})).status, 405);
    assert.equal((await app.get('/api/status')).live.armed, false);
  } finally {
    await app.close();
  }
});
