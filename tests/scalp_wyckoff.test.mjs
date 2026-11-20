import test from 'node:test';
import assert from 'node:assert/strict';
import {observeWyckoff, observeScalpStructure, WYCKOFF_INTERVAL_MS as I} from '../scalp_wyckoff.mjs';

function candles() {
  const rows = [];
  const add = (open, high, low, close, volume = 100) => {
    const t = rows.length * I;
    rows.push([t, open, high, low, close, volume, t + I - 1]);
  };
  for (let i = 0; i < 65; i++) {
    const p = 120 - i * .3;
    add(p + .1, p + .5, p - .4, p);
  }
  add(101, 101.3, 95, 98, 650);
  add(98, 102, 97, 101);
  add(101, 104, 100, 103);
  add(103, 103.2, 100, 100.5);
  for (let i = 0; i < 20; i++) add(100.5, 101.1, 100, 100.5, 80);
  return {rows, add};
}

const observe = (rows, asOf = rows.length * I) => observeWyckoff(rows, {asOf});

test('confirms the box and leaves direction undetermined before Spring or a confirmed break', () => {
  const {rows} = candles();
  const justBeforeConfirmation = observe(rows, 80 * I);
  assert.equal(justBeforeConfirmation.phase, 'A');
  const box = observe(rows);
  assert.equal(box.status, 'CONFIRMED_RANGE');
  assert.equal(box.phase, 'B');
  assert.equal(box.stopEvent, 'SC');
  assert.equal(box.verdict, null);
  assert.equal(box.low, 95);
  assert.equal(box.high, 104);
  assert.equal(box.confirmedAt, 88 * I);
});

test('requires three closed breakout bars and rejects the return inside', () => {
  const {rows, add} = candles();
  const breakoutAt = (rows.length + 1) * I;
  add(103, 105.4, 102.5, 104.2, 800);
  add(104.2, 104.7, 104.1, 104.3);
  assert.equal(observe(rows).phase, 'B');
  add(104.3, 104.8, 104.1, 104.4);
  assert.equal(observe(rows, rows.length * I - 1).phase, 'B');
  const confirmed = observe(rows);
  assert.equal(confirmed.phase, 'D');
  assert.equal(confirmed.lastEvent, 'SOS');
  assert.equal(confirmed.eventAt, breakoutAt);
  assert.equal(confirmed.eventConfirmedAt, breakoutAt + 2 * I);

  rows.pop();
  add(104.3, 104.4, 103, 103.4);
  const failure = observe(rows);
  assert.equal(failure.phase, 'B');
  assert.equal(failure.lastEvent, 'UT_CANDIDATE');
  assert.equal(failure.verdict, null);
  assert.equal(failure.eventConfirmedAt, breakoutAt + 2 * I);
});

test('mirrors price structure for the short side and treats a gap as unavailable context', () => {
  const {rows, add} = candles();
  add(100.5, 101, 94.8, 98);
  const spring = observe(rows);
  assert.equal(spring.phase, 'C');
  assert.equal(spring.lastEvent, 'SPRING');
  assert.equal(spring.verdict, 'LONG');
  const mirror = rows.map(([t, o, h, l, c, v, end]) => [t, 200 - o, 200 - l, 200 - h, 200 - c, v, end]);
  const upthrust = observe(mirror);
  assert.equal(upthrust.stopEvent, 'BC');
  assert.equal(upthrust.lastEvent, 'UTAD');
  assert.equal(upthrust.verdict, 'SHORT');
  assert.equal(observe(rows.slice(0, -1), rows.length * I).status, 'INSUFFICIENT_CANDLES');
  assert.equal(observe(rows.filter((_, i) => i !== 70), rows.length * I).status, 'INSUFFICIENT_CANDLES');
});

test('VSA marks the relaxed retest of the Map box on closed candles only', () => {
  const {rows, add} = candles();
  add(100, 101, 98, 99.8, 20);
  for (let i = 0; i < 3; i++) add(100.5, 101.1, 100, 100.5, 80);
  const before = observeScalpStructure(rows, {asOf: rows.length * I - 1});
  assert.equal(before.vsa.status, 'WAITING_FOR_ST');
  const {map, vsa} = observeScalpStructure(rows, {asOf: rows.length * I});
  assert.equal(vsa.status, 'ST_CONFIRMED');
  assert.equal(vsa.st.type, 'RELAXED');
  assert.equal(vsa.st.confirmedAt, rows.length * I);
  assert.equal(vsa.boxLow, map.low);
  assert.equal(vsa.boxHigh, map.high);
});
