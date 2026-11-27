import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CVD_SR_TIMEFRAMES,
  computeCvdSrZones,
  fetchSymbolCvdSr,
  scanCvdSrMatrix,
  clearCvdSrCache,
  CvdSrAlertMonitor,
  formatCvdSrChangeMessage,
} from '../cvd_sr.mjs';
import { orderflowCvdSrMatrixHTML, orderflowHTML } from '../public/orderflow_ui.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signal-lab-cvd-sr-'));

/** Build synthetic candle series with concentrated CVD buying at supportPx and selling at resistPx. */
function makeSeries({
  count = 96,
  base = 100,
  supportPx = 94,
  resistPx = 106,
  strongSupport = true,
  strongResist = true,
} = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const t = 1795000000000 + i * 60_000;
    if (strongSupport && i % 8 === 1) {
      // Heavy buyer absorption cluster around supportPx
      rows.push({ t, o: supportPx - 0.3, h: supportPx + 0.4, l: supportPx - 0.4, c: supportPx + 0.2, v: 5000, q: 500000, buyVol: 440000, sellVol: 60000 });
    } else if (strongResist && i % 8 === 4) {
      // Heavy seller distribution cluster around resistPx
      rows.push({ t, o: resistPx + 0.3, h: resistPx + 0.4, l: resistPx - 0.4, c: resistPx - 0.2, v: 5000, q: 500000, buyVol: 60000, sellVol: 440000 });
    } else {
      // Balanced mid-range chop around base
      const p = base + Math.sin(i * 0.4) * 3.5;
      rows.push({ t, o: p - 0.5, h: p + 0.8, l: p - 0.8, c: p + 0.5, v: 300, q: 30000, buyVol: 15200, sellVol: 14800 });
    }
  }
  return rows;
}

test('computeCvdSrZones detects strong CVD support below markPrice and strong resistance above markPrice', () => {
  const series = makeSeries({ count: 96, base: 100, supportPx: 94, resistPx: 106 });
  const res = computeCvdSrZones(series, 100, { maxDistPct: 25 });

  assert.ok(res.strongSupports.length >= 1, 'should detect at least one STRONG CVD support');
  assert.ok(res.strongResistances.length >= 1, 'should detect at least one STRONG CVD resistance');
  assert.ok(Math.abs(res.bestSupport.centerPrice - 94) <= 1.0, `support near 94, got ${res.bestSupport.centerPrice}`);
  assert.ok(Math.abs(res.bestResistance.centerPrice - 106) <= 1.0, `resistance near 106, got ${res.bestResistance.centerPrice}`);
  assert.equal(res.bestSupport.grade, 'STRONG');
  assert.equal(res.bestResistance.grade, 'STRONG');
  assert.ok(res.bestSupport.distPct < 0);
  assert.ok(res.bestResistance.distPct > 0);
  assert.ok(res.bestSupport.netDeltaUsd > 0);
  assert.ok(res.bestResistance.netDeltaUsd < 0);
});

test('fetchSymbolCvdSr derives all 6 timeframes from 3 kline calls and scanCvdSrMatrix pins held symbols first', async () => {
  clearCvdSrCache();
  const calls = [];
  const fetchSeries = async (sym, { interval, limit }) => {
    calls.push(`${sym}|${interval}|${limit}`);
    const count = interval === '15m' ? 96 : interval === '4h' ? 180 : 365;
    const base = sym === 'BTCUSDT' ? 95000 : 3000;
    return {
      symbol: sym,
      source: 'BINANCE',
      markPrice: base,
      series: makeSeries({ count, base, supportPx: base * 0.94, resistPx: base * 1.06 }),
    };
  };

  const btc = await fetchSymbolCvdSr('BTCUSDT', { fetchSeries, force: true });
  assert.equal(calls.length, 3, 'must fetch only 3 kline series (15m, 4h, 1d) for all 6 timeframes');
  for (const tf of CVD_SR_TIMEFRAMES) {
    assert.ok(btc.timeframes[tf.key], `missing timeframe ${tf.key}`);
    assert.equal(btc.timeframes[tf.key].bestSupport?.grade, 'STRONG');
    assert.equal(btc.timeframes[tf.key].bestResistance?.grade, 'STRONG');
  }

  const matrix = await scanCvdSrMatrix(['BTCUSDT', 'ETHUSDT'], {
    heldPositions: [{ symbol: 'ETHUSDT', direction: 'LONG' }],
    fetchSeries,
  });
  assert.equal(matrix.ok, true);
  assert.equal(matrix.rows.length, 2);
  assert.equal(matrix.rows[0].symbol, 'ETHUSDT', 'held position must be pinned first');
  assert.equal(matrix.rows[0].held, true);
  assert.deepEqual(matrix.rows[0].directions, ['LONG']);
  assert.equal(matrix.rows[1].symbol, 'BTCUSDT');
  assert.equal(matrix.rows[1].held, false);
});

test('CvdSrAlertMonitor records baseline silently, alerts on both REMOVED and ADDED strong zones, honors hysteresis/cooldown, and avoids code blocks', async () => {
  const dir = tmp();
  try {
    let now = 1795000000000;
    const sent = [];
    const monitor = new CvdSrAlertMonitor({
      directory: dir,
      now: () => now,
      sendText: async t => { sent.push(t); return { ok: true }; },
    });

    const snap = ({ mark = 100, strongSupport = true, strongResist = true, supportStrength = 82, resistStrength = 80, supportPrice = 94, resistPrice = 106 } = {}) => ({
      symbol: 'BTCUSDT',
      markPrice: mark,
      timeframes: {
        LIVE: { supports: [], resistances: [], strongSupports: [], strongResistances: [] },
        '1D': {
          supports: strongSupport ? [{ kind: 'SUPPORT', centerPrice: supportPrice, low: supportPrice - 0.5, high: supportPrice + 0.5, distPct: -6, netDeltaUsd: 2500000, strength: supportStrength, grade: supportStrength >= 70 ? 'STRONG' : 'MEDIUM' }] : [],
          resistances: strongResist ? [{ kind: 'RESISTANCE', centerPrice: resistPrice, low: resistPrice - 0.5, high: resistPrice + 0.5, distPct: 6, netDeltaUsd: -2200000, strength: resistStrength, grade: resistStrength >= 70 ? 'STRONG' : 'MEDIUM' }] : [],
          strongSupports: strongSupport && supportStrength >= 70 ? [{ kind: 'SUPPORT', centerPrice: supportPrice, low: supportPrice - 0.5, high: supportPrice + 0.5, distPct: -6, netDeltaUsd: 2500000, strength: supportStrength, grade: 'STRONG' }] : [],
          strongResistances: strongResist && resistStrength >= 70 ? [{ kind: 'RESISTANCE', centerPrice: resistPrice, low: resistPrice - 0.5, high: resistPrice + 0.5, distPct: 6, netDeltaUsd: -2200000, strength: resistStrength, grade: 'STRONG' }] : [],
        },
        '1W': { supports: [], resistances: [], strongSupports: [], strongResistances: [] },
        '1M': { supports: [], resistances: [], strongSupports: [], strongResistances: [] },
        '6M': { supports: [], resistances: [], strongSupports: [], strongResistances: [] },
        '1Y': { supports: [], resistances: [], strongSupports: [], strongResistances: [] },
      },
    });

    // 1. Baseline scan: records without sending spam
    const r0 = await monitor.evaluateSymbol(snap(), { directions: ['LONG'], now });
    assert.equal(r0.baseline, true);
    assert.equal(sent.length, 0);

    // 2. Hysteresis check: support dips from 82 -> 62 (>= 58 exit threshold) -> NO false removal alert
    now += 60_000;
    const rHyst = await monitor.evaluateSymbol(snap({ supportStrength: 62 }), { directions: ['LONG'], now });
    assert.equal(rHyst.changes.length, 0);
    assert.equal(sent.length, 0);

    // 3. Support disappears (price broke below 94 -> mark 93) -> sends REMOVED alert!
    now += 60_000;
    const rRem = await monitor.evaluateSymbol(snap({ mark: 93, strongSupport: false }), { directions: ['LONG'], now });
    assert.equal(rRem.sent, true);
    assert.equal(rRem.changes.length, 1);
    assert.equal(rRem.changes[0].event, 'REMOVED');
    assert.equal(rRem.changes[0].kind, 'SUPPORT');
    assert.equal(rRem.changes[0].reason, 'PRICE_BREAK');
    assert.match(sent[0], /보유 종목 CVD 지지\/저항 변동 · BTCUSDT \(롱\)/);
    assert.match(sent[0], /소멸.*1D.*지지대.*가격 이탈/);
    assert.doesNotMatch(sent[0], /<pre>|<code>|<blockquote>/);

    // 4. New strong support forms at 88 -> sends ADDED alert!
    now += 60_000;
    const rAdd = await monitor.evaluateSymbol(snap({ mark: 93, strongSupport: true, supportPrice: 88, supportStrength: 85 }), { directions: ['LONG'], now });
    assert.equal(rAdd.sent, true);
    assert.equal(rAdd.changes.length, 1);
    assert.equal(rAdd.changes[0].event, 'ADDED');
    assert.equal(rAdd.changes[0].kind, 'SUPPORT');
    assert.match(sent[1], /신규.*1D.*지지대.*\$88\.00.*강도 85/);
    assert.doesNotMatch(sent[1], /<pre>|<code>|<blockquote>/);

    // 5. Persistence across restart + pruning when position closes
    const reloaded = new CvdSrAlertMonitor({ directory: dir, now: () => now });
    assert.equal(reloaded.recentEvents().length, 2);
    reloaded.pruneClosed([]);
    assert.equal(Object.keys(reloaded.store.tracked).length, 0);

    // Direct message formatter sanity check
    const msg = formatCvdSrChangeMessage({
      symbol: 'NCSKSNDK2USDUSDT',
      directions: ['SHORT'],
      markPrice: 210,
      changes: [{ event: 'ADDED', tf: '1W', kind: 'RESISTANCE', price: 225, distPct: 7.1, strength: 79, netDeltaUsd: -1500000 }],
    });
    assert.match(msg, /SNDKUSDT \(숏\)/);
    assert.doesNotMatch(msg, /<pre>|<code>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orderflowCvdSrMatrixHTML renders all-symbol multi-TF table, held highlight, filters, and clickable order prefill', () => {
  const cvdSr = {
    ok: true,
    monitoring: true,
    recentEvents: [{ event: 'REMOVED', symbol: 'BTCUSDT', displaySymbol: 'BTCUSDT', tf: '1D', kind: 'SUPPORT', price: 94000 }],
    rows: [
      {
        symbol: 'BTCUSDT',
        displaySymbol: 'BTCUSDT',
        markPrice: 95200,
        held: true,
        directions: ['LONG'],
        strongCount: 2,
        timeframes: {
          LIVE: {
            bestSupport: { kind: 'SUPPORT', centerPrice: 94100, distPct: -1.16, strength: 84, grade: 'STRONG', netDeltaUsd: 3200000 },
            bestResistance: { kind: 'RESISTANCE', centerPrice: 96800, distPct: 1.68, strength: 77, grade: 'STRONG', netDeltaUsd: -2400000 },
          },
          '1D': { bestSupport: null, bestResistance: null },
        },
      },
      {
        symbol: 'ETHUSDT',
        displaySymbol: 'ETHUSDT',
        markPrice: 3100,
        held: false,
        directions: [],
        strongCount: 0,
        timeframes: {},
      },
    ],
  };

  const htmlAll = orderflowCvdSrMatrixHTML(cvdSr, { activeSymbol: 'BTCUSDT', filter: 'all' });
  assert.match(htmlAll, /전 종목 CVD 지지·저항대/);
  assert.match(htmlAll, /보유 종목 생성·소멸 텔레그램 감시 ON/);
  assert.match(htmlAll, /<th>실시간<\/th><th>1D<\/th><th>1W<\/th><th>1M<\/th><th>6M<\/th><th>1Y<\/th>/);
  assert.match(htmlAll, /data-of-send-real-order[^>]*data-symbol="BTCUSDT"[^>]*data-price="94100"[^>]*data-side="LONG"/);
  assert.match(htmlAll, /⚠️ 소멸.*BTC.*1D.*지지/);
  assert.match(htmlAll, /ETH/);

  const htmlHeld = orderflowCvdSrMatrixHTML(cvdSr, { activeSymbol: 'BTCUSDT', filter: 'held' });
  assert.match(htmlHeld, /BTC/);
  assert.doesNotMatch(htmlHeld, /data-of-symbol="ETHUSDT"/);

  const fullScreen = orderflowHTML(null, { cvdSr, cvdSrFilter: 'all' });
  assert.match(fullScreen, /of-sr-box/);
});
