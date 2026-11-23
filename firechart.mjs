// Material Indicators FireCharts-style Liquidity Wall Heatmap + 4-Cohort (Whale/Large/Mid/Retail) CVD engine.
// Pure math helpers are exported for unit tests; live fetchers pull real L2 orderbooks and signed trades
// from Binance Futures (primary) with automatic Gate.io / BingX fallback, and accumulate live L2 snapshots in memory.

import fs from 'node:fs';
import path from 'node:path';

export const FIRECHART_RANGES = Object.freeze({
  LIVE: { key: 'LIVE', labelKo: '실시간', interval: '5m', limit: 72, useRealTrades: true },
  '1D': { key: '1D', labelKo: '1D', interval: '15m', limit: 96, useRealTrades: false },
  '1W': { key: '1W', labelKo: '1W', interval: '1h', limit: 168, useRealTrades: false },
  '1M': { key: '1M', labelKo: '1M', interval: '4h', limit: 180, useRealTrades: false },
  '6M': { key: '6M', labelKo: '6M', interval: '1d', limit: 180, useRealTrades: false },
  '1Y': { key: '1Y', labelKo: '1Y', interval: '1d', limit: 365, useRealTrades: false },
});

export const FIRECHART_COHORTS = Object.freeze([
  { key: 'retail', labelKo: '개미', color: '#f59e0b', stepped: false },
  { key: 'mid', labelKo: '중형', color: '#38bdf8', stepped: false },
  { key: 'large', labelKo: '대형', color: '#22c55e', stepped: false },
  { key: 'whale', labelKo: '고래', color: '#ef4444', stepped: true },
]);

const num = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const round = (v, d = 4) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// In-memory + optional disk-persisted live L2 orderbook snapshot recorder (ring buffer per symbol, max 120 snapshots x 15 coins)
const MAX_SNAPSHOTS_PER_SYM = 120;
const MAX_TRACKED_SYMS = 15;
const bookHistory = new Map();
let snapshotFile = null;
let lastDiskFlushAt = 0;

function flushSnapshotsToDisk(now = Date.now(), force = false) {
  if (!snapshotFile) return;
  if (!force && now - lastDiskFlushAt < 15_000) return;
  lastDiskFlushAt = now;
  try {
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    const obj = { version: 1, at: now, symbols: Object.fromEntries(bookHistory.entries()) };
    const tmp = `${snapshotFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, snapshotFile);
  } catch {}
}

export function configureFirechartPersistence(directory) {
  if (!directory) { snapshotFile = null; return; }
  snapshotFile = path.join(directory, 'firechart-snapshots.json');
  if (fs.existsSync(snapshotFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      const syms = raw?.symbols && typeof raw.symbols === 'object' ? raw.symbols : {};
      for (const [sym, arr] of Object.entries(syms)) {
        if (Array.isArray(arr) && arr.length) {
          bookHistory.set(sym.toUpperCase(), arr.slice(-MAX_SNAPSHOTS_PER_SYM));
        }
      }
    } catch {}
  }
}

export function recordOrderbookSnapshot(symbol, book, now = Date.now(), { forceFlush = false } = {}) {
  if (!symbol || !book || (!book.bids?.length && !book.asks?.length)) return;
  const sym = String(symbol).toUpperCase();
  let arr = bookHistory.get(sym);
  if (!arr) {
    arr = [];
    bookHistory.set(sym, arr);
    if (bookHistory.size > MAX_TRACKED_SYMS) bookHistory.delete(bookHistory.keys().next().value);
  }
  const last = arr.at(-1);
  if (last && now - last.t < 20_000) return; // deduplicate rapid calls (<20s)
  const topSide = rows => [...(rows || [])]
    .map(r => ({ p: num(r.p), usd: num(r.usd) }))
    .filter(r => r.p > 0 && r.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 60);
  arr.push({ t: now, bids: topSide(book.bids), asks: topSide(book.asks) });
  if (arr.length > MAX_SNAPSHOTS_PER_SYM) arr.splice(0, arr.length - MAX_SNAPSHOTS_PER_SYM);
  flushSnapshotsToDisk(now, forceFlush);
}

export function getOrderbookSnapshots(symbol) {
  return bookHistory.get(String(symbol || '').toUpperCase()) || [];
}

export function clearFirechartHistory() {
  bookHistory.clear();
  lastDiskFlushAt = 0;
}

/**
 * Detect Whale (Red) + Large (Green) vs Retail (Orange) CVD divergence.
 */
export function detectCohortDivergence(series = []) {
  if (!Array.isArray(series) || series.length < 4) {
    return { type: 'NEUTRAL', badgeKo: '고래·개미 중립', detailKo: '코호트 간 유의미한 수급 역행 없음', tone: 'neutral' };
  }
  const last = series.at(-1);
  const lookback = series[Math.max(0, series.length - Math.min(12, Math.floor(series.length / 2)))];
  const whaleAbs = num(last?.abs?.whale);
  const largeAbs = num(last?.abs?.large);
  const retailAbs = num(last?.abs?.retail);
  const whaleNorm = num(last?.norm?.whale, 0.5);
  const retailNorm = num(last?.norm?.retail, 0.5);
  const whaleRecentDelta = whaleAbs - num(lookback?.abs?.whale);
  const retailRecentDelta = retailAbs - num(lookback?.abs?.retail);
  const smartSum = whaleAbs + largeAbs * 0.5;

  // 1) Whale Accumulation against Retail Selling (Bullish Smart-Money Divergence)
  if ((whaleAbs > 0 || smartSum > 0) && retailAbs < 0 && (whaleNorm - retailNorm >= 0.22 || (whaleRecentDelta > 0 && retailRecentDelta < 0))) {
    return {
      type: 'WHALE_ACCUMULATION',
      badgeKo: '🐋 고래 매집 · 개미 투매 역행',
      detailKo: '고래(Red)·대형(Green) 순매수 유입 중 개미(Orange) 순매도 이탈 — 스마트머니 하방 흡수 우위',
      tone: 'pos',
    };
  }
  // 2) Whale Distribution into Retail Buying (Bearish Smart-Money Divergence)
  if ((whaleAbs < 0 || smartSum < 0) && retailAbs > 0 && (retailNorm - whaleNorm >= 0.22 || (whaleRecentDelta < 0 && retailRecentDelta > 0))) {
    return {
      type: 'WHALE_DISTRIBUTION',
      badgeKo: '🐋 고래 매도 · 개미 추격 역행',
      detailKo: '고래(Red)·대형(Green) 순매도 이탈 중 개미(Orange) 추격 순매수 — 상방 물량 떠넘기기 주의',
      tone: 'neg',
    };
  }
  // 3) Strong Whale-led directional flow
  if (whaleAbs > 0 && whaleNorm >= 0.72) {
    return {
      type: 'WHALE_LED_BUY',
      badgeKo: '🐋 고래 주도 순매수 우위',
      detailKo: '고래(Red) 계단식 순매수 누적 구간',
      tone: 'pos',
    };
  }
  if (whaleAbs < 0 && whaleNorm <= 0.28) {
    return {
      type: 'WHALE_LED_SELL',
      badgeKo: '🐋 고래 주도 순매도 우위',
      detailKo: '고래(Red) 계단식 순매도 이탈 구간',
      tone: 'neg',
    };
  }
  return { type: 'NEUTRAL', badgeKo: '고래·개미 동조/중립', detailKo: '코호트 간 뚜렷한 역행 없음', tone: 'neutral' };
}

/**
 * Normalize 4 cohort cumulative series into both Absolute (USD) and Normalized (0.00..1.00) arrays.
 */
export function normalizeCohortSeries(points = []) {
  const keys = ['retail', 'mid', 'large', 'whale'];
  const bounds = {};
  for (const k of keys) {
    let mn = Infinity, mx = -Infinity;
    for (const pt of points) {
      const v = num(pt[k]);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    bounds[k] = { min: Number.isFinite(mn) ? mn : 0, max: Number.isFinite(mx) ? mx : 0 };
  }
  const series = points.map(pt => {
    const abs = {}, norm = {};
    for (const k of keys) {
      const v = num(pt[k]);
      abs[k] = Math.round(v);
      const span = bounds[k].max - bounds[k].min;
      norm[k] = span > 1e-6 ? round((v - bounds[k].min) / span, 4) : 0.5;
    }
    return { t: pt.t, price: num(pt.price), abs, norm };
  });
  const latest = series.at(-1) || { abs: { retail: 0, mid: 0, large: 0, whale: 0 }, norm: { retail: 0.5, mid: 0.5, large: 0.5, whale: 0.5 } };
  const divergence = detectCohortDivergence(series);
  return { series, latest, bounds, divergence };
}

/**
 * Pick adaptive trade-size cohort thresholds so both BTC ($1K/$10K/$100K) and smaller alts ($500/$5K/$25K)
 * produce lively, informative 4-tier cohort curves.
 */
export function selectCohortThresholds(trades = []) {
  const sizes = trades.map(tr => num(tr.quoteUsd)).filter(v => v > 0).sort((a, b) => a - b);
  const p99 = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.99))] : 100_000;
  if (p99 >= 60_000) {
    return {
      mode: 'MAJOR',
      t1: 1_000,
      t2: 10_000,
      t3: 100_000,
      labels: { retail: '<$1K', mid: '$1K~$10K', large: '$10K~$100K', whale: '$100K+' },
    };
  }
  if (p99 >= 15_000) {
    return {
      mode: 'ALT',
      t1: 500,
      t2: 5_000,
      t3: 25_000,
      labels: { retail: '<$500', mid: '$500~$5K', large: '$5K~$25K', whale: '$25K+' },
    };
  }
  return {
    mode: 'SMALL_CAP',
    t1: 200,
    t2: 1_500,
    t3: 8_000,
    labels: { retail: '<$200', mid: '$200~$1.5K', large: '$1.5K~$8K', whale: '$8K+' },
  };
}

/**
 * Build 100% REAL individual-trade 4-cohort CVD series from signed exchange ticks.
 */
export function buildTradeCohortSeries(trades = [], { buckets = 60, thresholds = null } = {}) {
  const clean = [...trades]
    .map(tr => ({
      t: num(tr.t),
      price: num(tr.price),
      quoteUsd: Math.abs(num(tr.quoteUsd)),
      isBuy: Boolean(tr.isBuy),
    }))
    .filter(tr => tr.t > 0 && tr.price > 0 && tr.quoteUsd > 0)
    .sort((a, b) => a.t - b.t);

  const th = thresholds || selectCohortThresholds(clean);
  if (clean.length < 4) {
    return { cohortMode: 'REAL_TRADES', tradeCount: clean.length, thresholds: th, ...normalizeCohortSeries([]) };
  }

  const tMin = clean[0].t, tMax = clean.at(-1).t;
  const span = Math.max(1, tMax - tMin);
  const nBins = Math.min(buckets, Math.max(12, Math.floor(clean.length / 4)));
  const binStep = span / nBins;

  const cum = { retail: 0, mid: 0, large: 0, whale: 0 };
  const pts = [];
  let idx = 0;
  let lastPx = clean[0].price;

  for (let b = 0; b < nBins; b++) {
    const endT = b === nBins - 1 ? tMax + 1 : tMin + (b + 1) * binStep;
    while (idx < clean.length && clean[idx].t < endT) {
      const tr = clean[idx++];
      lastPx = tr.price;
      const signed = tr.isBuy ? tr.quoteUsd : -tr.quoteUsd;
      if (tr.quoteUsd >= th.t3) cum.whale += signed;
      else if (tr.quoteUsd >= th.t2) cum.large += signed;
      else if (tr.quoteUsd >= th.t1) cum.mid += signed;
      else cum.retail += signed;
    }
    pts.push({
      t: Math.round(b === nBins - 1 ? tMax : tMin + (b + 0.5) * binStep),
      price: lastPx,
      retail: cum.retail,
      mid: cum.mid,
      large: cum.large,
      whale: cum.whale,
    });
  }

  return {
    cohortMode: 'REAL_TRADES',
    tradeCount: clean.length,
    spanSec: Math.round(span / 1000),
    thresholds: th,
    ...normalizeCohortSeries(pts),
  };
}

/**
 * Build bar-intensity-decomposed 4-cohort CVD series for multi-day historical views (1D / 1W / 1M).
 * Uses each candle's real taker delta, quote volume, and (when available) Binance trade count (avg trade size)
 * to separate calm retail flow from high-volume whale block impulses (stepped red line).
 */
export function buildHistoricalCohortSeries(candles = []) {
  const th = {
    mode: 'HISTORICAL_ESTIMATE',
    labels: { retail: '소액 추정', mid: '중형 추정', large: '대형 추정', whale: '고래 추정(임펄스)' },
  };
  if (!Array.isArray(candles) || candles.length < 4) {
    return { cohortMode: 'ESTIMATED_BY_BAR_SIZE', tradeCount: 0, thresholds: th, ...normalizeCohortSeries([]) };
  }

  const vols = candles.map(c => Math.max(1, num(c.q) || num(c.buyVol) + num(c.sellVol)));
  const sortedVols = [...vols].sort((a, b) => a - b);
  const medVol = sortedVols[Math.floor(sortedVols.length / 2)] || 1;
  const avgTradeSizes = candles.map(c => (num(c.trades) > 0 && num(c.q) > 0 ? num(c.q) / num(c.trades) : null));
  const validSizes = avgTradeSizes.filter(v => v != null).sort((a, b) => a - b);
  const medTradeSize = validSizes.length ? validSizes[Math.floor(validSizes.length / 2)] : null;

  const cum = { retail: 0, mid: 0, large: 0, whale: 0 };
  const pts = candles.map((c, i) => {
    const delta = num(c.delta) || (num(c.buyVol) - num(c.sellVol));
    const volRatio = vols[i] / medVol;
    const sizeRatio = medTradeSize && avgTradeSizes[i] != null ? avgTradeSizes[i] / medTradeSize : volRatio;
    const intensity = 0.55 * volRatio + 0.45 * sizeRatio;

    // Decompose bar taker delta across 4 tiers:
    // - Calm bars: dominated by retail/mid flow
    // - Spikes (>= 1.85x intensity): trigger distinct stepped whale impulses!
    let wWhale = intensity >= 1.85 ? Math.min(0.42, (intensity - 1.55) * 0.22) : 0;
    let wLarge = intensity >= 1.15 ? Math.min(0.36, 0.14 + (intensity - 1.0) * 0.14) : 0.08;
    let wMid = 0.28;
    let wRetail = Math.max(0.12, 1 - wWhale - wLarge - wMid);
    const sumW = wWhale + wLarge + wMid + wRetail;
    wWhale /= sumW; wLarge /= sumW; wMid /= sumW; wRetail /= sumW;

    cum.retail += delta * wRetail;
    cum.mid += delta * wMid;
    cum.large += delta * wLarge;
    if (wWhale > 0) cum.whale += delta * wWhale;

    return {
      t: num(c.t),
      price: num(c.c),
      retail: cum.retail,
      mid: cum.mid,
      large: cum.large,
      whale: cum.whale,
    };
  });

  return {
    cohortMode: 'ESTIMATED_BY_BAR_SIZE',
    tradeCount: candles.reduce((a, c) => a + num(c.trades), 0),
    thresholds: th,
    ...normalizeCohortSeries(pts),
  };
}

/**
 * Build FireCharts-style Liquidity Heatmap:
 * - Horizontal resting liquidity shelves from historical high-volume bars (until swept by price)
 * - Real server-recorded L2 orderbook wall snapshots layered at exact timestamps
 * - Live L2 orderbook bid/ask walls on the right edge (100% real resting limit orders)
 * - Exact percentile rank (0..100) on every cell for instant client-side Volume Percentiles filtering!
 */
export function buildLiquidityHeatmap({ candles = [], orderbook = null, snapshots = [], priceBins = 96 }) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return { minPrice: 0, maxPrice: 0, candleMinPrice: 0, candleMaxPrice: 0, priceBins, minUsd: 0, maxUsd: 0, cells: [], liveWalls: [], snapshotCount: 0, hasLiveBook: false };
  }

  const n = candles.length;
  const tStart = num(candles[0].t);
  const tEnd = num(candles.at(-1).t);
  const tSpan = Math.max(1, tEnd - tStart);
  const lastPx = num(candles.at(-1).c);

  const candleMinP = Math.min(...candles.map(c => num(c.l) || num(c.c)));
  const candleMaxP = Math.max(...candles.map(c => num(c.h) || num(c.c)));
  const cSpan = Math.max(candleMaxP - candleMinP, lastPx * 0.02);
  // Wide master collection span covering up to 'ultra' zoom (±60% / 1.65x range) so client zoom never loses L2 walls
  const pad = Math.max(cSpan * 1.65, lastPx * 0.60);
  let minP = Math.max(lastPx > 0 ? lastPx * 0.12 : 1e-12, candleMinP - pad);
  let maxP = candleMaxP + pad;
  const pSpan = Math.max(1e-12, maxP - minP);
  const binOf = px => Math.max(0, Math.min(priceBins - 1, Math.floor(((px - minP) / pSpan) * priceBins)));
  const priceOfBin = b => minP + ((b + 0.5) / priceBins) * pSpan;

  const rawCells = [];

  // 1) Historical horizontal liquidity shelves (from upper/lower high-volume bands until price sweeps them)
  const vols = candles.map(c => Math.max(1, num(c.q) || num(c.v) * num(c.c)));
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const q = vols[i];
    if (q < avgVol * 0.55) continue;
    const targets = [
      { px: num(c.h), side: 'ASK', share: 0.45 },
      { px: num(c.l), side: 'BID', share: 0.45 },
    ];
    for (const tg of targets) {
      if (!(tg.px >= minP && tg.px <= maxP)) continue;
      const bIdx = binOf(tg.px);
      // Shelf persists horizontally from bar i until swept by a subsequent candle's range
      let endIdx = n - 1;
      for (let j = i + 1; j < n; j++) {
        if (tg.side === 'ASK' && num(candles[j].h) > tg.px * 1.0015) { endIdx = j; break; }
        if (tg.side === 'BID' && num(candles[j].l) < tg.px * 0.9985) { endIdx = j; break; }
      }
      if (endIdx - i < 2) continue;
      rawCells.push({
        x0: round(i / Math.max(1, n - 1), 4),
        x1: round(endIdx / Math.max(1, n - 1), 4),
        yBin: bIdx,
        price: Number(priceOfBin(bIdx).toPrecision(6)),
        usd: Math.round(q * tg.share * 0.18),
        side: tg.side,
        live: false,
      });
    }
  }

  // 2) Real server-recorded L2 orderbook snapshots mapped into the timeline
  let snapshotCount = 0;
  for (const snap of snapshots || []) {
    if (!snap || snap.t < tStart || snap.t > tEnd + 300_000) continue;
    snapshotCount++;
    const x0 = round(Math.max(0, Math.min(0.96, (snap.t - tStart) / tSpan)), 4);
    const x1 = round(Math.min(1, x0 + 0.045), 4);
    const binTotals = new Map();
    for (const sideKey of ['asks', 'bids']) {
      const side = sideKey === 'asks' ? 'ASK' : 'BID';
      for (const lv of snap[sideKey] || []) {
        if (lv.p < minP || lv.p > maxP || !(lv.usd > 0)) continue;
        const k = `${binOf(lv.p)}|${side}`;
        binTotals.set(k, (binTotals.get(k) || 0) + lv.usd);
      }
    }
    for (const [k, usd] of binTotals.entries()) {
      const [bStr, side] = k.split('|');
      const bIdx = Number(bStr);
      rawCells.push({
        x0,
        x1,
        yBin: bIdx,
        price: Number(priceOfBin(bIdx).toPrecision(6)),
        usd: Math.round(usd),
        side,
        live: true,
      });
    }
  }

  // 3) Live L2 orderbook resting walls (rightmost 10% glow band — 100% real current orderbook!)
  const liveBinMap = new Map();
  const hasLiveBook = Boolean(orderbook && (orderbook.bids?.length || orderbook.asks?.length));
  if (hasLiveBook) {
    for (const sideKey of ['asks', 'bids']) {
      const side = sideKey === 'asks' ? 'ASK' : 'BID';
      for (const lv of orderbook[sideKey] || []) {
        const p = num(lv.p), usd = num(lv.usd);
        if (p < minP || p > maxP || !(usd > 0)) continue;
        const bIdx = binOf(p);
        const k = `${bIdx}|${side}`;
        liveBinMap.set(k, (liveBinMap.get(k) || 0) + usd);
      }
    }
    for (const [k, usd] of liveBinMap.entries()) {
      const [bStr, side] = k.split('|');
      const bIdx = Number(bStr);
      rawCells.push({
        x0: 0.90,
        x1: 1.0,
        yBin: bIdx,
        price: Number(priceOfBin(bIdx).toPrecision(6)),
        usd: Math.round(usd),
        side,
        live: true,
      });
    }
  }

  // Assign exact percentile rank (0..100) across all liquidity cells
  const sortedUsd = rawCells.map(c => c.usd).filter(v => v > 0).sort((a, b) => a - b);
  const rankOf = usd => {
    if (!sortedUsd.length) return 0;
    let lo = 0, hi = sortedUsd.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedUsd[m] <= usd) lo = m + 1; else hi = m; }
    return Math.min(99.9, Math.max(0, round((lo / sortedUsd.length) * 100, 1)));
  };

  // Deduplicate overlapping identical (x0,x1,yBin) and keep strongest
  const cells = rawCells
    .filter(c => c.usd > 0)
    .map(c => ({ ...c, pctRank: rankOf(c.usd) }))
    .sort((a, b) => a.usd - b.usd)
    .slice(-420);

  const liveWalls = cells
    .filter(c => c.live && c.x1 >= 0.99)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 24);

  const pAt = q => sortedUsd.length ? sortedUsd[Math.min(sortedUsd.length - 1, Math.floor(sortedUsd.length * q))] : 0;

  return {
    minPrice: Number(minP.toPrecision(6)),
    maxPrice: Number(maxP.toPrecision(6)),
    candleMinPrice: Number(candleMinP.toPrecision(6)),
    candleMaxPrice: Number(candleMaxP.toPrecision(6)),
    priceBins,
    minUsd: sortedUsd[0] || 0,
    maxUsd: sortedUsd.at(-1) || 0,
    p80Usd: pAt(0.80),
    p93Usd: pAt(0.93),
    p99Usd: pAt(0.99),
    cells,
    liveWalls,
    snapshotCount,
    hasLiveBook,
  };
}

async function fetchJson(url, { fetcher = fetch, timeoutMs = 4500 } = {}) {
  const res = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'SignalLab/1.0', Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`HTTP_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Fetch real L2 orderbook depth + (optionally) 1,000 real signed trades from Binance (primary)
 * or Gate.io / BingX fallback.
 */
export async function fetchFirechartExtras(symbol, {
  gateContract,
  bingxSymbol,
  needTrades = false,
  skipBinance = false,
  fetcher = fetch,
  binanceBase = 'https://fapi.binance.com',
  gateBase = 'https://api.gateio.ws',
  bingxBase = 'https://open-api.bingx.com',
} = {}) {
  let orderbook = null;
  let trades = [];
  let source = null;

  // 1) Try Binance Futures (1000-level depth + 1000 aggTrades)
  if (!skipBinance) {
    try {
      const [depth, agg] = await Promise.all([
        fetchJson(`${binanceBase}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`, { fetcher, timeoutMs: 3800 }),
        needTrades
          ? fetchJson(`${binanceBase}/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`, { fetcher, timeoutMs: 4000 }).catch(() => [])
          : Promise.resolve([]),
      ]);
      if (depth && (Array.isArray(depth.bids) || Array.isArray(depth.asks))) {
        orderbook = {
          bids: (depth.bids || []).map(([p, q]) => ({ p: num(p), usd: num(p) * num(q) })),
          asks: (depth.asks || []).map(([p, q]) => ({ p: num(p), usd: num(p) * num(q) })),
        };
        source = 'BINANCE';
      }
      if (Array.isArray(agg) && agg.length) {
        trades = agg.map(tr => ({
          t: num(tr.T),
          price: num(tr.p),
          quoteUsd: num(tr.p) * num(tr.q),
          isBuy: !tr.m, // m=true means buyer was maker -> aggressive seller
        }));
      }
    } catch {}
  }

  // 2) Fallback: Gate.io Futures (200-level depth + 1000 signed trades)
  if (!orderbook && gateContract) {
    try {
      const [depth, rawTrades, contractInfo] = await Promise.all([
        fetchJson(`${gateBase}/api/v4/futures/usdt/order_book?contract=${encodeURIComponent(gateContract)}&limit=200`, { fetcher, timeoutMs: 4200 }),
        needTrades
          ? fetchJson(`${gateBase}/api/v4/futures/usdt/trades?contract=${encodeURIComponent(gateContract)}&limit=1000`, { fetcher, timeoutMs: 4500 }).catch(() => [])
          : Promise.resolve([]),
        fetchJson(`${gateBase}/api/v4/futures/usdt/contracts/${encodeURIComponent(gateContract)}`, { fetcher, timeoutMs: 3500 }).catch(() => ({})),
      ]);
      const quanto = num(contractInfo?.quanto_multiplier, 1) || 1;
      if (depth && (Array.isArray(depth.bids) || Array.isArray(depth.asks))) {
        orderbook = {
          bids: (depth.bids || []).map(x => ({ p: num(x.p), usd: Math.abs(num(x.s)) * quanto * num(x.p) })),
          asks: (depth.asks || []).map(x => ({ p: num(x.p), usd: Math.abs(num(x.s)) * quanto * num(x.p) })),
        };
        source = 'GATEIO';
      }
      if (Array.isArray(rawTrades) && rawTrades.length) {
        trades = rawTrades.map(tr => {
          const sz = num(tr.size);
          const p = num(tr.price);
          return {
            t: Math.round(num(tr.create_time_ms || tr.create_time) * (num(tr.create_time_ms) > 1e11 ? 1 : 1000)),
            price: p,
            quoteUsd: Math.abs(sz) * quanto * p,
            isBuy: sz > 0,
          };
        });
      }
    } catch {}
  }

  // 3) Final Fallback: BingX Swap (500-level depth + 100 trades)
  if (!orderbook && bingxSymbol) {
    try {
      const [depthRes, trRes] = await Promise.all([
        fetchJson(`${bingxBase}/openApi/swap/v2/quote/depth?symbol=${encodeURIComponent(bingxSymbol)}&limit=500`, { fetcher, timeoutMs: 4200 }),
        needTrades
          ? fetchJson(`${bingxBase}/openApi/swap/v2/quote/trades?symbol=${encodeURIComponent(bingxSymbol)}&limit=100`, { fetcher, timeoutMs: 4000 }).catch(() => ({}))
          : Promise.resolve({}),
      ]);
      const d = depthRes?.data;
      if (d && (Array.isArray(d.bids) || Array.isArray(d.asks))) {
        orderbook = {
          bids: (d.bids || []).map(([p, q]) => ({ p: num(p), usd: num(p) * num(q) })),
          asks: (d.asks || []).map(([p, q]) => ({ p: num(p), usd: num(p) * num(q) })),
        };
        source = 'BINGX';
      }
      if (Array.isArray(trRes?.data) && trRes.data.length) {
        trades = trRes.data.map(tr => ({
          t: num(tr.time || tr.ts),
          price: num(tr.price),
          quoteUsd: num(tr.quoteQty) || num(tr.price) * num(tr.qty),
          isBuy: !tr.isBuyerMaker,
        }));
      }
    } catch {}
  }

  if (orderbook) recordOrderbookSnapshot(symbol, orderbook);
  return { orderbook, trades, source, snapshots: getOrderbookSnapshots(symbol) };
}
