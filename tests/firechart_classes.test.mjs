// FireCharts order-size CVD classes (user 2026-11-25 09:51 "CVD를 UI 등 수정했으면 해", 09:20 screenshot legend):
// class bucketing, Normalized / Absolute math, the UI legend, the whale-zone hook and the 3Y range data limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRECHART_CLASSES, FIRECHART_CLASS_KEYS, FIRECHART_CLASS_EDGES, FIRECHART_RANGES,
  firechartClassOf, normalizeMinMax, normalizeCohortSeries, buildTradeCohortSeries, buildHistoricalCohortSeries,
} from '../firechart.mjs';
import {
  FIRECHART_CVD_CLASSES, FIRECHART_CVD_NOTES, FIRECHART_RANGE_TABS, cvdPointValue, cvdPaneScale, parseWhaleZones,
  fetchWhaleZones, firechartSvg, firechartLayout, firechartLegendHTML, firechartPercentileHTML, clampPercentiles,
} from '../public/orderflow_ui.js';
import { fetchOrderflow, clearOrderflowCache } from '../orderflow.mjs';

const T0 = Date.UTC(2026, 10, 25, 0, 0, 0);

test('the 6 classes, colours and legend text follow the screenshot, and the UI copy matches the server', () => {
  assert.deepEqual(FIRECHART_CLASS_KEYS, ['orange', 'green', 'red', 'purple', 'brown', 'blue']);
  assert.deepEqual(FIRECHART_CLASSES.map(c => c.legend),
    ['$100~$1000 (새우)', '$1000~$10000', '$10K~$100K', '$100K~$1M', '$1M~$10M (고래)', 'All Orders']);
  assert.deepEqual(FIRECHART_CLASSES.map(c => c.colorKo), ['주황', '초록', '빨강', '보라', '갈색', '파랑']);
  assert.deepEqual(FIRECHART_CVD_CLASSES.map(c => [c.key, c.legend, c.color]), FIRECHART_CLASSES.map(c => [c.key, c.legend, c.color]));
  for (const c of FIRECHART_CLASSES) assert.equal(c.token, `--wcv-${c.key}`);
  assert.deepEqual([...FIRECHART_CVD_NOTES], ['고래 : CVD 증가 = 매집 경향', '새우 : CVD 감소 = 매도 경향']);
  assert.deepEqual(FIRECHART_RANGE_TABS.map(x => x[0]), ['LIVE', '1D', '1W', '1M', '6M', '1Y', '3Y']);
  for (const [k] of FIRECHART_RANGE_TABS) assert.ok(Object.hasOwn(FIRECHART_RANGES, k), k);
});

test('class bucketing uses the fixed FireCharts edges (lower edge inclusive, dust only in All Orders)', () => {
  const cases = [[50, null], [99.99, null], [100, 'orange'], [999.99, 'orange'], [1_000, 'green'], [9_999, 'green'],
    [10_000, 'red'], [99_999, 'red'], [100_000, 'purple'], [999_999, 'purple'], [1_000_000, 'brown'], [9_999_999, 'brown'],
    [25_000_000, 'brown'], [-2_500, 'green']];
  for (const [usd, cls] of cases) assert.equal(firechartClassOf(usd), cls, String(usd));
  assert.equal(FIRECHART_CLASS_EDGES.brownMaxUSD, 10_000_000);

  // Signed per-class sums from real trades; blue = every trade including the $40 dust order
  const trades = [
    { usd: 40, buy: true }, { usd: 500, buy: true }, { usd: 300, buy: false }, { usd: 5_000, buy: false },
    { usd: 50_000, buy: true }, { usd: 400_000, buy: false }, { usd: 2_000_000, buy: true }, { usd: 600, buy: true },
  ].map((x, i) => ({ t: T0 + i * 1000, price: 100, quoteUsd: x.usd, isBuy: x.buy }));
  const out = buildTradeCohortSeries(trades, { buckets: 12 });
  assert.equal(out.cohortMode, 'REAL_TRADES');
  assert.deepEqual(out.latest.abs, { orange: 800, green: -5_000, red: 50_000, purple: -400_000, brown: 2_000_000, blue: 1_645_840 });
  assert.deepEqual(out.classCounts, { orange: 3, green: 1, red: 1, purple: 1, brown: 1, blue: 8 });
  // Cumulative: the series ends at the total and never jumps backwards in time
  for (let i = 1; i < out.series.length; i++) assert.ok(out.series[i].t >= out.series[i - 1].t);
});

test('Normalized = per-line min-max 0..1 (flat = 0.5); Absolute = one shared USD scale including zero', () => {
  assert.deepEqual(normalizeMinMax([-5, 0, 5]).values, [0, 0.5, 1]);
  assert.deepEqual(normalizeMinMax([3, 3, 3]).values, [0.5, 0.5, 0.5]);
  assert.deepEqual(normalizeMinMax([]), { min: 0, max: 0, values: [] });
  assert.deepEqual(normalizeMinMax([10, 20, 15, 30]).values, [0, 0.5, 0.25, 1]);

  const pts = [
    { t: 1, price: 1, orange: 0, green: 10, red: 0, purple: 0, brown: 0, blue: -200 },
    { t: 2, price: 1, orange: -100, green: 10, red: 50, purple: 0, brown: 0, blue: 0 },
    { t: 3, price: 1, orange: -50, green: 10, red: 100, purple: 0, brown: 900, blue: 400 },
  ];
  const n = normalizeCohortSeries(pts);
  assert.deepEqual(n.series.map(p => p.norm.orange), [1, 0, 0.5]);
  assert.deepEqual(n.series.map(p => p.norm.green), [0.5, 0.5, 0.5]);
  assert.deepEqual(n.series.map(p => p.norm.blue), [0, 0.3333, 1]);
  assert.deepEqual(n.bounds.red, { min: 0, max: 100 });
  assert.equal(n.latest.abs.brown, 900);

  assert.deepEqual(cvdPaneScale(n.series, { mode: 'normalized' }), { min: 0, max: 1 });
  assert.deepEqual(cvdPaneScale(n.series, { mode: 'absolute' }), { min: -200, max: 900 });
  assert.deepEqual(cvdPaneScale(n.series, { mode: 'absolute', hidden: ['brown'] }), { min: -200, max: 400 });
  assert.deepEqual(cvdPaneScale(n.series, { mode: 'absolute', hidden: ['brown', 'blue', 'orange'] }), { min: 0, max: 100 });
  assert.deepEqual(cvdPaneScale([{ abs: { orange: 0 } }], { mode: 'absolute' }), { min: -1, max: 1 });
  assert.equal(cvdPointValue(n.series[1], 'orange', 'absolute'), -100);
  assert.equal(cvdPointValue({ norm: { whale: 0.8 } }, 'brown', 'normalized'), 0.8, 'legacy whale → brown');
  assert.equal(cvdPointValue({ norm: {} }, 'purple', 'normalized'), 0.5);
  assert.equal(cvdPointValue(null, 'blue', 'absolute'), 0);

  // 3Y history is thinned to <= 400 points with the last bar kept
  const candles = Array.from({ length: 1095 }, (_, i) => ({ t: T0 + i * 86_400_000, c: 100 + i, q: 1e6, trades: 1000, delta: i % 2 ? 1000 : -500 }));
  const h = buildHistoricalCohortSeries(candles);
  assert.ok(h.series.length <= 400 && h.series.length >= 360, String(h.series.length));
  assert.equal(h.series.at(-1).t, candles.at(-1).t);
  assert.equal(h.latest.abs.blue, candles.reduce((a, c) => a + c.delta, 0));
});

function fixtureData({ range = 'LIVE', norm = [0, 0.5, 1] } = {}) {
  const series = Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * 300_000, o: 100, h: 101, l: 99, c: 100 + i * 0.1 }));
  const pts = norm.map((v, i) => ({
    t: T0 + i * 60_000, price: 100,
    abs: { orange: -1000 * i, green: 0, red: 0, purple: 0, brown: 5_000_000 * i, blue: 200 * i },
    norm: { orange: 1 - v, green: 0.5, red: 0.5, purple: 0.5, brown: v, blue: v },
  }));
  return {
    symbol: 'BTCUSDT', range, price: { mark: 100.5 }, series,
    firechart: {
      range, cohortMode: range === 'LIVE' ? 'REAL_TRADES' : 'ESTIMATED_BY_BAR_SIZE', bookSource: 'BINANCE',
      cohorts: { series: pts, classCounts: { orange: 4, green: 0, red: 0, purple: 0, brown: 1, blue: 5 }, tradeCount: 5, spanSec: 300,
        divergence: { type: 'WHALE_ACCUMULATION', badgeKo: '고래 매집 · 새우 매도 역행', tone: 'pos' } },
      heatmap: { priceBins: 40, minPrice: 90, maxPrice: 110, maxUsd: 1e6, cells: [], liveWalls: [], snapshotCount: 0 },
    },
  };
}

test('SVG draws the normalized lines on 0..1 of the CVD pane, sized to the screen width', () => {
  const data = fixtureData();
  const L = firechartLayout(390);
  assert.equal(L.compact, true);
  assert.equal(L.W, 390);
  assert.equal(firechartLayout(1400).compact, false);
  const svg = firechartSvg(data, { cvdMode: 'normalized', width: 390 });
  assert.match(svg, /viewBox="0 0 390 /);
  const blue = svg.match(/<polyline class="of-fc-line of-fc-l-blue"[^>]*points="([^"]+)"/)[1].split(' ').map(p => p.split(',').map(Number));
  assert.equal(blue[0][1], L.botY + L.botH, 'normalized 0 sits on the pane bottom');
  assert.equal(blue[1][1], L.botY + L.botH / 2);
  assert.equal(blue[2][1], L.botY, 'normalized 1 sits on the pane top');
  assert.equal(blue[0][0], L.PL);
  assert.equal(blue[2][0], L.PL + L.PW);

  // Absolute: shared scale, the brown $10M point is the top and the zero line is drawn when the range crosses 0
  const abs = firechartSvg(data, { cvdMode: 'absolute', width: 920 });
  const A = firechartLayout(920);
  const brown = abs.match(/<path class="of-fc-line of-fc-l-brown" d="([^"]+)"/)[1];
  assert.ok(brown.endsWith(`V ${A.botY.toFixed(1)}`), brown);
  assert.match(abs, /class="of-fc-zero"/);
  assert.match(abs, /Absolute CVD \(USD\)/);

  // A hidden class is not drawn
  const hid = firechartSvg(data, { hiddenClasses: ['brown', 'orange'] });
  assert.doesNotMatch(hid, /data-cvd-line="brown"/);
  assert.doesNotMatch(hid, /data-cvd-line="orange"/);
  assert.match(hid, /data-cvd-line="blue"/);
});

test('legend chips, notes, mode toggle and the Volume Percentiles a .. b control', () => {
  const data = fixtureData();
  const leg = firechartLegendHTML(data, { cvdMode: 'absolute', hiddenClasses: ['red'] });
  for (const k of FIRECHART_CLASS_KEYS) assert.match(leg, new RegExp(`class="of-fc-leg wcv-${k}`));
  assert.match(leg, /data-of-cvd-class="red" aria-pressed="false"/);
  assert.match(leg, /data-of-cvd-class="blue" aria-pressed="true"/);
  assert.match(leg, /aria-label="CVD 표시 모드"/);
  assert.match(leg, /data-of-cvd-mode="absolute" aria-pressed="true"/);
  assert.match(leg, /고래 : CVD 증가 = 매집 경향/);
  assert.match(leg, /새우 : CVD 감소 = 매도 경향/);
  assert.match(leg, /\+\$10\.00M/, 'brown latest value');
  assert.match(leg, /체결 없음/, 'a class with no trades says so');
  assert.match(leg, /실제 체결 5건\(최근 약 5분\)/);
  const hist = firechartLegendHTML(fixtureData({ range: '3Y' }));
  assert.match(hist, /All Orders는 봉별 실제 테이커 순매수 · 금액대 5개는 봉 거래 규모로 나눈 추정/);

  const pct = firechartPercentileHTML(33, 100);
  assert.match(pct, /Volume Percentiles: <b data-of-pct-label>33 \.\. 100<\/b>/);
  assert.match(pct, /style="--lo:33;--hi:100"/);
  assert.match(pct, /min="0" max="100"[^>]*value="33" data-of-pct-min aria-label="최소 유동성 백분위"/);
  assert.match(pct, /value="100" data-of-pct-max aria-label="최대 유동성 백분위"/);
  assert.deepEqual(clampPercentiles(70, 40, 'min'), { minPct: 70, maxPct: 70 });
  assert.deepEqual(clampPercentiles(70, 40, 'max'), { minPct: 40, maxPct: 40 });
  assert.deepEqual(clampPercentiles(-5, 140), { minPct: 0, maxPct: 100 });
  // Shown once, in the control above the chart (not repeated inside the SVG)
  assert.doesNotMatch(firechartSvg(data, { minPct: 33, maxPct: 100 }), /Volume Percentiles/);
});

test('whale-zone hook: 404 or a bad answer draws nothing; valid zones become bands on the heatmap', async () => {
  assert.deepEqual(parseWhaleZones({ zones: [
    { low: 95, high: 96, net: 2_500_000, side: 'buy' },
    { low: 104, high: 103, net: 1, side: 'SELL' }, // high < low
    { low: 'x', high: 106, side: 'SELL' },
    { low: 105, high: 106, net: -1_200_000, side: 'SELL' },
    { low: 97, high: 98, side: 'HOLD' },
  ] }), [{ low: 95, high: 96, net: 2_500_000, side: 'BUY' }, { low: 105, high: 106, net: -1_200_000, side: 'SELL' }]);
  assert.deepEqual(parseWhaleZones(null), []);
  assert.deepEqual(parseWhaleZones({ zones: 'nope' }), []);

  const urls = [];
  const resp = (status, body) => async url => { urls.push(url); return { status, ok: status >= 200 && status < 300, json: async () => body }; };
  assert.deepEqual(await fetchWhaleZones('BTCUSDT', { fetcher: resp(404, {}) }), { available: false, zones: [] });
  assert.equal(urls[0], '/api/whale-zones?symbol=BTCUSDT');
  assert.deepEqual(await fetchWhaleZones('BTCUSDT', { fetcher: resp(500, {}) }), { available: true, zones: [] });
  assert.deepEqual(await fetchWhaleZones('BTCUSDT', { fetcher: async () => { throw new Error('offline'); } }), { available: true, zones: [] });
  const ok = await fetchWhaleZones('BTCUSDT', { fetcher: resp(200, { zones: [{ low: 95, high: 96, net: 2e6, side: 'BUY' }] }) });
  assert.equal(ok.zones.length, 1);

  const data = fixtureData();
  assert.doesNotMatch(firechartSvg(data, {}), /data-whale-zone/);
  const svg = firechartSvg(data, { whaleZones: ok.zones, priceSpan: 'wide' });
  assert.match(svg, /class="of-fc-whale-zone buy" data-whale-zone data-zone-low="95" data-zone-high="96"/);
  assert.match(svg, /고래 매수 \+\$2\.00M/);
  // A zone outside the visible price range is skipped
  assert.doesNotMatch(firechartSvg(data, { whaleZones: [{ low: 500, high: 510, net: 1, side: 'SELL' }] }), /data-whale-zone/);
});

test('3Y range: 1,095 daily candles fit one Binance klines call; OI history stays within its 500 limit', async () => {
  assert.deepEqual(FIRECHART_RANGES['3Y'], { key: '3Y', labelKo: '3Y', interval: '1d', limit: 1095, useRealTrades: false });
  clearOrderflowCache();
  const urls = [];
  const day = 86_400_000;
  const start = Date.now() - 1100 * day;
  const kl = Array.from({ length: 1095 }, (_, i) => {
    const t = start + i * day;
    return [t, '100', '101', '99', '100.5', '10', t + day - 1, '1005', 50, '5', '520'];
  });
  const json = body => ({ ok: true, status: 200, json: async () => body });
  const fetcher = async url => {
    urls.push(String(url));
    if (String(url).includes('/fapi/v1/klines')) return json(kl);
    if (String(url).includes('premiumIndex')) return json({ markPrice: '100.5', indexPrice: '100.4', lastFundingRate: '0.0001' });
    return json([]);
  };
  const out = await fetchOrderflow('BTCUSDT', { interval: '1d', limit: 1095, fetcher, force: true });
  assert.equal(out.series.length, 1095);
  assert.match(urls.find(u => u.includes('/fapi/v1/klines')), /interval=1d&limit=1095/);
  assert.match(urls.find(u => u.includes('openInterestHist')), /limit=500/);
  // Intraday intervals keep the old 400 cap
  urls.length = 0;
  await fetchOrderflow('BTCUSDT', { interval: '5m', limit: 1095, fetcher, force: true }).catch(() => null);
  assert.match(urls.find(u => u.includes('/fapi/v1/klines')), /interval=5m&limit=400/);
  clearOrderflowCache();
});

test('6M / 1Y / 3Y time axes print the year (KST day)', () => {
  const data = fixtureData({ range: '3Y' });
  data.firechart.cohorts.series.forEach((p, i) => { p.t = Date.UTC(2023, 10, 25 + i * 400, 0, 0, 0); });
  const svg = firechartSvg(data, { width: 920 });
  assert.match(svg, />23\.11\.25</);
});
