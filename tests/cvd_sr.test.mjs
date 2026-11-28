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
  cvdSrPositionSentiment,
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

    // 3. Support disappears (price broke below 94 -> mark 93) -> sends REMOVED alert (ADVERSE for LONG!)
    now += 60_000;
    const rRem = await monitor.evaluateSymbol(snap({ mark: 93, strongSupport: false }), { directions: ['LONG'], now });
    assert.equal(rRem.sent, true);
    assert.equal(rRem.changes.length, 1);
    assert.equal(rRem.changes[0].event, 'REMOVED');
    assert.equal(rRem.changes[0].kind, 'SUPPORT');
    assert.equal(rRem.changes[0].reason, 'PRICE_BREAK');
    assert.equal(rRem.changes[0].sentiment, 'ADVERSE');
    assert.match(sent[0], /🔴 <b>BTCUSDT \(롱\) · CVD 주의<\/b>/);
    assert.match(sent[0], /🔴 <b>주의<\/b> │ 1D ▪▪ │ 지지대 소멸/);
    assert.match(sent[0], /\$94\.00.*가격 이탈/);
    assert.doesNotMatch(sent[0], /<pre>|<code>|<blockquote>/);

    // 4. New strong support forms at 88 -> sends ADDED alert (FAVORABLE for LONG!)
    now += 60_000;
    const rAdd = await monitor.evaluateSymbol(snap({ mark: 93, strongSupport: true, supportPrice: 88, supportStrength: 85 }), { directions: ['LONG'], now });
    assert.equal(rAdd.sent, true);
    assert.equal(rAdd.changes.length, 1);
    assert.equal(rAdd.changes[0].event, 'ADDED');
    assert.equal(rAdd.changes[0].kind, 'SUPPORT');
    assert.equal(rAdd.changes[0].sentiment, 'FAVORABLE');
    assert.match(sent[1], /🟢 <b>BTCUSDT \(롱\) · CVD 유리<\/b>/);
    assert.match(sent[1], /🟢 <b>유리<\/b> │ 1D ▪▪ │ 지지대 신규/);
    assert.match(sent[1], /\$88\.00.*강도 85/);
    assert.doesNotMatch(sent[1], /<pre>|<code>|<blockquote>/);

    // 5. Persistence across restart + pruning when position closes
    const reloaded = new CvdSrAlertMonitor({ directory: dir, now: () => now });
    assert.equal(reloaded.recentEvents().length, 2);
    reloaded.pruneClosed([]);
    assert.equal(Object.keys(reloaded.store.tracked).length, 0);

    // 6. Position-aware sentiment + timeframe weight/thickness (SHORT: resistance ADDED = FAVORABLE, support ADDED = ADVERSE; 6M/1Y bold+underline & sorted first)
    const msgShortFav = formatCvdSrChangeMessage({
      symbol: 'PIEVERSEUSDT',
      directions: ['SHORT'],
      markPrice: 3.876,
      changes: [
        { event: 'ADDED', tf: 'LIVE', kind: 'RESISTANCE', price: 3.994, distPct: 3.0, strength: 71, netDeltaUsd: -168000 },
        { event: 'ADDED', tf: '6M', kind: 'RESISTANCE', price: 4.25, distPct: 9.6, strength: 88, netDeltaUsd: -9500000 },
      ],
    });
    assert.match(msgShortFav, /🟩🔥 <b>PIEVERSEUSDT \(숏\) · CVD 대형 유리<\/b>/);
    assert.match(msgShortFav, /🟩🔥 <b><u>대형 유리<\/u><\/b> │ <b><u>6M █████<\/u><\/b> │ <b>저항대 신규<\/b>/);
    assert.match(msgShortFav, /🟢 <b>유리<\/b> │ 실시간 ▫ │ 저항대 신규/);
    assert.ok(msgShortFav.indexOf('6M █████') < msgShortFav.indexOf('실시간 ▫'), 'longer/heavier TF sorted first');
    assert.doesNotMatch(msgShortFav, /🔴|🟥|<pre>|<code>|<blockquote>/);

    // SHORT + SUPPORT ADDED -> ADVERSE (red caution!), 1Y ultra-thick
    const msgShortAdv = formatCvdSrChangeMessage({
      symbol: 'NCSKSNDK2USDUSDT',
      directions: ['SHORT'],
      markPrice: 210,
      changes: [{ event: 'ADDED', tf: '1Y', kind: 'SUPPORT', price: 195, distPct: -7.1, strength: 91, netDeltaUsd: 24000000 }],
    });
    assert.match(msgShortAdv, /🟥🚨 <b>SNDKUSDT \(숏\) · CVD 초대형 주의<\/b>/);
    assert.match(msgShortAdv, /🟥🚨 <b><u>초대형 주의<\/u><\/b> │ <b><u>1Y ██████<\/u><\/b> │ <b>지지대 신규<\/b>/);
    assert.doesNotMatch(msgShortAdv, /<pre>|<code>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orderflowCvdSrMatrixHTML renders all-symbol multi-TF table with TF thickness classes, held-position sentiment, filters, and clickable order prefill', () => {
  const cvdSr = {
    ok: true,
    monitoring: true,
    recentEvents: [{ event: 'REMOVED', symbol: 'BTCUSDT', displaySymbol: 'BTCUSDT', directions: ['LONG'], sentiment: 'ADVERSE', tf: '1D', kind: 'SUPPORT', price: 94000 }],
    rows: [
      {
        symbol: 'BTCUSDT',
        displaySymbol: 'BTCUSDT',
        markPrice: 95200,
        held: true,
        directions: ['LONG'],
        strongCount: 3,
        timeframes: {
          LIVE: {
            bestSupport: { kind: 'SUPPORT', centerPrice: 94100, distPct: -1.16, strength: 84, grade: 'STRONG', netDeltaUsd: 3200000 },
            bestResistance: { kind: 'RESISTANCE', centerPrice: 96800, distPct: 1.68, strength: 77, grade: 'STRONG', netDeltaUsd: -2400000 },
          },
          '6M': {
            bestSupport: { kind: 'SUPPORT', centerPrice: 88000, distPct: -7.56, strength: 90, grade: 'STRONG', netDeltaUsd: 42000000 },
            bestResistance: null,
          },
          '1D': { bestSupport: null, bestResistance: null },
        },
      },
      {
        symbol: 'PIEVERSEUSDT',
        displaySymbol: 'PIEVERSEUSDT',
        markPrice: 3.876,
        held: true,
        directions: ['SHORT'],
        strongCount: 1,
        timeframes: {
          '1W': {
            bestResistance: { kind: 'RESISTANCE', centerPrice: 4.1, distPct: 5.78, strength: 82, grade: 'STRONG', netDeltaUsd: -2500000 },
            bestSupport: null,
          },
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
  assert.match(htmlAll, /<th class="of-tf-h-1">실시간<\/th><th class="of-tf-h-2">1D<\/th><th class="of-tf-h-3">1W<\/th><th class="of-tf-h-4">1M<\/th><th class="of-tf-h-5">6M<\/th><th class="of-tf-h-6">1Y<\/th>/);
  assert.match(htmlAll, /data-of-send-real-order[^>]*data-symbol="BTCUSDT"[^>]*data-price="94100"[^>]*data-side="LONG"[^>]*data-pos-bias="favorable"/);
  assert.match(htmlAll, /of-sr-fav of-tf-5 is-strong/);
  // SHORT held row: resistance is FAVORABLE (of-sr-fav + 유리)!
  assert.match(htmlAll, /of-sr-fav of-tf-3 is-strong"[^>]*data-symbol="PIEVERSEUSDT"[^>]*data-pos-bias="favorable"[^>]*>[\s\S]*?<em>유리<\/em>/);
  assert.match(htmlAll, /🔴 주의.*BTC.*1D.*지지 소멸/);
  assert.match(htmlAll, /ETH/);

  const htmlHeld = orderflowCvdSrMatrixHTML(cvdSr, { activeSymbol: 'BTCUSDT', filter: 'held' });
  assert.match(htmlHeld, /BTC/);
  assert.match(htmlHeld, /PIEVERSE/);
  assert.doesNotMatch(htmlHeld, /data-of-symbol="ETHUSDT"/);

  const fullScreen = orderflowHTML(null, { cvdSr, cvdSrFilter: 'all' });
  assert.match(fullScreen, /of-sr-box/);
});

test('cvdSrPositionSentiment maps all LONG / SHORT / hedged x SUPPORT / RESISTANCE x ADDED / REMOVED combinations accurately', () => {
  // SHORT: resistance ADDED or support REMOVED = FAVORABLE; support ADDED or resistance REMOVED = ADVERSE
  assert.equal(cvdSrPositionSentiment({ directions: ['SHORT'], kind: 'RESISTANCE', event: 'ADDED' }), 'FAVORABLE');
  assert.equal(cvdSrPositionSentiment({ directions: ['SHORT'], kind: 'SUPPORT', event: 'REMOVED' }), 'FAVORABLE');
  assert.equal(cvdSrPositionSentiment({ directions: ['SHORT'], kind: 'SUPPORT', event: 'ADDED' }), 'ADVERSE');
  assert.equal(cvdSrPositionSentiment({ directions: ['SHORT'], kind: 'RESISTANCE', event: 'REMOVED' }), 'ADVERSE');
  // LONG: exact mirror
  assert.equal(cvdSrPositionSentiment({ directions: ['LONG'], kind: 'SUPPORT', event: 'ADDED' }), 'FAVORABLE');
  assert.equal(cvdSrPositionSentiment({ directions: ['LONG'], kind: 'RESISTANCE', event: 'REMOVED' }), 'FAVORABLE');
  assert.equal(cvdSrPositionSentiment({ directions: ['LONG'], kind: 'RESISTANCE', event: 'ADDED' }), 'ADVERSE');
  assert.equal(cvdSrPositionSentiment({ directions: ['LONG'], kind: 'SUPPORT', event: 'REMOVED' }), 'ADVERSE');
  // Hedged or unknown -> NEUTRAL
  assert.equal(cvdSrPositionSentiment({ directions: ['LONG', 'SHORT'], kind: 'RESISTANCE', event: 'ADDED' }), 'NEUTRAL');
  assert.equal(cvdSrPositionSentiment({ directions: [], kind: 'SUPPORT', event: 'ADDED' }), 'NEUTRAL');
});

test('CvdSrAlertMonitor suppresses Telegram alerts for zones too far from markPrice while keeping baseline tracking clean', async () => {
  const dir = tmp();
  try {
    let now = 1795100000000;
    const sent = [];
    const monitor = new CvdSrAlertMonitor({
      directory: dir,
      now: () => now,
      sendText: async t => { sent.push(t); return { ok: true }; },
    });

    const mkZone = (kind, price, mark, strength = 82) => ({
      kind,
      centerPrice: price,
      low: price * 0.995,
      high: price * 1.005,
      distPct: Math.round(((price - mark) / mark) * 10000) / 100,
      netDeltaUsd: kind === 'SUPPORT' ? 2000000 : -2000000,
      strength,
      grade: 'STRONG',
    });

    const emptyTf = () => ({ supports: [], resistances: [], strongSupports: [], strongResistances: [] });
    const mkSnap = ({ mark = 100, liveRes = [], d1Sup = [], m6Res = [] } = {}) => ({
      symbol: 'PIEVERSEUSDT',
      markPrice: mark,
      timeframes: {
        LIVE: { supports: [], resistances: liveRes, strongSupports: [], strongResistances: liveRes },
        '1D': { supports: d1Sup, resistances: [], strongSupports: d1Sup, strongResistances: [] },
        '1W': emptyTf(),
        '1M': emptyTf(),
        '6M': { supports: [], resistances: m6Res, strongSupports: [], strongResistances: m6Res },
        '1Y': emptyTf(),
      },
    });

    // 1. Baseline (empty)
    await monitor.evaluateSymbol(mkSnap({ mark: 100 }), { directions: ['SHORT'], now });
    assert.equal(sent.length, 0);

    // 2. Distant zones ADDED: LIVE +11% (>5%), 1D -16% (>8%), 6M +38% (>20%) -> ALL suppressed!
    now += 60_000;
    const rFarAdd = await monitor.evaluateSymbol(
      mkSnap({
        mark: 100,
        liveRes: [mkZone('RESISTANCE', 111, 100)],
        d1Sup: [mkZone('SUPPORT', 84, 100)],
        m6Res: [mkZone('RESISTANCE', 138, 100)],
      }),
      { directions: ['SHORT'], now }
    );
    assert.equal(rFarAdd.sent, false);
    assert.equal(rFarAdd.changes.length, 0);
    assert.equal(sent.length, 0);

    // 3. Price moves closer to the already-tracked LIVE resistance (mark=108 -> 111 is now +2.8% <= 5%) -> NO false ADDED alert!
    now += 60_000;
    const rApproach = await monitor.evaluateSymbol(
      mkSnap({
        mark: 108,
        liveRes: [mkZone('RESISTANCE', 111, 108)],
        d1Sup: [mkZone('SUPPORT', 84, 108)],
        m6Res: [mkZone('RESISTANCE', 138, 108)],
      }),
      { directions: ['SHORT'], now }
    );
    assert.equal(rApproach.sent, false);
    assert.equal(rApproach.changes.length, 0);

    // 4. Distant 6M resistance (+27.8% > 20%) weakens & disappears -> suppressed (still too far)
    now += 60_000;
    const rFarRem = await monitor.evaluateSymbol(
      mkSnap({
        mark: 108,
        liveRes: [mkZone('RESISTANCE', 111, 108)],
        d1Sup: [mkZone('SUPPORT', 84, 108)],
        m6Res: [],
      }),
      { directions: ['SHORT'], now }
    );
    assert.equal(rFarRem.sent, false);
    assert.equal(rFarRem.changes.length, 0);

    // 5. Nearby zones ADDED: LIVE +3.2% (<=5%) and 6M +16% (<=20%) -> BOTH alert!
    now += 60_000;
    const rNearAdd = await monitor.evaluateSymbol(
      mkSnap({
        mark: 100,
        liveRes: [mkZone('RESISTANCE', 111, 100), mkZone('RESISTANCE', 103.2, 100)],
        d1Sup: [mkZone('SUPPORT', 84, 100)],
        m6Res: [mkZone('RESISTANCE', 116, 100)],
      }),
      { directions: ['SHORT'], now }
    );
    assert.equal(rNearAdd.sent, true);
    assert.equal(rNearAdd.changes.length, 2);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /6M █████/);
    assert.match(sent[0], /실시간 ▫/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
