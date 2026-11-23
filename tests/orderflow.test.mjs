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
});
