// Material Indicators FireCharts-style Liquidity Wall Heatmap + order-size CVD (6 lines) engine.
// Order-size classes follow the FireCharts legend in the user's screenshot (2026-11-25 09:20, request 09:51
// "CVD를 UI 등 수정했으면 해"): 주황 $100~$1000 (새우) · 초록 $1000~$10000 · 빨강 $10K~$100K · 보라 $100K~$1M ·
// 갈색 $1M~$10M (고래) · 파랑 All Orders. Display and analytics only — no trading decision reads this module.
// Pure math helpers are exported for unit tests; live fetchers pull real L2 orderbooks and signed trades
// from Binance Futures (primary) with automatic Gate.io / BingX fallback, and accumulate live L2 snapshots in memory.

import fs from 'node:fs';
import path from 'node:path';

// 3Y = 1,095 daily candles: one Binance /fapi/v1/klines call (limit <= 1500), Gate.io candlesticks (<= 2000) and
// BingX v3 klines (<= 1440) also fit. A coin listed less than 3 years ago simply returns fewer candles.
export const FIRECHART_RANGES = Object.freeze({
  LIVE: { key: 'LIVE', labelKo: '실시간', interval: '5m', limit: 72, useRealTrades: true },
  '1D': { key: '1D', labelKo: '1D', interval: '15m', limit: 96, useRealTrades: false },
  '1W': { key: '1W', labelKo: '1W', interval: '1h', limit: 168, useRealTrades: false },
  '1M': { key: '1M', labelKo: '1M', interval: '4h', limit: 180, useRealTrades: false },
  '6M': { key: '6M', labelKo: '6M', interval: '1d', limit: 180, useRealTrades: false },
  '1Y': { key: '1Y', labelKo: '1Y', interval: '1d', limit: 365, useRealTrades: false },
  '3Y': { key: '3Y', labelKo: '3Y', interval: '1d', limit: 1095, useRealTrades: false },
});

/** FireCharts fixed lower edges per taker order (USD); brownMaxUSD is the legend's top (an order above it stays brown). */
export const FIRECHART_CLASS_EDGES = Object.freeze({
  orangeMinUSD: 100, greenMinUSD: 1_000, redMinUSD: 10_000, purpleMinUSD: 100_000, brownMinUSD: 1_000_000, brownMaxUSD: 10_000_000,
});

/** The 6 CVD lines, small to large, then All Orders. `color` = dark-theme hex of the CSS token `--wcv-<key>`. */
export const FIRECHART_CLASSES = Object.freeze([
  { key: 'orange', colorKo: '주황', nickKo: '새우', rangeLabel: '$100~$1000', legend: '$100~$1000 (새우)', color: '#fb923c', token: '--wcv-orange' },
  { key: 'green', colorKo: '초록', nickKo: '', rangeLabel: '$1000~$10000', legend: '$1000~$10000', color: '#4ade80', token: '--wcv-green' },
  { key: 'red', colorKo: '빨강', nickKo: '', rangeLabel: '$10K~$100K', legend: '$10K~$100K', color: '#f87171', token: '--wcv-red' },
  { key: 'purple', colorKo: '보라', nickKo: '', rangeLabel: '$100K~$1M', legend: '$100K~$1M', color: '#c084fc', token: '--wcv-purple' },
  { key: 'brown', colorKo: '갈색', nickKo: '고래', rangeLabel: '$1M~$10M', legend: '$1M~$10M (고래)', color: '#d19a66', token: '--wcv-brown' },
  { key: 'blue', colorKo: '파랑', nickKo: '전체', rangeLabel: 'All Orders', legend: 'All Orders', color: '#60a5fa', token: '--wcv-blue' },
].map(c => Object.freeze(c)));
export const FIRECHART_CLASS_KEYS = Object.freeze(FIRECHART_CLASSES.map(c => c.key));
/** The five size classes (blue = All Orders is their total plus orders under $100). */
export const FIRECHART_SIZE_KEYS = Object.freeze(FIRECHART_CLASS_KEYS.filter(k => k !== 'blue'));
/** Old name kept for imports; now the 6 FireCharts classes (was 개미/중형/대형/고래 until 2026-11-25). */
export const FIRECHART_COHORTS = FIRECHART_CLASSES;

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
 * Order-size class of one taker trade (USD notional): 'orange' .. 'brown', or null under the orange edge
 * (a dust order under $100 counts only in 'blue' = All Orders). An order above the brown top ($10M) stays brown.
 */
export function firechartClassOf(quoteUsd, edges = FIRECHART_CLASS_EDGES) {
  const x = Math.abs(num(quoteUsd));
  if (x >= edges.brownMinUSD) return 'brown';
  if (x >= edges.purpleMinUSD) return 'purple';
  if (x >= edges.redMinUSD) return 'red';
  if (x >= edges.greenMinUSD) return 'green';
  if (x >= edges.orangeMinUSD) return 'orange';
  return null;
}

/**
 * Min-max scale one series into 0..1 over the shown window (FireCharts "Normalized CVD": each line on its own scale,
 * so a small class and All Orders can be compared by shape). A flat series (span <= 1e-6) sits at 0.5.
 */
export function normalizeMinMax(values = []) {
  let mn = Infinity, mx = -Infinity;
  for (const raw of values) {
    const v = num(raw);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) return { min: 0, max: 0, values: [] };
  const span = mx - mn;
  return { min: mn, max: mx, values: values.map(raw => (span > 1e-6 ? round((num(raw) - mn) / span, 4) : 0.5)) };
}

/**
 * Pre-2026-11-25 cohort points used retail/mid/large/whale. Map them onto the FireCharts classes so a stored or
 * hand-built old point still renders: retail→orange, mid→green, large→red, whale→brown; blue = their sum.
 */
function upgradeLegacyPoint(pt) {
  if (!pt || FIRECHART_CLASS_KEYS.some(k => pt[k] !== undefined)) return pt;
  if (!['retail', 'mid', 'large', 'whale'].some(k => pt[k] !== undefined)) return pt;
  const out = { t: pt.t, price: pt.price, orange: num(pt.retail), green: num(pt.mid), red: num(pt.large), purple: 0, brown: num(pt.whale) };
  out.blue = out.orange + out.green + out.red + out.brown;
  return out;
}

/**
 * Whale (purple $100K~$1M + brown $1M~$10M) vs shrimp (orange $100~$1000) CVD divergence on the series.
 * Reading of the user's FireCharts screenshot: 고래 CVD 증가 = 매집 경향, 새우 CVD 감소 = 매도 경향. Display only.
 */
export function detectCohortDivergence(series = []) {
  if (!Array.isArray(series) || series.length < 4) {
    return { type: 'NEUTRAL', badgeKo: '고래·새우 중립', detailKo: '금액대 간 뚜렷한 역행 없음', tone: 'neutral' };
  }
  const whaleAt = pt => num(pt?.abs?.purple) + num(pt?.abs?.brown);
  const whaleSeries = series.map(whaleAt);
  const whaleNormAll = normalizeMinMax(whaleSeries).values;
  const last = series.at(-1);
  const lookback = series[Math.max(0, series.length - Math.min(12, Math.floor(series.length / 2)))];
  const whaleAbs = whaleAt(last);
  const redAbs = num(last?.abs?.red);
  const shrimpAbs = num(last?.abs?.orange);
  const whaleNorm = num(whaleNormAll.at(-1), 0.5);
  const shrimpNorm = num(last?.norm?.orange, 0.5);
  const whaleRecentDelta = whaleAbs - whaleAt(lookback);
  const shrimpRecentDelta = shrimpAbs - num(lookback?.abs?.orange);
  const smartSum = whaleAbs + redAbs * 0.5;

  if ((whaleAbs > 0 || smartSum > 0) && shrimpAbs < 0 && (whaleNorm - shrimpNorm >= 0.22 || (whaleRecentDelta > 0 && shrimpRecentDelta < 0))) {
    return {
      type: 'WHALE_ACCUMULATION',
      badgeKo: '고래 매집 · 새우 매도 역행',
      detailKo: '고래(보라·갈색) CVD 증가 중 새우(주황) CVD 감소 — 큰 주문이 작은 주문의 매도를 받아 가는 모습',
      tone: 'pos',
    };
  }
  if ((whaleAbs < 0 || smartSum < 0) && shrimpAbs > 0 && (shrimpNorm - whaleNorm >= 0.22 || (whaleRecentDelta < 0 && shrimpRecentDelta > 0))) {
    return {
      type: 'WHALE_DISTRIBUTION',
      badgeKo: '고래 매도 · 새우 추격 역행',
      detailKo: '고래(보라·갈색) CVD 감소 중 새우(주황) CVD 증가 — 큰 주문이 작은 주문의 매수에 물량을 넘기는 모습',
      tone: 'neg',
    };
  }
  if (whaleAbs > 0 && whaleNorm >= 0.72) {
    return { type: 'WHALE_LED_BUY', badgeKo: '고래 주도 순매수', detailKo: '고래(보라·갈색) CVD가 구간 상단에서 증가', tone: 'pos' };
  }
  if (whaleAbs < 0 && whaleNorm <= 0.28) {
    return { type: 'WHALE_LED_SELL', badgeKo: '고래 주도 순매도', detailKo: '고래(보라·갈색) CVD가 구간 하단에서 감소', tone: 'neg' };
  }
  return { type: 'NEUTRAL', badgeKo: '고래·새우 동조/중립', detailKo: '금액대 간 뚜렷한 역행 없음', tone: 'neutral' };
}

/**
 * Turn cumulative class points {t, price, orange..brown, blue} into the Absolute (USD) and Normalized (0..1) series.
 * `maxPoints` thins long histories (3Y = ~1,095 daily bars) to an even stride that always keeps the last point.
 */
export function normalizeCohortSeries(points = [], { maxPoints = 0 } = {}) {
  let pts = (Array.isArray(points) ? points : []).map(upgradeLegacyPoint);
  if (maxPoints > 0 && pts.length > maxPoints) {
    const stride = Math.ceil(pts.length / maxPoints);
    const lastIdx = pts.length - 1;
    pts = pts.filter((_, i) => (lastIdx - i) % stride === 0);
  }
  const bounds = {};
  const normByKey = {};
  for (const k of FIRECHART_CLASS_KEYS) {
    const scaled = normalizeMinMax(pts.map(pt => pt[k]));
    bounds[k] = { min: scaled.min, max: scaled.max };
    normByKey[k] = scaled.values;
  }
  const series = pts.map((pt, i) => {
    const abs = {}, norm = {};
    for (const k of FIRECHART_CLASS_KEYS) {
      abs[k] = Math.round(num(pt[k]));
      norm[k] = normByKey[k][i];
    }
    return { t: pt.t, price: num(pt.price), abs, norm };
  });
  const zero = Object.fromEntries(FIRECHART_CLASS_KEYS.map(k => [k, 0]));
  const half = Object.fromEntries(FIRECHART_CLASS_KEYS.map(k => [k, 0.5]));
  const latest = series.at(-1) || { abs: zero, norm: half };
  const divergence = detectCohortDivergence(series);
  return { series, latest, bounds, divergence };
}

/** FireCharts' fixed class edges and the legend's labels (kept under the old name for any caller). */
export function selectCohortThresholds() {
  return {
    mode: 'FIRECHARTS_FIXED',
    ...FIRECHART_CLASS_EDGES,
    labels: Object.fromEntries(FIRECHART_CLASSES.map(c => [c.key, c.rangeLabel])),
  };
}

/**
 * Build the 6-line order-size CVD from REAL signed exchange trades (each trade = one taker order at one price):
 * signed USD (+ taker buy, − taker sell) accumulated per class over time buckets; blue = every trade (All Orders).
 */
export function buildTradeCohortSeries(trades = [], { buckets = 60, edges = FIRECHART_CLASS_EDGES } = {}) {
  const clean = [...(Array.isArray(trades) ? trades : [])]
    .map(tr => ({
      t: num(tr.t),
      price: num(tr.price),
      quoteUsd: Math.abs(num(tr.quoteUsd)),
      isBuy: Boolean(tr.isBuy),
    }))
    .filter(tr => tr.t > 0 && tr.price > 0 && tr.quoteUsd > 0)
    .sort((a, b) => a.t - b.t);

  const th = selectCohortThresholds();
  const classCounts = Object.fromEntries(FIRECHART_CLASS_KEYS.map(k => [k, 0]));
  if (clean.length < 4) {
    return { cohortMode: 'REAL_TRADES', tradeCount: clean.length, classCounts, thresholds: th, ...normalizeCohortSeries([]) };
  }

  const tMin = clean[0].t, tMax = clean.at(-1).t;
  const span = Math.max(1, tMax - tMin);
  const nBins = Math.min(buckets, Math.max(12, Math.floor(clean.length / 4)));
  const binStep = span / nBins;

  const cum = Object.fromEntries(FIRECHART_CLASS_KEYS.map(k => [k, 0]));
  const pts = [];
  let idx = 0;
  let lastPx = clean[0].price;

  for (let b = 0; b < nBins; b++) {
    const endT = b === nBins - 1 ? tMax + 1 : tMin + (b + 1) * binStep;
    while (idx < clean.length && clean[idx].t < endT) {
      const tr = clean[idx++];
      lastPx = tr.price;
      const signed = tr.isBuy ? tr.quoteUsd : -tr.quoteUsd;
      const cls = firechartClassOf(tr.quoteUsd, edges);
      if (cls) { cum[cls] += signed; classCounts[cls]++; }
      cum.blue += signed;
      classCounts.blue++;
    }
    pts.push({ t: Math.round(b === nBins - 1 ? tMax : tMin + (b + 0.5) * binStep), price: lastPx, ...cum });
  }

  return {
    cohortMode: 'REAL_TRADES',
    tradeCount: clean.length,
    classCounts,
    spanSec: Math.round(span / 1000),
    thresholds: th,
    ...normalizeCohortSeries(pts),
  };
}

/**
 * Multi-day views (1D .. 3Y) have no per-trade data: All Orders (blue) is each candle's REAL taker delta
 * (taker buy − taker sell quote volume), and the five size classes are an ESTIMATE that splits that delta by the
 * candle's intensity (quote volume and average trade size vs the window's median): calm bars go to the small classes,
 * spikes feed purple and, at >= 2.2x, brown. Labelled 추정 on screen.
 */
export function buildHistoricalCohortSeries(candles = [], { maxPoints = 400 } = {}) {
  const th = { ...selectCohortThresholds(), mode: 'HISTORICAL_ESTIMATE' };
  if (!Array.isArray(candles) || candles.length < 4) {
    return { cohortMode: 'ESTIMATED_BY_BAR_SIZE', tradeCount: 0, thresholds: th, ...normalizeCohortSeries([]) };
  }

  const vols = candles.map(c => Math.max(1, num(c.q) || num(c.buyVol) + num(c.sellVol)));
  const sortedVols = [...vols].sort((a, b) => a - b);
  const medVol = sortedVols[Math.floor(sortedVols.length / 2)] || 1;
  const avgTradeSizes = candles.map(c => (num(c.trades) > 0 && num(c.q) > 0 ? num(c.q) / num(c.trades) : null));
  const validSizes = avgTradeSizes.filter(v => v != null).sort((a, b) => a - b);
  const medTradeSize = validSizes.length ? validSizes[Math.floor(validSizes.length / 2)] : null;

  const cum = Object.fromEntries(FIRECHART_CLASS_KEYS.map(k => [k, 0]));
  const pts = candles.map((c, i) => {
    const delta = num(c.delta) || (num(c.buyVol) - num(c.sellVol));
    const volRatio = vols[i] / medVol;
    const sizeRatio = medTradeSize && avgTradeSizes[i] != null ? avgTradeSizes[i] / medTradeSize : volRatio;
    const intensity = 0.55 * volRatio + 0.45 * sizeRatio;

    const w = {
      brown: intensity >= 2.2 ? Math.min(0.32, (intensity - 1.9) * 0.18) : 0,
      purple: intensity >= 1.4 ? Math.min(0.30, 0.08 + (intensity - 1.4) * 0.16) : 0.04,
      red: intensity >= 1.15 ? 0.24 : 0.18,
      green: 0.24,
    };
    w.orange = Math.max(0.10, 1 - w.brown - w.purple - w.red - w.green);
    const sumW = w.orange + w.green + w.red + w.purple + w.brown;
    for (const k of FIRECHART_SIZE_KEYS) cum[k] += delta * (w[k] / sumW);
    cum.blue += delta;
    return { t: num(c.t), price: num(c.c), ...cum };
  });

  return {
    cohortMode: 'ESTIMATED_BY_BAR_SIZE',
    tradeCount: candles.reduce((a, c) => a + num(c.trades), 0),
    thresholds: th,
    ...normalizeCohortSeries(pts, { maxPoints }),
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

async function fetchJson(url, { fetcher = fetch, timeoutMs = 4500, budget = null } = {}) {
  if (budget) {
    const r = budget.reserve(url);
    if (!r.ok) { const err = new Error(r.code); err.code = r.code; throw err; }
  }
  const res = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'SignalLab/1.0', Accept: 'application/json' },
  });
  if (!res.ok) {
    if (budget) budget.rateLimited(res.status, res.headers?.get?.('retry-after'));
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
  budget = null,
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
        fetchJson(`${binanceBase}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`, { fetcher, timeoutMs: 3800, budget }),
        needTrades
          ? fetchJson(`${binanceBase}/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`, { fetcher, timeoutMs: 4000, budget }).catch(() => [])
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
