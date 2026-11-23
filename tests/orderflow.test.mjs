import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrderflowSymbol,
  gateContractFor,
  bingxSymbolFor,
  analyzeOrderflowSeries,
  detectCvdDivergence,
  estimateLiquidationMap,
  evaluateScalpOrderflowBoost,
  fetchOrderflow,
  clearOrderflowCache,
} from '../orderflow.mjs';
import { orderflowHTML, orderflowPriceCvdSvg, orderflowLiqMapHTML } from '../public/orderflow_ui.js';
import { ScalpExecutor, scalpExecConfig } from '../scalp_executor.mjs';
import { scalpEventText } from '../scalp_telegram.mjs';

const I5 = 300_000;
const BASE_T = Date.parse('2026-11-22T12:00:00Z');

function makeCandles(count, fn) {
  return Array.from({ length: count }, (_, i) => {
    const base = { t: BASE_T + i * I5, o: 100, h: 101, l: 99, c: 100, v: 1000, q: 100_000, buyVol: 50_000, sellVol: 50_000 };
    return { ...base, ...(fn ? fn(i, base) : {}) };
  });
}

test('symbol normalization maps Binance, Gate.io (1000PEPE), and BingX formats cleanly', () => {
  assert.equal(normalizeOrderflowSymbol('btc'), 'BTCUSDT');
  assert.equal(normalizeOrderflowSymbol('SOL-USDT'), 'SOLUSDT');
  assert.equal(gateContractFor('1000PEPEUSDT'), 'PEPE_USDT');
  assert.equal(gateContractFor('SOLUSDT'), 'SOL_USDT');
  assert.equal(bingxSymbolFor('ETHUSDT'), 'ETH-USDT');
});

test('analyzeOrderflowSeries computes CVD, bullish divergence, OI flush, ratios, funding, liquidations, and estimated liquidation map', () => {
  const oiMap = new Map();
  const liqMap = new Map();
  const candles = makeCandles(30, i => {
    const t = BASE_T + i * I5;
    // Earlier swing low at bar 10 (low 94, heavy selling); later lower low at bar 25 (low 92, strong buying absorption -> bullish divergence!)
    let o = 100, h = 101, l = 99, c = 100, buyVol = 55_000, sellVol = 45_000;
    if (i === 10) { o = 98; l = 94; h = 98.5; c = 95; buyVol = 15_000; sellVol = 185_000; }
    if (i === 25) { o = 95; l = 92; h = 95.5; c = 94; buyVol = 140_000; sellVol = 60_000; }
    if (i === 29) { o = 94; l = 93.8; h = 96; c = 95.8; buyVol = 160_000; sellVol = 40_000; } // deltaNorm = +0.60
    oiMap.set(t, i >= 26 ? 98_000_000 : 100_000_000); // -2.0% OI flush over last 30m
    liqMap.set(t, { longUsd: i >= 24 ? 25_000 : 0, shortUsd: i === 29 ? 8_000 : 0 });
    return { o, h, l, c, v: 1000, q: buyVol + sellVol, buyVol, sellVol };
  });

  const snap = analyzeOrderflowSeries({
    symbol: 'SOLUSDT',
    interval: '5m',
    source: 'BINANCE',
    candles,
    oiMap,
    lsrMap: new Map([[BASE_T + 29 * I5, 1.5]]),
    topLsrMap: new Map([[BASE_T + 29 * I5, 0.85]]),
    liqMap,
    funding: { markPrice: 95.8, indexPrice: 95.75, lastFundingRate: -0.00025, nextFundingTime: BASE_T + 3 * 3600_000 },
    now: BASE_T + 30 * I5,
  });

  assert.equal(snap.ok, true);
  assert.equal(snap.symbol, 'SOLUSDT');
  assert.equal(snap.oi.change30mPct, -2);
  assert.equal(snap.oi.state, 'OI_FLUSH');
  assert.equal(snap.oi.oiBonusEligible, true);
  assert.equal(snap.cvd.strongFlip, 'LONG');
  assert.equal(snap.cvd.divergence.type, 'BULLISH');
  assert.equal(snap.ratios.account.ratio, 1.5);
  assert.equal(snap.ratios.account.longPct, 60);
  assert.equal(snap.ratios.topTrader.ratio, 0.85);
  assert.equal(snap.funding.state, 'SHORT_CROWDED');
  assert.equal(snap.liquidations.recent30m.longUsd, 150_000);
  assert.equal(snap.liquidations.recent30m.shortUsd, 8_000);

  // Liquidation map sanity
  assert.equal(snap.liquidationMap.isEstimated, true);
  assert.equal(snap.liquidationMap.above.length, 9);
  assert.equal(snap.liquidationMap.below.length, 9);
  assert.ok(snap.liquidationMap.nearestShortMagnet.price > 95.8);
  assert.ok(snap.liquidationMap.nearestLongMagnet.price < 95.8);

  // Boost evaluator matches backtest FJ rules
  const longBoost = evaluateScalpOrderflowBoost(snap, 'LONG');
  assert.equal(longBoost.oiBonus, 5);
  assert.equal(longBoost.cvdBoost, true);
  assert.equal(longBoost.sizeMult, 1.5);
  assert.match(longBoost.summaryKo, /OI 소진 -2%\(\+5점\)/);
  assert.match(longBoost.summaryKo, /CVD 강한반전 \+60%\(1\.5x\)/);

  const shortBoost = evaluateScalpOrderflowBoost(snap, 'SHORT');
  assert.equal(shortBoost.oiBonus, 5);
  assert.equal(shortBoost.cvdBoost, false);
  assert.equal(shortBoost.sizeMult, 1);

  // UI renderer outputs KPI grid, SVG chart, and liquidation heatmap
  const html = orderflowHTML({ ...snap, quickSymbols: ['BTCUSDT', 'SOLUSDT'], openSymbols: ['SOLUSDT'] });
  assert.match(html, /SOLUSDT/);
  assert.match(html, /OI 소진 \+5점 충족/);
  assert.match(html, /롱 CVD 강한반전 1\.5x 충족/);
  assert.match(html, /<svg class="of-svg"/);
  assert.match(html, /추정 청산맵/);
  assert.match(html, /of-held-dot/);
});

test('detectCvdDivergence detects bearish divergence when price makes higher high while CVD weakens', () => {
  const series = Array.from({ length: 24 }, (_, i) => ({
    t: BASE_T + i * I5,
    h: i === 6 ? 105 : i === 19 ? 107 : 101,
    l: 99,
    c: 100,
    cvd: i === 6 ? 500_000 : i === 19 ? 150_000 : 300_000,
    deltaNorm: 0.02,
  }));
  const div = detectCvdDivergence(series);
  assert.equal(div.type, 'BEARISH');
});

test('fetchOrderflow gracefully falls back from Binance 451 geo-block to Gate.io contract_stats', async () => {
  clearOrderflowCache();
  const baseSec = Math.floor(BASE_T / 1000);
  const fakeKl = Array.from({ length: 12 }, (_, i) => ({
    t: baseSec + i * 300,
    o: '100', h: '101', l: '99', c: String(100 + i * 0.2), v: '500', sum: '50000',
  }));
  const fakeStats = Array.from({ length: 12 }, (_, i) => ({
    time: baseSec + i * 300,
    long_taker_size: i === 11 ? 800 : 500,
    short_taker_size: i === 11 ? 200 : 500,
    open_interest_usd: i === 11 ? 97_000_000 : 100_000_000,
    lsr_account: 1.2,
    top_lsr_size: 1.1,
    long_liq_usd: 4000,
    short_liq_usd: 1200,
    last_funding_rate: 0.0001,
  }));

  const fetcher = async url => {
    if (url.includes('fapi.binance.com')) return { ok: false, status: 451, json: async () => ({ code: 0 }) };
    if (url.includes('/candlesticks')) return { ok: true, status: 200, json: async () => fakeKl };
    if (url.includes('/contract_stats')) return { ok: true, status: 200, json: async () => fakeStats };
    if (url.includes('/contracts/')) return { ok: true, status: 200, json: async () => ({ mark_price: '102.2', index_price: '102.1', funding_rate: '0.0001' }) };
    throw new Error('Unexpected URL ' + url);
  };

  const snap = await fetchOrderflow('ETHUSDT', { interval: '5m', fetcher, force: true });
  assert.equal(snap.ok, true);
  assert.equal(snap.source, 'GATEIO');
  assert.equal(snap.oi.change30mPct, -3);
  assert.equal(snap.cvd.strongFlip, 'LONG');
  clearOrderflowCache();
});

test('ScalpExecutor integrates orderflow boost: rescues 60pt setup via OI flush (+5pt) and boosts sizing to 1.5x on strong CVD flip', async () => {
  const I = 300_000;
  const T0 = Date.parse('2026-11-22T10:05:10Z');
  const BUCKET = Math.floor(T0 / I);
  // Build a 60pt setup (move 4.3% -> 15pt, 4h range -> 10pt, btc 4h range -> 10pt, moveAtr ~4.5 -> 15pt, retraced ~18% -> 5pt, vol 5x -> 5pt = 60pt!)
  const rows = []; let p = 100;
  for (let i = 0; i < 45; i++) { const o = p, c = p + (i % 2 ? 0.2 : -0.2); rows.push([0, o, Math.max(o, c) + 0.25, Math.min(o, c) - 0.25, c, 100]); p = c; }
  for (let i = 0; i < 4; i++) { const o = p, c = p - 0.75; rows.push([0, o, o + 0.05, c - 0.05, c, 100 * (i === 3 ? 5.5 : 2)]); p = c; }
  const low = p - 0.65, close = p - 0.12;
  rows.push([0, p - 0.20, close + 0.05, low, close, 550]);
  const lastOpen = (BUCKET - 1) * I;
  const candles5m = [...rows.map((r, i) => {
    const t = lastOpen - (rows.length - 1 - i) * I;
    return [t, ...r.slice(1, 6).map(String), t + I - 1, String(r[5] * r[4])];
  }), [BUCKET * I, '100', '100', '100', '100', '1', BUCKET * I + I - 1, '1']];
  const range4h = Array.from({ length: 240 }, (_, i) => {
    const t = Math.floor(T0 / (4 * 3600_000)) * (4 * 3600_000) - (240 - i) * 4 * 3600_000;
    return [t, '100', '101', '99', '100', '1000', t + 4 * 3600_000 - 1, '100000'];
  });

  const SOL = { symbol: 'SOLUSDT', venueSymbol: 'SOL-USDT', tradable: true, tickSize: '0.01', quantityStep: '0.1', minQuantityBase: 0.1, minNotionalUSDT: 5, takerFeeRate: 0.0005 };
  const BTC = { symbol: 'BTCUSDT', venueSymbol: 'BTC-USDT', tradable: true, tickSize: '0.1', quantityStep: '0.001', minQuantityBase: 0.001, minNotionalUSDT: 5, takerFeeRate: 0.0005 };
  const mkVenue = px => {
    let amt = 0, id = 1;
    return {
      client: {
        mode: 'TESTNET',
        positionMode: async () => ({ dualSidePosition: false }),
        leverage: async () => ({ maxLongLeverage: 20, maxShortLeverage: 20 }),
        marginType: async () => ({ marginType: 'CROSSED' }),
        setMarginType: async () => ({ ok: true }),
        setLeverage: async () => ({ leverage: 10 }),
        positions: async () => amt > 0 ? [{ symbol: 'SOL-USDT', positionSide: 'BOTH', positionAmt: String(amt), avgPrice: String(px), markPrice: String(px), unrealizedProfit: '0' }] : [],
        openOrders: async () => [],
        placeOrder: async o => {
          const q = Number(o.quantity);
          if (o.type === 'MARKET' || o.timeInForce === 'GTX') amt += q;
          return { order: { orderId: String(id++), status: 'FILLED', executedQty: String(q), avgPrice: String(px) } };
        },
        getOrder: async () => null,
        cancelOrder: async () => ({ ok: true }),
      },
    };
  };

  // Without orderflow boost -> base score (<65) stays blocked by SCORE_BELOW_MINIMUM
  const v1 = mkVenue(close);
  const exNoBoost = new ScalpExecutor({
    config: { ...scalpExecConfig({}), stopLossEnabled: false, scaleIn: false, makerEntry: false, minScore: 65 },
    client: v1.client,
    contracts: async () => new Map([['SOLUSDT', SOL], ['BTCUSDT', BTC]]),
    tickers: async () => [{ symbol: 'SOL-USDT', quoteVolume: '90000000' }, { symbol: 'BTC-USDT', quoteVolume: '500000000' }],
    candles: async (s, iv) => iv === '5m' ? (s === 'SOLUSDT' ? candles5m : []) : range4h,
    orderflow: async () => ({ ok: true, source: 'GATEIO', oi: { change30mPct: 0.2 }, cvd: { lastDeltaNorm: 0.01 }, funding: { ratePct: 0.01 } }),
    priceOf: async () => close, markOf: async () => close,
    balance: async () => ({ equity: 3000, available: 2900 }),
    now: () => T0,
  });
  exNoBoost.arm();
  await exNoBoost.scan();
  const baseSkip = exNoBoost.store.skips.at(-1);
  assert.equal(exNoBoost.store.open.length, 0, '60pt setup without OI flush stays blocked');
  assert.equal(baseSkip?.reason, 'SCORE_BELOW_MINIMUM');
  assert.equal(baseSkip?.score, 60);

  // With OI flush (-2.2% -> +5pt) + strong CVD flip (+0.32 -> 1.5x sizing) -> rescued to 65pt & entered at 1.5x!
  const v2 = mkVenue(close);
  const exBoosted = new ScalpExecutor({
    config: { ...scalpExecConfig({}), stopLossEnabled: false, scaleIn: false, makerEntry: false, minScore: 65 },
    client: v2.client,
    contracts: async () => new Map([['SOLUSDT', SOL], ['BTCUSDT', BTC]]),
    tickers: async () => [{ symbol: 'SOL-USDT', quoteVolume: '90000000' }, { symbol: 'BTC-USDT', quoteVolume: '500000000' }],
    candles: async (s, iv) => iv === '5m' ? (s === 'SOLUSDT' ? candles5m : []) : range4h,
    orderflow: async () => ({ ok: true, source: 'BINANCE', oi: { change30mPct: -2.2 }, cvd: { lastDeltaNorm: 0.32 }, funding: { ratePct: -0.01 } }),
    priceOf: async () => close, markOf: async () => close,
    balance: async () => ({ equity: 3000, available: 2900 }),
    now: () => T0,
  });
  exBoosted.arm();
  await exBoosted.scan();
  assert.equal(exBoosted.store.open.length, 1, '60pt setup rescued to 65pt by OI flush bonus');
  assert.equal(exBoosted.store.open[0].scalpScore.score, 65);
  assert.equal(exBoosted.store.open[0].scalpScore.oiBonus, 5);
  assert.equal(exBoosted.store.open[0].scalpScore.sizeMult, 1.5);
  const opened = exBoosted.store.events.find(e => e.type === 'OPENED');
  const tg = scalpEventText(opened);
  assert.match(tg, /수급 OI 소진 -2\.2%\(\+5점\) · CVD 강한반전 \+32%\(1\.5x\)/);
  assert.match(tg, /비중 1\.5x/);
  assert.match(tg, /유럽장 0\.5x/);
  assert.equal(exBoosted.store.open[0].scalpScore.session.session, 'EUROPE');
  assert.equal(exBoosted.store.open[0].scalpScore.scoreTier.mult, 0.75);
  assert.equal(exBoosted.store.open[0].scalpScore.effectiveMult, 0.5625);
});

test('scalpSessionMultiplier applies backtest-validated EU 0.5x, US/Late 1.15x, Asia 1.0x', async () => {
  const { scalpSessionMultiplier } = await import('../scalp_executor.mjs');
  const cfg = scalpExecConfig({});
  assert.equal(cfg.sessionWeighting, true);
  assert.equal(cfg.sessionEuMult, 0.5);
  assert.equal(cfg.sessionUsMult, 1.15);

  const asia = scalpSessionMultiplier(Date.parse('2026-11-22T03:00:00Z'), cfg);
  assert.equal(asia.session, 'ASIA');
  assert.equal(asia.mult, 1);

  const eu = scalpSessionMultiplier(Date.parse('2026-11-22T10:30:00Z'), cfg);
  assert.equal(eu.session, 'EUROPE');
  assert.equal(eu.mult, 0.5);

  const us = scalpSessionMultiplier(Date.parse('2026-11-22T16:00:00Z'), cfg);
  assert.equal(us.session, 'US');
  assert.equal(us.mult, 1.15);

  const late = scalpSessionMultiplier(Date.parse('2026-11-22T23:15:00Z'), cfg);
  assert.equal(late.session, 'US');
  assert.equal(late.mult, 1.15);

  const off = scalpSessionMultiplier(Date.parse('2026-11-22T10:30:00Z'), { ...cfg, sessionWeighting: false });
  assert.equal(off.mult, 1);
});

test('rankOrderflowAnomalies ranks OI flush, strong CVD flips, divergences and renders clickable radar strip', async () => {
  const { rankOrderflowAnomalies } = await import('../orderflow.mjs');
  const { orderflowRadarHTML } = await import('../public/orderflow_ui.js');
  const snapshots = [
    { ok: true, symbol: 'SOLUSDT', source: 'BINANCE', price: { mark: 180.5, windowChangePct: -2.1 }, oi: { change30mPct: -2.4 }, cvd: { lastDeltaNorm: 0.31, lastBuySharePct: 65.5, divergence: { type: 'BULLISH' } }, funding: { ratePct: -0.02 } },
    { ok: true, symbol: 'BTCUSDT', source: 'BINANCE', price: { mark: 92000, windowChangePct: 0.3 }, oi: { change30mPct: 0.1 }, cvd: { lastDeltaNorm: 0.02, lastBuySharePct: 51, divergence: { type: 'NONE' } }, funding: { ratePct: 0.005 } },
    { ok: true, symbol: 'ETHUSDT', source: 'GATEIO', price: { mark: 3100, windowChangePct: 1.4 }, oi: { change30mPct: 2.5 }, cvd: { lastDeltaNorm: -0.24, lastBuySharePct: 38, divergence: { type: 'BEARISH' } }, funding: { ratePct: 0.025 } },
  ];
  const radar = rankOrderflowAnomalies(snapshots);
  assert.equal(radar.scanned, 3);
  assert.equal(radar.flaggedCount, 2);
  assert.equal(radar.anomalies[0].symbol, 'SOLUSDT');
  assert.equal(radar.topOiFlush[0].symbol, 'SOLUSDT');
  assert.equal(radar.topCvdFlip[0].symbol, 'SOLUSDT');

  const html = orderflowRadarHTML({ ...radar, at: BASE_T }, 'SOLUSDT', false);
  assert.match(html, /실시간 수급 이상치 레이더/);
  assert.match(html, /data-of-symbol="SOLUSDT"/);
  assert.match(html, /OI -2\.4% 소진\(\+5점\)/);
  assert.match(html, /매수 CVD \+31%\(1\.5x\)/);
  assert.match(html, /data-of-radar-refresh/);
});

test('FireCharts engine builds 4-cohort real-trade CVD (Normalized & Absolute), liquidity heatmap, and FireCharts SVG', async () => {
  const {
    buildTradeCohortSeries,
    buildHistoricalCohortSeries,
    buildLiquidityHeatmap,
    recordOrderbookSnapshot,
    getOrderbookSnapshots,
    clearFirechartHistory,
  } = await import('../firechart.mjs');
  const { firechartSvg } = await import('../public/orderflow_ui.js');

  clearFirechartHistory();
  // Real signed trade ticks spanning retail (<$1K), mid ($1K-$10K), large ($10K-$100K), whale ($100K+)
  const trades = [];
  for (let i = 0; i < 80; i++) {
    const t = BASE_T + i * 5000;
    trades.push({ t, price: 100 + i * 0.02, quoteUsd: 400, isBuy: i % 3 !== 0 }); // retail
    trades.push({ t: t + 500, price: 100 + i * 0.02, quoteUsd: 3500, isBuy: i % 2 === 0 }); // mid
    if (i % 4 === 0) trades.push({ t: t + 1000, price: 100 + i * 0.02, quoteUsd: 25_000, isBuy: true }); // large
    if (i % 16 === 0) trades.push({ t: t + 1500, price: 100 + i * 0.02, quoteUsd: 180_000, isBuy: i > 30 }); // whale step
  }
  const realCohorts = buildTradeCohortSeries(trades, { buckets: 40 });
  assert.equal(realCohorts.cohortMode, 'REAL_TRADES');
  assert.equal(realCohorts.thresholds.mode, 'MAJOR');
  assert.ok(realCohorts.series.length >= 12);
  // Every normalized point must sit in [0, 1]
  for (const pt of realCohorts.series) {
    for (const k of ['retail', 'mid', 'large', 'whale']) {
      assert.ok(pt.norm[k] >= 0 && pt.norm[k] <= 1, `${k} norm out of bounds: ${pt.norm[k]}`);
    }
  }
  assert.ok(realCohorts.latest.abs.large > 0, 'large cohort net positive');

  // Historical decomposition + live L2 orderbook heatmap + snapshot recorder
  const candles = makeCandles(36, i => ({
    o: 100 + i * 0.1, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100.2 + i * 0.1,
    v: i === 20 ? 8000 : 1000, q: i === 20 ? 800_000 : 100_000,
    trades: i === 20 ? 120 : 400,
    buyVol: i === 20 ? 600_000 : 52_000, sellVol: i === 20 ? 200_000 : 48_000,
    delta: i === 20 ? 400_000 : 4_000,
  }));
  const histCohorts = buildHistoricalCohortSeries(candles);
  assert.equal(histCohorts.cohortMode, 'ESTIMATED_BY_BAR_SIZE');
  assert.ok(histCohorts.latest.abs.whale > 0, 'whale impulse triggers on high-intensity bar');

  const book = {
    bids: [{ p: 101.5, usd: 450_000 }, { p: 100.5, usd: 920_000 }],
    asks: [{ p: 104.2, usd: 1_100_000 }, { p: 105.0, usd: 600_000 }],
  };
  recordOrderbookSnapshot('ORCAUSDT', book, BASE_T + 30 * I5);
  assert.equal(getOrderbookSnapshots('ORCAUSDT').length, 1);

  const hm = buildLiquidityHeatmap({ candles, orderbook: book, snapshots: getOrderbookSnapshots('ORCAUSDT') });
  assert.equal(hm.hasLiveBook, true);
  assert.equal(hm.snapshotCount, 1);
  assert.ok(hm.liveWalls.length >= 2);
  assert.ok(hm.cells.length > 0);

  // Render FireCharts SVG in both Normalized & Absolute modes
  const mockData = {
    symbol: 'ORCAUSDT',
    range: 'LIVE',
    source: 'GATEIO',
    series: candles,
    firechart: { range: 'LIVE', labelKo: '실시간', cohortMode: 'REAL_TRADES', bookSource: 'GATEIO', cohorts: realCohorts, heatmap: hm },
  };
  const svgNorm = firechartSvg(mockData, { cvdMode: 'normalized', minPct: 80, maxPct: 99 });
  assert.match(svgNorm, /<svg class="of-fc-svg"/);
  assert.match(svgNorm, /Normalized CVD \(0~1\)/);
  assert.match(svgNorm, /fcFireScale/);
  assert.match(svgNorm, /<path d="M /); // stepped whale red line

  const svgAbs = firechartSvg(mockData, { cvdMode: 'absolute', minPct: 90, maxPct: 99 });
  assert.match(svgAbs, /Absolute CVD \(USD\)/);

  const page = orderflowHTML({ ...mockData, ok: true, price: { mark: 103.7 }, cvd: {}, oi: {}, ratios: {}, funding: {}, liquidations: {}, liquidationMap: { above: [], below: [] }, scalpSignal: {} }, { cvdMode: 'normalized', minPct: 93, maxPct: 99 });
  assert.match(page, /Volume Percentiles:/);
  assert.match(page, /Normalized CVD/);
  assert.match(page, /Absolute CVD/);
  assert.match(page, /data-of-range="1M"/);
  assert.match(page, /data-of-fc-inspect/);
  assert.match(page, /data-of-wall-strip/);
  clearFirechartHistory();
});

test('FireCharts wall touch inspection snaps to liquidity wall lines, renders crosshair price badge, readout bar, and tappable wall chips', async () => {
  const {
    findFirechartWallAt,
    firechartInspectBarHTML,
    firechartWallSummaryHTML,
    firechartSvg,
  } = await import('../public/orderflow_ui.js');
  const { buildHistoricalCohortSeries } = await import('../firechart.mjs');

  const candles = makeCandles(24, i => ({
    o: 100, h: 110, l: 90, c: 100,
    v: 1000, q: 100_000, buyVol: 52_000, sellVol: 48_000, delta: 4000,
  }));
  const cohorts = buildHistoricalCohortSeries(candles);
  const hm = {
    priceBins: 40,
    minPrice: 90,
    maxPrice: 110,
    maxUsd: 1_500_000,
    p80Usd: 200_000,
    hasLiveBook: true,
    snapshotCount: 2,
    liveWalls: [],
    cells: [
      // Strong ASK wall near yBin 30 (price 105.25 -> yNorm = 1 - 30.5/40 = 0.2375)
      { x0: 0.75, x1: 1.0, yBin: 30, price: 105.25, usd: 1_450_000, pctRank: 99, side: 'ASK', live: true },
      // Strong BID wall near yBin 10 (price 95.25 -> yNorm = 1 - 10.5/40 = 0.7375)
      { x0: 0.2, x1: 0.85, yBin: 10, price: 95.25, usd: 880_000, pctRank: 96, side: 'BID', live: false },
    ],
  };
  const data = {
    symbol: 'BTCUSDT',
    range: 'LIVE',
    price: { mark: 100 },
    series: candles,
    firechart: { range: 'LIVE', cohortMode: 'REAL_TRADES', cohorts, heatmap: hm },
  };

  // 1) Touching near the ASK wall bar snaps to exact wall price $105.25
  const askHit = findFirechartWallAt(data, { xNorm: 0.88, yNorm: 0.24, minPct: 93, maxPct: 99 });
  assert.equal(askHit.snapped, true);
  assert.equal(askHit.price, 105.25);
  assert.equal(askHit.side, 'ASK');
  assert.equal(askHit.usd, 1_450_000);
  assert.equal(askHit.live, true);
  assert.equal(askHit.distPct, 5.25);

  // 2) Touching empty space far from walls returns exact free price level
  const freeHit = findFirechartWallAt(data, { xNorm: 0.1, yNorm: 0.5, minPct: 93, maxPct: 99 });
  assert.equal(freeHit.snapped, false);
  assert.equal(freeHit.price, 100);

  // 3) Readout banner & wall chip strip render exact prices and metadata
  const idleBar = firechartInspectBarHTML(null);
  assert.match(idleBar, /매물대 줄을 터치/);

  const activeBar = firechartInspectBarHTML(askHit);
  assert.match(activeBar, /매도벽 \(저항\)/);
  assert.match(activeBar, /\$105\.25/);
  assert.match(activeBar, /\+5\.25%/);
  assert.match(activeBar, /\$1\.45M/);
  assert.match(activeBar, /실시간 L2 호가벽/);
  assert.match(activeBar, /data-of-inspect-clear/);

  const strip = firechartWallSummaryHTML(data, { minPct: 93, maxPct: 99, inspected: askHit });
  assert.match(strip, /상단 매도벽/);
  assert.match(strip, /하단 매수벽/);
  assert.match(strip, /data-wall-price="105\.25"/);
  assert.match(strip, /data-wall-price="95\.25"/);

  // 4) SVG renders horizontal dashed crosshair guide line + right-axis price pill
  const svgWithCrosshair = firechartSvg(data, { cvdMode: 'normalized', minPct: 93, maxPct: 99, inspected: askHit });
  assert.match(svgWithCrosshair, /data-fc-crosshair/);
  assert.match(svgWithCrosshair, /105\.25/);
  assert.match(svgWithCrosshair, /class="of-fc-wall"/);
});

test('Whale vs Retail CVD cohort divergence badge, L2 snapshot disk persistence, and backtest-validated 0.28 runner trail ratio', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {
    normalizeCohortSeries,
    configureFirechartPersistence,
    recordOrderbookSnapshot,
    getOrderbookSnapshots,
    clearFirechartHistory,
  } = await import('../firechart.mjs');
  const { SCALP_TRAIL_RUNNER_PULLBACK_RATIO } = await import('../scalp_executor.mjs');

  assert.equal(SCALP_TRAIL_RUNNER_PULLBACK_RATIO, 0.28);

  // 1) Whale accumulation against retail selling
  const accumPts = Array.from({ length: 10 }, (_, i) => ({
    t: BASE_T + i * 60_000,
    price: 100 + i * 0.1,
    retail: -50_000 * (i + 1),
    mid: -10_000 * (i + 1),
    large: 120_000 * (i + 1),
    whale: 350_000 * (i + 1),
  }));
  const accum = normalizeCohortSeries(accumPts);
  assert.equal(accum.divergence.type, 'WHALE_ACCUMULATION');
  assert.match(accum.divergence.badgeKo, /고래 매집 · 개미 투매 역행/);

  // 2) Whale distribution into retail buying
  const distPts = Array.from({ length: 10 }, (_, i) => ({
    t: BASE_T + i * 60_000,
    price: 100 - i * 0.1,
    retail: 60_000 * (i + 1),
    mid: 15_000 * (i + 1),
    large: -100_000 * (i + 1),
    whale: -400_000 * (i + 1),
  }));
  const dist = normalizeCohortSeries(distPts);
  assert.equal(dist.divergence.type, 'WHALE_DISTRIBUTION');
  assert.match(dist.divergence.badgeKo, /고래 매도 · 개미 추격 역행/);

  // 3) Disk persistence of L2 orderbook snapshots across restarts
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-snap-'));
  try {
    clearFirechartHistory();
    configureFirechartPersistence(tmpDir);
    recordOrderbookSnapshot('SOLUSDT', { bids: [{ p: 180, usd: 500_000 }], asks: [{ p: 182, usd: 700_000 }] }, BASE_T, { forceFlush: true });
    assert.equal(getOrderbookSnapshots('SOLUSDT').length, 1);
    clearFirechartHistory();
    assert.equal(getOrderbookSnapshots('SOLUSDT').length, 0);
    configureFirechartPersistence(tmpDir);
    assert.equal(getOrderbookSnapshots('SOLUSDT').length, 1, 'reloaded L2 orderbook snapshots from disk');
  } finally {
    configureFirechartPersistence(null);
    clearFirechartHistory();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FireCharts wide price span (tight/normal/wide/ultra), 6M/1Y ranges, and send-to-real-order handoff button', async () => {
  const { FIRECHART_RANGES, buildLiquidityHeatmap, buildHistoricalCohortSeries } = await import('../firechart.mjs');
  const { computeFirechartPriceBounds, firechartInspectBarHTML, orderflowHTML } = await import('../public/orderflow_ui.js');

  assert.equal(FIRECHART_RANGES['6M'].interval, '1d');
  assert.equal(FIRECHART_RANGES['6M'].limit, 180);
  assert.equal(FIRECHART_RANGES['1Y'].interval, '1d');
  assert.equal(FIRECHART_RANGES['1Y'].limit, 365);

  // ORCA-like 1M swing ($1.05 .. $1.60 around $1.25)
  const candles = makeCandles(30, i => ({
    o: 1.25, h: i === 12 ? 1.60 : 1.32, l: i === 5 ? 1.05 : 1.18, c: 1.25,
    v: 100_000, q: 125_000, buyVol: 65_000, sellVol: 60_000, delta: 5_000,
  }));
  const book = {
    bids: [{ p: 0.72, usd: 420_000 }, { p: 1.02, usd: 600_000 }],
    asks: [{ p: 1.85, usd: 750_000 }, { p: 2.25, usd: 510_000 }],
  };
  const hm = buildLiquidityHeatmap({ candles, orderbook: book, snapshots: [] });
  assert.equal(hm.candleMinPrice, 1.05);
  assert.equal(hm.candleMaxPrice, 1.6);
  // Master collection span must capture far resting L2 walls like $0.72 and $2.25
  assert.ok(hm.minPrice < 0.70, `expected wide master minPrice < 0.70, got ${hm.minPrice}`);
  assert.ok(hm.maxPrice > 2.30, `expected wide master maxPrice > 2.30, got ${hm.maxPrice}`);

  const data = {
    symbol: 'ORCAUSDT',
    range: '1M',
    price: { mark: 1.25 },
    series: candles,
    firechart: { range: '1M', cohortMode: 'ESTIMATED_BY_BAR_SIZE', cohorts: buildHistoricalCohortSeries(candles), heatmap: hm },
  };
  const bTight = computeFirechartPriceBounds(data, 'tight');
  const bNormal = computeFirechartPriceBounds(data, 'normal');
  const bWide = computeFirechartPriceBounds(data, 'wide');
  const bUltra = computeFirechartPriceBounds(data, 'ultra');
  assert.ok((bTight.maxP - bTight.minP) < (bNormal.maxP - bNormal.minP));
  assert.ok((bNormal.maxP - bNormal.minP) < (bWide.maxP - bWide.minP));
  assert.ok((bWide.maxP - bWide.minP) < (bUltra.maxP - bUltra.minP));
  assert.ok(bWide.minP < 0.75 && bWide.maxP > 2.0, `wide span should match Material Indicators 1M view: ${bWide.minP}..${bWide.maxP}`);

  // Inspect banner carries one-click handoff button with symbol & limit price
  const bar = firechartInspectBarHTML({ snapped: true, price: 1.02, usd: 600_000, side: 'BID', pctRank: 98, live: true, distPct: -18.4 }, 'ORCAUSDT');
  assert.match(bar, /data-of-send-real-order/);
  assert.match(bar, /data-symbol="ORCAUSDT"/);
  assert.match(bar, /data-price="1\.02"/);
  assert.match(bar, /실계좌 지정가 주문/);

  // Full HTML includes 6M/1Y tabs and 4 price-span zoom buttons
  const page = orderflowHTML({ ...data, ok: true, cvd: {}, oi: {}, ratios: {}, funding: {}, liquidations: {}, liquidationMap: { above: [], below: [] }, scalpSignal: {} }, { priceSpan: 'wide' });
  assert.match(page, /data-of-range="6M"/);
  assert.match(page, /data-of-range="1Y"/);
  assert.match(page, /data-of-price-span="tight"/);
  assert.match(page, /data-of-price-span="wide"/);
  assert.match(page, /data-of-price-span="ultra"/);
});

