// Per-symbol Derivatives Orderflow & Estimated Liquidation Map engine.
// Primary: Binance Futures public API (deepest global liquidity; works directly in KR/EU/Asia).
// Automatic fallback: Gate.io Futures contract_stats (exact 5m taker buy/sell, OI, L/S, real liquidations)
// and BingX Swap public endpoints (covers BingX-only altcoins & geo-restricted environments).

import {
  FIRECHART_RANGES,
  buildTradeCohortSeries,
  buildHistoricalCohortSeries,
  buildLiquidityHeatmap,
  fetchFirechartExtras,
} from './firechart.mjs';

const VALID_INTERVALS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 });
const GATE_INTERVALS = Object.freeze({ '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' });
const CACHE_TTL_MS = 30_000;
const BINANCE_BLOCK_TTL_MS = 10 * 60_000;

const cache = new Map();
let binanceBlockedUntil = 0;

export function normalizeOrderflowSymbol(raw) {
  let s = String(raw || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

export function gateContractFor(symbol) {
  const s = normalizeOrderflowSymbol(symbol);
  const base = s.slice(0, -4);
  if (base === '1000PEPE') return 'PEPE_USDT';
  if (base === '1000SHIB') return 'SHIB_USDT';
  if (base === '1000FLOKI') return 'FLOKI_USDT';
  if (base === '1000BONK') return 'BONK_USDT';
  if (base === '1000LUNC') return 'LUNC_USDT';
  return `${base}_USDT`;
}

export function bingxSymbolFor(symbol) {
  const s = normalizeOrderflowSymbol(symbol);
  return `${s.slice(0, -4)}-USDT`;
}

const num = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const round = (v, d = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Detect Price vs CVD divergence across the recent bar window.
 * Compares the earlier half vs recent half swings + latest reversal bar taker imbalance.
 */
export function detectCvdDivergence(series) {
  if (!Array.isArray(series) || series.length < 12) {
    return { type: 'NONE', labelKo: '다이버전스 없음', detailKo: '데이터 누적 중' };
  }
  const win = series.slice(-24);
  const mid = Math.floor(win.length / 2);
  const prev = win.slice(0, mid);
  const recent = win.slice(mid);

  const prevLowBar = prev.reduce((a, b) => (b.l < a.l ? b : a), prev[0]);
  const recLowBar = recent.reduce((a, b) => (b.l < a.l ? b : a), recent[0]);
  const prevHighBar = prev.reduce((a, b) => (b.h > a.h ? b : a), prev[0]);
  const recHighBar = recent.reduce((a, b) => (b.h > a.h ? b : a), recent[0]);

  const last = win.at(-1);
  const cvdRange = Math.max(...win.map(x => x.cvd)) - Math.min(...win.map(x => x.cvd));
  const minCvdDiff = cvdRange > 0 ? cvdRange * 0.06 : 0;

  // Bullish divergence: price made a lower low (or tested within -0.15%) while CVD held meaningfully higher
  if (recLowBar.l <= prevLowBar.l * 0.9985 && recLowBar.cvd > prevLowBar.cvd + minCvdDiff) {
    return {
      type: 'BULLISH',
      labelKo: '강세 CVD 다이버전스 (저점 매집)',
      detailKo: '가격은 저점을 갱신했으나 누적 매수 델타(CVD)는 저점을 높이며 매집 흔적 포착',
    };
  }
  // Bearish divergence: price made a higher high while CVD failed to make a higher high
  if (recHighBar.h >= prevHighBar.h * 1.0015 && recHighBar.cvd < prevHighBar.cvd - minCvdDiff) {
    return {
      type: 'BEARISH',
      labelKo: '약세 CVD 다이버전스 (고점 분산)',
      detailKo: '가격은 고점을 갱신했으나 누적 델타(CVD)가 하락하며 매수세 약화·매도 출회 포착',
    };
  }
  // Immediate absorption / flip on latest closed bar
  if (last.deltaNorm > 0.15) {
    return {
      type: 'BULLISH_FLIP',
      labelKo: '직전 봉 강한 매수 플립',
      detailKo: `직전 마감 봉 테이커 매수 우위 +${Math.round(last.deltaNorm * 100)}% (단타 롱 1.5x 비중 조건)`,
    };
  }
  if (last.deltaNorm < -0.15) {
    return {
      type: 'BEARISH_FLIP',
      labelKo: '직전 봉 강한 매도 플립',
      detailKo: `직전 마감 봉 테이커 매도 우위 ${Math.round(last.deltaNorm * 100)}% (단타 숏 1.5x 비중 조건)`,
    };
  }
  return {
    type: 'NONE',
    labelKo: '뚜렷한 다이버전스 없음',
    detailKo: '가격과 CVD가 대체로 동행 중입니다.',
  };
}

/**
 * Estimated Liquidation Map (Leverage Cluster Model).
 * Projects un-swept 100x / 50x / 25x / 10x / 5x liquidation zones from recent high-volume
 * candle anchors and scales them to current OI & Long/Short tilt.
 * Transparently marked as an estimated model (`isEstimated: true`).
 */
export function estimateLiquidationMap({ candles = [], markPrice = 0, oiUsd = 0, lsrRatio = 1 }) {
  const px = num(markPrice) || (candles.length ? num(candles.at(-1).c) : 0);
  if (!(px > 0) || candles.length < 4) {
    return { isEstimated: true, markPrice: px, above: [], below: [], nearestShortMagnet: null, nearestLongMagnet: null, maxIntensityUsd: 0 };
  }

  const tiers = [
    { lev: 100, dist: 0.009, weight: 0.24 },
    { lev: 50, dist: 0.019, weight: 0.30 },
    { lev: 25, dist: 0.038, weight: 0.26 },
    { lev: 10, dist: 0.095, weight: 0.14 },
    { lev: 5, dist: 0.190, weight: 0.06 },
  ];

  // Long/short tilt from L/S ratio (clamped to avoid extreme distortion)
  const r = Math.min(3, Math.max(0.33, num(lsrRatio, 1)));
  const longShare = r / (1 + r);
  const shortShare = 1 - longShare;
  const baseOi = num(oiUsd) > 0 ? num(oiUsd) : px * candles.reduce((a, b) => a + num(b.v), 0) * 0.25;

  // Dynamic price range covering ~±6% to ±12% depending on recent volatility
  const recent = candles.slice(-72);
  let maxMove = 0.035;
  for (const c of recent) {
    const dev = Math.max(Math.abs(c.h - px) / px, Math.abs(c.l - px) / px);
    if (dev > maxMove) maxMove = dev;
  }
  const spanPct = Math.min(0.14, Math.max(0.045, maxMove * 1.45));
  const binsPerSide = 9;
  const step = (px * spanPct) / binsPerSide;

  const above = Array.from({ length: binsPerSide }, (_, i) => ({
    side: 'SHORT_LIQ',
    priceLow: px + i * step,
    priceHigh: px + (i + 1) * step,
    price: px + (i + 0.5) * step,
    distPct: round(((i + 0.5) * step / px) * 100, 2),
    usd: 0,
    tierWeights: { 100: 0, 50: 0, 25: 0, 10: 0, 5: 0 },
  }));
  const below = Array.from({ length: binsPerSide }, (_, i) => ({
    side: 'LONG_LIQ',
    priceHigh: px - i * step,
    priceLow: px - (i + 1) * step,
    price: px - (i + 0.5) * step,
    distPct: round(-((i + 0.5) * step / px) * 100, 2),
    usd: 0,
    tierWeights: { 100: 0, 50: 0, 25: 0, 10: 0, 5: 0 },
  }));

  // Compute subsequent high/low after each candle so already-swept liquidations are discounted
  const n = recent.length;
  const maxHighAfter = new Array(n).fill(0);
  const minLowAfter = new Array(n).fill(Infinity);
  for (let i = n - 2; i >= 0; i--) {
    maxHighAfter[i] = Math.max(recent[i + 1].h, maxHighAfter[i + 1]);
    minLowAfter[i] = Math.min(recent[i + 1].l, minLowAfter[i + 1]);
  }
  maxHighAfter[n - 1] = px;
  minLowAfter[n - 1] = px;

  const totalQuoteVol = recent.reduce((a, c) => a + Math.max(1, num(c.q) || num(c.v) * num(c.c)), 0);

  for (let i = 0; i < n; i++) {
    const c = recent[i];
    const anchor = (c.h + c.l + c.c) / 3;
    const recency = 0.45 + 0.55 * ((i + 1) / n);
    const barShare = (Math.max(1, num(c.q) || num(c.v) * num(c.c)) / totalQuoteVol) * recency;

    for (const tier of tiers) {
      // Short liquidation sits ABOVE anchor
      const shortLiqPx = anchor * (1 + tier.dist);
      if (shortLiqPx > px && shortLiqPx <= px * (1 + spanPct)) {
        const swept = maxHighAfter[i] >= shortLiqPx;
        const survival = swept ? 0.12 : 1.0;
        const idx = Math.min(binsPerSide - 1, Math.floor((shortLiqPx - px) / step));
        const val = baseOi * 0.45 * shortShare * barShare * tier.weight * survival;
        above[idx].usd += val;
        above[idx].tierWeights[tier.lev] += val;
      }
      // Long liquidation sits BELOW anchor
      const longLiqPx = anchor * (1 - tier.dist);
      if (longLiqPx < px && longLiqPx >= px * (1 - spanPct)) {
        const swept = minLowAfter[i] <= longLiqPx;
        const survival = swept ? 0.12 : 1.0;
        const idx = Math.min(binsPerSide - 1, Math.floor((px - longLiqPx) / step));
        const val = baseOi * 0.45 * longShare * barShare * tier.weight * survival;
        below[idx].usd += val;
        below[idx].tierWeights[tier.lev] += val;
      }
    }
  }

  const maxIntensityUsd = Math.max(1, ...above.map(b => b.usd), ...below.map(b => b.usd));
  const finalize = list => list.map(b => {
    let domLev = 25, domVal = -1;
    for (const [lev, v] of Object.entries(b.tierWeights)) {
      if (v > domVal) { domVal = v; domLev = Number(lev); }
    }
    return {
      side: b.side,
      price: Number(b.price.toPrecision(6)),
      priceLow: Number(b.priceLow.toPrecision(6)),
      priceHigh: Number(b.priceHigh.toPrecision(6)),
      distPct: b.distPct,
      usd: Math.round(b.usd),
      intensity: round(b.usd / maxIntensityUsd, 3),
      dominantLeverage: domLev,
    };
  });

  const aboveFinal = finalize(above);
  const belowFinal = finalize(below);
  const nearestShortMagnet = aboveFinal.reduce((best, b) => (!best || b.usd > best.usd ? b : best), null);
  const nearestLongMagnet = belowFinal.reduce((best, b) => (!best || b.usd > best.usd ? b : best), null);

  return {
    isEstimated: true,
    markPrice: px,
    spanPct: round(spanPct * 100, 2),
    above: aboveFinal,
    below: belowFinal,
    nearestShortMagnet: nearestShortMagnet && nearestShortMagnet.usd > 0 ? nearestShortMagnet : null,
    nearestLongMagnet: nearestLongMagnet && nearestLongMagnet.usd > 0 ? nearestLongMagnet : null,
    maxIntensityUsd: Math.round(maxIntensityUsd),
  };
}

/**
 * Pure analytics synthesizer for a symbol's derivatives orderflow series.
 */
export function analyzeOrderflowSeries({
  symbol,
  interval = '5m',
  source = 'BINANCE',
  candles = [],
  oiMap = new Map(),
  lsrMap = new Map(),
  topLsrMap = new Map(),
  liqMap = new Map(),
  funding = {},
  now = Date.now(),
}) {
  const sym = normalizeOrderflowSymbol(symbol);
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const intervalMs = VALID_INTERVALS[interval] || 300_000;

  let cvd = 0;
  let lastOi = null;
  const series = sorted.map(c => {
    const buyVol = Math.max(0, num(c.buyVol));
    const sellVol = Math.max(0, num(c.sellVol));
    const tot = buyVol + sellVol;
    const delta = buyVol - sellVol;
    const deltaNorm = tot > 0 ? delta / tot : 0;
    cvd += delta;
    const oi = oiMap.get(c.t) ?? oiMap.get(Math.floor(c.t / intervalMs) * intervalMs) ?? lastOi;
    if (oi != null && oi > 0) lastOi = oi;
    const liq = liqMap.get(c.t) ?? liqMap.get(Math.floor(c.t / intervalMs) * intervalMs) ?? { longUsd: 0, shortUsd: 0 };
    return {
      t: c.t,
      o: num(c.o),
      h: num(c.h),
      l: num(c.l),
      c: num(c.c),
      v: num(c.v),
      q: num(c.q),
      trades: num(c.trades),
      buyVol: Math.round(buyVol),
      sellVol: Math.round(sellVol),
      delta: Math.round(delta),
      deltaNorm: round(deltaNorm, 4) ?? 0,
      cvd: Math.round(cvd),
      oiUsd: lastOi != null ? Math.round(lastOi) : null,
      longLiqUsd: Math.round(num(liq.longUsd)),
      shortLiqUsd: Math.round(num(liq.shortUsd)),
    };
  });

  const last = series.at(-1) || null;
  const first = series[0] || null;
  const markPrice = num(funding.markPrice) || (last ? last.c : 0);
  const indexPrice = num(funding.indexPrice) || markPrice;
  const basisPct = indexPrice > 0 ? round(((markPrice - indexPrice) / indexPrice) * 100, 4) : 0;
  const windowChangePct = first && last && first.c > 0 ? round(((last.c - first.c) / first.c) * 100, 2) : 0;

  // OI changes over 30m, 1h, 4h (converted into bar counts for the active interval)
  const barsFor = ms => Math.max(1, Math.round(ms / intervalMs));
  const oiPctBack = bars => {
    if (!series.length) return null;
    const nowBar = series.at(-1);
    const refBar = series[Math.max(0, series.length - 1 - bars)];
    if (!nowBar?.oiUsd || !refBar?.oiUsd) return null;
    return round(((nowBar.oiUsd - refBar.oiUsd) / refBar.oiUsd) * 100, 2);
  };
  const oiChange30mPct = oiPctBack(barsFor(30 * 60_000));
  const oiChange1hPct = oiPctBack(barsFor(60 * 60_000));
  const oiChange4hPct = oiPctBack(barsFor(4 * 3600_000));
  const oiUsd = num(funding.openInterestUsd) || (last?.oiUsd ?? null);
  const oiState = oiChange30mPct != null && oiChange30mPct <= -1.0
    ? 'OI_FLUSH'
    : oiChange30mPct != null && oiChange30mPct >= 1.0
      ? 'OI_PILE_IN'
      : 'OI_NEUTRAL';

  // CVD stats
  const lastDeltaNorm = last ? last.deltaNorm : 0;
  const lastBuySharePct = round(((lastDeltaNorm + 1) / 2) * 100, 1) ?? 50;
  const prev6 = series[Math.max(0, series.length - 1 - Math.min(6, series.length - 1))];
  const prev24 = series[Math.max(0, series.length - 1 - Math.min(24, series.length - 1))];
  const cvdChange6 = last && prev6 ? Math.round(last.cvd - prev6.cvd) : 0;
  const cvdChange24 = last && prev24 ? Math.round(last.cvd - prev24.cvd) : 0;
  const cvdStrongFlip = lastDeltaNorm > 0.15 ? 'LONG' : lastDeltaNorm < -0.15 ? 'SHORT' : 'NONE';
  const divergence = detectCvdDivergence(series);

  // L/S ratios (take latest available value)
  const latestOf = m => {
    let bestT = -1, bestV = null;
    for (const [k, v] of m.entries()) {
      if (k >= bestT && v != null) { bestT = k; bestV = v; }
    }
    return bestV;
  };
  const accRaw = latestOf(lsrMap);
  const topRaw = latestOf(topLsrMap);
  const fmtRatio = r => {
    const v = num(r);
    if (!(v > 0)) return null;
    const longPct = round((v / (1 + v)) * 100, 1);
    return { ratio: round(v, 2), longPct, shortPct: round(100 - longPct, 1) };
  };
  const lsrAccount = fmtRatio(accRaw);
  const topLsr = fmtRatio(topRaw);

  // Funding rate
  const fundingRate = num(funding.lastFundingRate, null);
  const fundingRatePct = fundingRate != null ? round(fundingRate * 100, 4) : null;
  const fundingAnnualPct = fundingRatePct != null ? round(fundingRatePct * 3 * 365, 1) : null;
  const fundingState = fundingRatePct == null
    ? 'UNKNOWN'
    : fundingRatePct >= 0.02
      ? 'LONG_CROWDED'
      : fundingRatePct <= -0.02
        ? 'SHORT_CROWDED'
        : 'NEUTRAL';

  // Actual liquidations over last 30m & full window
  const liqBars30m = series.slice(-barsFor(30 * 60_000));
  const liq30m = {
    longUsd: Math.round(liqBars30m.reduce((a, b) => a + b.longLiqUsd, 0)),
    shortUsd: Math.round(liqBars30m.reduce((a, b) => a + b.shortLiqUsd, 0)),
  };
  const liqWindow = {
    longUsd: Math.round(series.reduce((a, b) => a + b.longLiqUsd, 0)),
    shortUsd: Math.round(series.reduce((a, b) => a + b.shortLiqUsd, 0)),
  };

  const liquidationMap = estimateLiquidationMap({
    candles: series,
    markPrice,
    oiUsd,
    lsrRatio: topLsr?.ratio ?? lsrAccount?.ratio ?? 1,
  });

  // Backtest-validated scalp boost preview (FJ: +5pt OI flush <= -1%, 1.5x CVD strong flip > 15%)
  const oiBonusEligible = oiChange30mPct != null && oiChange30mPct <= -1.0;
  const parts = [];
  if (cvdStrongFlip === 'LONG') parts.push(`매수 테이커 급증(+${Math.round(lastDeltaNorm * 100)}%, 롱 1.5x 조건)`);
  else if (cvdStrongFlip === 'SHORT') parts.push(`매도 테이커 급증(${Math.round(lastDeltaNorm * 100)}%, 숏 1.5x 조건)`);
  else if (divergence.type === 'BULLISH' || divergence.type === 'BEARISH') parts.push(divergence.labelKo);
  else parts.push(lastDeltaNorm >= 0 ? `매수 소폭 우위(${lastBuySharePct}%)` : `매도 소폭 우위(${round(100 - lastBuySharePct, 1)}%)`);

  if (oiState === 'OI_FLUSH') parts.push(`30분 OI ${oiChange30mPct}% 청산 소진(+5점 보너스)`);
  else if (oiState === 'OI_PILE_IN') parts.push(`30분 OI +${oiChange30mPct}% 신규 유입`);
  if (fundingState === 'LONG_CROWDED') parts.push(`펀딩 +${fundingRatePct}% 롱 과열`);
  else if (fundingState === 'SHORT_CROWDED') parts.push(`펀딩 ${fundingRatePct}% 숏 과열`);

  return {
    ok: true,
    symbol: sym,
    interval,
    source,
    at: now,
    price: {
      mark: markPrice,
      index: indexPrice,
      basisPct,
      windowChangePct,
    },
    cvd: {
      current: last ? last.cvd : 0,
      change6: cvdChange6,
      change24: cvdChange24,
      lastDeltaNorm,
      lastBuySharePct,
      strongFlip: cvdStrongFlip,
      divergence,
    },
    oi: {
      usd: oiUsd != null ? Math.round(oiUsd) : null,
      change30mPct: oiChange30mPct,
      change1hPct: oiChange1hPct,
      change4hPct: oiChange4hPct,
      state: oiState,
      oiBonusEligible,
    },
    ratios: {
      account: lsrAccount,
      topTrader: topLsr,
    },
    funding: {
      ratePct: fundingRatePct,
      annualPct: fundingAnnualPct,
      nextFundingTime: num(funding.nextFundingTime, null),
      state: fundingState,
    },
    liquidations: {
      recent30m: liq30m,
      window: liqWindow,
      hasActualData: liqMap.size > 0,
    },
    liquidationMap,
    scalpSignal: {
      oiBonusEligible,
      cvdBoostSide: cvdStrongFlip,
      summaryKo: parts.join(' · '),
    },
    series,
  };
}

/**
 * Evaluate backtest-validated orderflow boost (FJ) for a 5m scalp reversal setup.
 * Backtest (40 BingX coins, Train/OOS):
 * - +5pt OI Flush bonus (30m OI <= -1.0%): Net +$2,481 -> +$2,667, MDD unchanged ($262.7), Ret/MDD 9.44 -> 10.15
 * - 1.5x size boost on CVD Strong Flip (dir * deltaNorm > 0.15; WR 81.8%, PF 5.68): Combined Net +$2,765 (+11.5%), Ret/MDD 10.53
 */
export function evaluateScalpOrderflowBoost(snapshot, direction, opts = {}) {
  const oiBonusPts = Number.isFinite(Number(opts.oiBonus)) ? Number(opts.oiBonus) : 5;
  const oiFlushPct = Number.isFinite(Number(opts.oiFlushThresholdPct)) ? Number(opts.oiFlushThresholdPct) : -1.0;
  const cvdThresh = Number.isFinite(Number(opts.cvdFlipThreshold)) ? Number(opts.cvdFlipThreshold) : 0.15;
  const cvdSizeMult = Number.isFinite(Number(opts.cvdSizeMult)) ? Number(opts.cvdSizeMult) : 1.5;

  if (!snapshot || !snapshot.ok) {
    return { available: false, oiBonus: 0, cvdBoost: false, sizeMult: 1, oiChange30mPct: null, dirDeltaNorm: null, summaryKo: '' };
  }
  const dir = direction === 'LONG' ? 1 : direction === 'SHORT' ? -1 : 0;
  const oi30 = snapshot.oi?.change30mPct;
  const lastDeltaNorm = snapshot.cvd?.lastDeltaNorm;
  const dirDeltaNorm = dir && Number.isFinite(Number(lastDeltaNorm)) ? round(dir * Number(lastDeltaNorm), 4) : null;

  const oiBonus = Number.isFinite(Number(oi30)) && Number(oi30) <= oiFlushPct ? oiBonusPts : 0;
  const cvdBoost = dirDeltaNorm != null && dirDeltaNorm > cvdThresh;
  const sizeMult = cvdBoost ? cvdSizeMult : 1;

  const tags = [];
  if (oiBonus > 0) tags.push(`OI 소진 ${oi30}%(+${oiBonus}점)`);
  if (cvdBoost) tags.push(`CVD 강한반전 +${Math.round(dirDeltaNorm * 100)}%(${cvdSizeMult}x)`);
  return {
    available: true,
    source: snapshot.source || null,
    oiBonus,
    cvdBoost,
    sizeMult,
    oiChange30mPct: Number.isFinite(Number(oi30)) ? Number(oi30) : null,
    dirDeltaNorm,
    fundingRatePct: snapshot.funding?.ratePct ?? null,
    summaryKo: tags.join(' · '),
  };
}

/**
 * Guard against entering into an active short/long squeeze:
 * - SHORT blocked (SHORT_SQUEEZE_GUARD) when fundingRatePct <= -fundingPct AND 30m OI >= +oiChange30mPct
 * - LONG blocked (LONG_SQUEEZE_GUARD) when fundingRatePct >= +fundingPct AND 30m OI >= +oiChange30mPct
 * Fail-open when orderflow data is unavailable; allows with-squeeze entries and OI-flushing setups.
 */
export function evaluateScalpSqueezeGuard(snapshot, direction, opts = {}) {
  const fundingThresh = Number.isFinite(Number(opts.fundingPct)) ? Math.abs(Number(opts.fundingPct)) : 0.10;
  const oiThresh = Number.isFinite(Number(opts.oiChange30mPct)) ? Number(opts.oiChange30mPct) : 2.0;
  if (!snapshot || !snapshot.ok || !(fundingThresh > 0)) {
    return { blocked: false, reason: null, detail: null };
  }
  const funding = snapshot.funding?.ratePct;
  const oi30 = snapshot.oi?.change30mPct;
  if (!Number.isFinite(Number(funding)) || !Number.isFinite(Number(oi30))) {
    return { blocked: false, reason: null, detail: null };
  }
  const f = Number(funding), o = Number(oi30);
  if (direction === 'SHORT' && f <= -fundingThresh && o >= oiThresh) {
    return {
      blocked: true,
      reason: 'SHORT_SQUEEZE_GUARD',
      detail: `펀딩 ${f.toFixed(4)}% (≤ -${fundingThresh}%) · 30분 OI +${o.toFixed(2)}% (≥ +${oiThresh}%)`,
    };
  }
  if (direction === 'LONG' && f >= fundingThresh && o >= oiThresh) {
    return {
      blocked: true,
      reason: 'LONG_SQUEEZE_GUARD',
      detail: `펀딩 +${f.toFixed(4)}% (≥ +${fundingThresh}%) · 30분 OI +${o.toFixed(2)}% (≥ +${oiThresh}%)`,
    };
  }
  return { blocked: false, reason: null, detail: null };
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

async function fetchGateLiquidations(symbol, interval, limit, { fetcher, gateBase }) {
  const liqMap = new Map();
  try {
    const contract = gateContractFor(symbol);
    const iv = GATE_INTERVALS[interval] || '5m';
    const arr = await fetchJson(`${gateBase}/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(contract)}&interval=${iv}&limit=${limit}`, { fetcher, timeoutMs: 3500 });
    if (Array.isArray(arr)) {
      for (const r of arr) {
        const t = num(r.time) * 1000;
        if (t > 0) liqMap.set(t, { longUsd: num(r.long_liq_usd), shortUsd: num(r.short_liq_usd) });
      }
    }
  } catch {}
  return liqMap;
}

async function fetchFromBinance(symbol, interval, limit, { fetcher, binanceBase, gateBase }) {
  if (Date.now() < binanceBlockedUntil) throw Object.assign(new Error('BINANCE_GEO_SKIP'), { status: 451 });
  const sym = normalizeOrderflowSymbol(symbol);
  const [kl, oiH, lsr, topLsr, prem, liqMap] = await Promise.all([
    fetchJson(`${binanceBase}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`, { fetcher, timeoutMs: 4000 }),
    fetchJson(`${binanceBase}/futures/data/openInterestHist?symbol=${encodeURIComponent(sym)}&period=${interval}&limit=${limit}`, { fetcher, timeoutMs: 4000 }).catch(() => []),
    fetchJson(`${binanceBase}/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(sym)}&period=${interval}&limit=30`, { fetcher, timeoutMs: 4000 }).catch(() => []),
    fetchJson(`${binanceBase}/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(sym)}&period=${interval}&limit=30`, { fetcher, timeoutMs: 4000 }).catch(() => []),
    fetchJson(`${binanceBase}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(sym)}`, { fetcher, timeoutMs: 4000 }).catch(() => ({})),
    fetchGateLiquidations(sym, interval, limit, { fetcher, gateBase }),
  ]);

  if (!Array.isArray(kl) || kl.length < 4) throw new Error('BINANCE_EMPTY_KLINES');
  // Drop in-progress last bar if closeTime > now
  const now = Date.now();
  const closedKl = kl.filter(k => num(k[6]) <= now);
  const rows = closedKl.length >= 4 ? closedKl : kl;

  const candles = rows.map(k => {
    const quoteVol = num(k[7]);
    const buyQuote = num(k[10]);
    const sellQuote = Math.max(0, quoteVol - buyQuote);
    return {
      t: num(k[0]),
      o: num(k[1]),
      h: num(k[2]),
      l: num(k[3]),
      c: num(k[4]),
      v: num(k[5]),
      q: quoteVol,
      trades: num(k[8]),
      buyVol: buyQuote,
      sellVol: sellQuote,
    };
  });

  const oiMap = new Map();
  if (Array.isArray(oiH)) {
    for (const r of oiH) {
      const t = num(r.timestamp);
      const v = num(r.sumOpenInterestValue);
      if (t > 0 && v > 0) oiMap.set(t, v);
    }
  }
  const lsrMap = new Map();
  if (Array.isArray(lsr)) {
    for (const r of lsr) lsrMap.set(num(r.timestamp), num(r.longShortRatio));
  }
  const topLsrMap = new Map();
  if (Array.isArray(topLsr)) {
    for (const r of topLsr) topLsrMap.set(num(r.timestamp), num(r.longShortRatio));
  }

  return analyzeOrderflowSeries({
    symbol: sym,
    interval,
    source: 'BINANCE',
    candles,
    oiMap,
    lsrMap,
    topLsrMap,
    liqMap,
    funding: {
      markPrice: num(prem?.markPrice),
      indexPrice: num(prem?.indexPrice),
      lastFundingRate: prem?.lastFundingRate != null ? num(prem.lastFundingRate) : null,
      nextFundingTime: num(prem?.nextFundingTime, null),
    },
    now,
  });
}

async function fetchFromGate(symbol, interval, limit, { fetcher, gateBase }) {
  const sym = normalizeOrderflowSymbol(symbol);
  const contract = gateContractFor(sym);
  const iv = GATE_INTERVALS[interval] || '5m';
  const statsLimit = Math.min(200, limit);
  const [kl, stats, contractInfo] = await Promise.all([
    fetchJson(`${gateBase}/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${iv}&limit=${limit}`, { fetcher, timeoutMs: 5000 }),
    fetchJson(`${gateBase}/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(contract)}&interval=${iv}&limit=${statsLimit}`, { fetcher, timeoutMs: 5000 }).catch(() => []),
    fetchJson(`${gateBase}/api/v4/futures/usdt/contracts/${encodeURIComponent(contract)}`, { fetcher, timeoutMs: 4000 }).catch(() => ({})),
  ]);

  if (!Array.isArray(kl) || kl.length < 4) throw new Error('GATE_EMPTY_KLINES');
  const statsMap = new Map();
  const oiMap = new Map();
  const lsrMap = new Map();
  const topLsrMap = new Map();
  const liqMap = new Map();
  let latestFunding = null;

  if (Array.isArray(stats)) {
    for (const r of stats) {
      const t = num(r.time) * 1000;
      if (!(t > 0)) continue;
      statsMap.set(t, r);
      if (num(r.open_interest_usd) > 0) oiMap.set(t, num(r.open_interest_usd));
      if (num(r.lsr_account) > 0) lsrMap.set(t, num(r.lsr_account));
      if (num(r.top_lsr_size) > 0) topLsrMap.set(t, num(r.top_lsr_size));
      liqMap.set(t, { longUsd: num(r.long_liq_usd), shortUsd: num(r.short_liq_usd) });
      if (r.last_funding_rate != null) latestFunding = num(r.last_funding_rate);
    }
  }

  const latestStatT = statsMap.size ? Math.max(...statsMap.keys()) : Infinity;
  const closedKl = statsMap.size ? kl.filter(k => num(k.t) * 1000 <= latestStatT) : kl;
  const rows = closedKl.length >= 4 ? closedKl : kl;

  const candles = rows.map(k => {
    const t = num(k.t) * 1000;
    const st = statsMap.get(t);
    const quote = num(k.sum) || num(k.v) * num(k.c);
    // Gate contract_stats gives long_taker_size & short_taker_size; convert to quote proportion if available
    const lt = num(st?.long_taker_size);
    const stSz = num(st?.short_taker_size);
    let buyVol = quote * 0.5, sellVol = quote * 0.5;
    if (lt + stSz > 0) {
      const buyRatio = lt / (lt + stSz);
      buyVol = quote * buyRatio;
      sellVol = quote * (1 - buyRatio);
    } else if (num(st?.lsr_taker) > 0) {
      const r = num(st.lsr_taker);
      buyVol = quote * (r / (1 + r));
      sellVol = quote - buyVol;
    }
    return {
      t,
      o: num(k.o),
      h: num(k.h),
      l: num(k.l),
      c: num(k.c),
      v: num(k.v),
      q: quote,
      buyVol,
      sellVol,
    };
  });

  return analyzeOrderflowSeries({
    symbol: sym,
    interval,
    source: 'GATEIO',
    candles,
    oiMap,
    lsrMap,
    topLsrMap,
    liqMap,
    funding: {
      markPrice: num(contractInfo?.mark_price) || (candles.at(-1)?.c ?? 0),
      indexPrice: num(contractInfo?.index_price) || (candles.at(-1)?.c ?? 0),
      lastFundingRate: contractInfo?.funding_rate != null ? num(contractInfo.funding_rate) : latestFunding,
      nextFundingTime: num(contractInfo?.funding_next_apply) ? num(contractInfo.funding_next_apply) * 1000 : null,
    },
  });
}

async function fetchFromBingX(symbol, interval, limit, { fetcher, bingxBase }) {
  const sym = normalizeOrderflowSymbol(symbol);
  const bxSym = bingxSymbolFor(sym);
  const [klRes, oiRes, premRes, tradesRes] = await Promise.all([
    fetchJson(`${bingxBase}/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(bxSym)}&interval=${interval}&limit=${limit}`, { fetcher, timeoutMs: 5000 }),
    fetchJson(`${bingxBase}/openApi/swap/v2/quote/openInterest?symbol=${encodeURIComponent(bxSym)}`, { fetcher, timeoutMs: 4000 }).catch(() => ({})),
    fetchJson(`${bingxBase}/openApi/swap/v2/quote/premiumIndex?symbol=${encodeURIComponent(bxSym)}`, { fetcher, timeoutMs: 4000 }).catch(() => ({})),
    fetchJson(`${bingxBase}/openApi/swap/v2/quote/trades?symbol=${encodeURIComponent(bxSym)}&limit=100`, { fetcher, timeoutMs: 4000 }).catch(() => ({})),
  ]);

  const rows = Array.isArray(klRes?.data) ? klRes.data : [];
  if (rows.length < 4) throw new Error('BINGX_EMPTY_KLINES');

  // Estimate taker buy/sell from candle body position (and exact recent trades for latest bar)
  let recentBuy = 0, recentSell = 0;
  if (Array.isArray(tradesRes?.data)) {
    for (const tr of tradesRes.data) {
      const q = num(tr.quoteQty) || num(tr.price) * num(tr.qty);
      if (tr.isBuyerMaker) recentSell += q; else recentBuy += q;
    }
  }
  const sortedRows = [...rows].sort((a, b) => num(a.time) - num(b.time));
  const candles = sortedRows.map((k, idx) => {
    const o = num(k.open), h = num(k.high), l = num(k.low), c = num(k.close), v = num(k.volume);
    const quote = v * c;
    let buyFrac = h > l ? Math.min(0.85, Math.max(0.15, (c - l) / (h - l))) : 0.5;
    if (idx === sortedRows.length - 1 && recentBuy + recentSell > 0) {
      buyFrac = recentBuy / (recentBuy + recentSell);
    }
    return { t: num(k.time), o, h, l, c, v, q: quote, buyVol: quote * buyFrac, sellVol: quote * (1 - buyFrac) };
  });

  const mark = num(premRes?.data?.markPrice) || (candles.at(-1)?.c ?? 0);
  const oiQty = num(oiRes?.data?.openInterest);
  const oiUsd = oiQty > 0 ? (oiQty * mark > 1e12 ? oiQty : oiQty * mark) : null;

  return analyzeOrderflowSeries({
    symbol: sym,
    interval,
    source: 'BINGX',
    candles,
    funding: {
      markPrice: mark,
      indexPrice: num(premRes?.data?.indexPrice) || mark,
      lastFundingRate: premRes?.data?.lastFundingRate != null ? num(premRes.data.lastFundingRate) : null,
      nextFundingTime: num(premRes?.data?.nextFundingTime, null),
      openInterestUsd: oiUsd,
    },
  });
}

export async function fetchOrderflow(symbol, opts = {}) {
  const sym = normalizeOrderflowSymbol(symbol);
  const interval = Object.hasOwn(VALID_INTERVALS, opts.interval) ? opts.interval : '5m';
  const limit = Math.min(400, Math.max(24, Number(opts.limit) || 72));
  const fetcher = opts.fetcher || fetch;
  const binanceBase = opts.binanceBase || 'https://fapi.binance.com';
  const gateBase = opts.gateBase || 'https://api.gateio.ws';
  const bingxBase = opts.bingxBase || 'https://open-api.bingx.com';

  const key = `${sym}|${interval}|${limit}`;
  const hit = cache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const errors = [];
  if (!opts.skipBinance) {
    try {
      const data = await fetchFromBinance(sym, interval, limit, { fetcher, binanceBase, gateBase });
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 120) cache.delete(cache.keys().next().value);
      return data;
    } catch (e) {
      if (e?.status === 451 || e?.status === 403) binanceBlockedUntil = Date.now() + BINANCE_BLOCK_TTL_MS;
      errors.push(`BINANCE:${e.message}`);
    }
  }

  try {
    const data = await fetchFromGate(sym, interval, limit, { fetcher, gateBase });
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return data;
  } catch (e) {
    errors.push(`GATEIO:${e.message}`);
  }

  try {
    const data = await fetchFromBingX(sym, interval, limit, { fetcher, bingxBase });
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return data;
  } catch (e) {
    errors.push(`BINGX:${e.message}`);
  }

  throw new Error(`ORDERFLOW_UNAVAILABLE (${errors.join(', ')})`);
}

export const ORDERFLOW_RADAR_DEFAULTS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
  'SUIUSDT', 'AVAXUSDT', 'LINKUSDT', 'ADAUSDT', '1000PEPEUSDT',
  'BNBUSDT', 'AAVEUSDT', 'NEARUSDT', 'ARBUSDT', 'OPUSDT',
  'APTUSDT', 'INJUSDT', 'SEIUSDT', 'WIFUSDT', 'ENAUSDT',
]);

const RADAR_CACHE_TTL_MS = 60_000;
let radarCache = null;

/**
 * Pure anomaly ranker across multiple orderflow snapshots.
 * Scores each coin for OI flush (<= -0.8%), strong CVD flip (> 15%), CVD divergence, and funding crowding.
 */
export function rankOrderflowAnomalies(snapshots = [], { limit = 10 } = {}) {
  const scored = [];
  for (const d of snapshots) {
    if (!d || !d.ok) continue;
    const oi30 = Number.isFinite(Number(d.oi?.change30mPct)) ? Number(d.oi.change30mPct) : null;
    const delta = Number.isFinite(Number(d.cvd?.lastDeltaNorm)) ? Number(d.cvd.lastDeltaNorm) : 0;
    const absDelta = Math.abs(delta);
    const divType = d.cvd?.divergence?.type || 'NONE';
    const fund = Number.isFinite(Number(d.funding?.ratePct)) ? Number(d.funding.ratePct) : null;
    const tags = [];
    let score = 0;

    if (oi30 != null && oi30 <= -0.8) {
      score += 40 + Math.min(35, Math.abs(oi30) * 10);
      tags.push({ kind: 'OI_FLUSH', tone: 'pos', text: `OI ${oi30}% 소진${oi30 <= -1.0 ? '(+5점)' : ''}` });
    } else if (oi30 != null && oi30 >= 2.0) {
      score += 18 + Math.min(20, oi30 * 4);
      tags.push({ kind: 'OI_PILE', tone: 'warn', text: `OI +${oi30}% 유입` });
    }

    if (absDelta > 0.15) {
      score += 35 + Math.min(35, absDelta * 60);
      const isBuy = delta > 0;
      tags.push({
        kind: isBuy ? 'CVD_LONG' : 'CVD_SHORT',
        tone: isBuy ? 'pos' : 'neg',
        text: `${isBuy ? '매수' : '매도'} CVD ${isBuy ? '+' : ''}${Math.round(delta * 100)}%(1.5x)`,
      });
    }

    if (divType === 'BULLISH' || divType === 'BEARISH') {
      score += 30;
      tags.push({
        kind: divType === 'BULLISH' ? 'DIV_BULL' : 'DIV_BEAR',
        tone: divType === 'BULLISH' ? 'pos' : 'neg',
        text: divType === 'BULLISH' ? '강세 다이버전스' : '약세 다이버전스',
      });
    }

    if (fund != null && Math.abs(fund) >= 0.015) {
      score += 15 + Math.min(20, Math.abs(fund) * 400);
      tags.push({
        kind: 'FUND_HOT',
        tone: fund > 0 ? 'neg' : 'pos',
        text: `펀딩 ${fund > 0 ? '+' : ''}${fund.toFixed(3)}%`,
      });
    }

    scored.push({
      symbol: d.symbol,
      source: d.source,
      markPrice: d.price?.mark ?? null,
      windowChangePct: d.price?.windowChangePct ?? null,
      oiChange30mPct: oi30,
      lastDeltaNorm: round(delta, 4) ?? 0,
      lastBuySharePct: d.cvd?.lastBuySharePct ?? 50,
      fundingRatePct: fund,
      divergenceType: divType,
      tags,
      anomalyScore: round(score, 1) ?? 0,
    });
  }

  const flagged = scored.filter(x => x.tags.length > 0).sort((a, b) => b.anomalyScore - a.anomalyScore);
  const topActive = scored
    .slice()
    .sort((a, b) => (Math.abs(b.lastDeltaNorm) * 100 + Math.abs(b.oiChange30mPct || 0) * 10) - (Math.abs(a.lastDeltaNorm) * 100 + Math.abs(a.oiChange30mPct || 0) * 10));
  const anomalies = (flagged.length >= 4 ? flagged : [...flagged, ...topActive.filter(x => !flagged.includes(x))]).slice(0, limit);

  const topOiFlush = scored
    .filter(x => x.oiChange30mPct != null)
    .sort((a, b) => a.oiChange30mPct - b.oiChange30mPct)
    .slice(0, 4);
  const topCvdFlip = scored
    .slice()
    .sort((a, b) => Math.abs(b.lastDeltaNorm) - Math.abs(a.lastDeltaNorm))
    .slice(0, 4);

  return {
    scanned: scored.length,
    flaggedCount: flagged.length,
    anomalies,
    topOiFlush,
    topCvdFlip,
  };
}

/**
 * Scan up to 20 active perpetuals concurrently (60s cache) for OI flush, strong CVD flips, and divergences.
 */
export async function scanOrderflowAnomalies(symbols = ORDERFLOW_RADAR_DEFAULTS, opts = {}) {
  const list = [...new Set((Array.isArray(symbols) && symbols.length ? symbols : ORDERFLOW_RADAR_DEFAULTS).map(normalizeOrderflowSymbol))].slice(0, 20);
  const key = list.join(',');
  if (!opts.force && radarCache && radarCache.key === key && Date.now() - radarCache.at < RADAR_CACHE_TTL_MS) {
    return radarCache.data;
  }

  const queue = [...list];
  const results = [];
  const workers = Math.min(6, queue.length);
  const runWorker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const snap = await fetchOrderflow(sym, { ...opts, interval: '5m', limit: 24, force: Boolean(opts.force) });
        if (snap?.ok) results.push(snap);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));

  const ranked = rankOrderflowAnomalies(results, { limit: opts.limit || 10 });
  const data = { ok: true, at: Date.now(), totalRequested: list.length, ...ranked };
  radarCache = { key, at: Date.now(), data };
  return data;
}

/**
 * Enrich standard orderflow data with Material Indicators FireCharts-style
 * Liquidity Heatmap (live L2 walls + recorded snapshots + volume shelves) and
 * 4-Cohort (Whale/Large/Mid/Retail) Normalized & Absolute CVD.
 */
export async function fetchOrderflowWithFirechart(symbol, opts = {}) {
  const sym = normalizeOrderflowSymbol(symbol);
  const requestedRange = String(opts.range || '').toUpperCase();
  const rangeDef = Object.hasOwn(FIRECHART_RANGES, requestedRange)
    ? FIRECHART_RANGES[requestedRange]
    : (opts.interval === '4h' ? FIRECHART_RANGES['1M']
      : opts.interval === '1h' ? FIRECHART_RANGES['1W']
      : opts.interval === '15m' ? FIRECHART_RANGES['1D']
      : FIRECHART_RANGES.LIVE);

  const [base, extras] = await Promise.all([
    fetchOrderflow(sym, { ...opts, interval: rangeDef.interval, limit: rangeDef.limit }),
    fetchFirechartExtras(sym, {
      gateContract: gateContractFor(sym),
      bingxSymbol: bingxSymbolFor(sym),
      needTrades: rangeDef.useRealTrades,
      skipBinance: Boolean(opts.skipBinance) || Date.now() < binanceBlockedUntil,
      fetcher: opts.fetcher,
      binanceBase: opts.binanceBase,
      gateBase: opts.gateBase,
      bingxBase: opts.bingxBase,
    }),
  ]);

  const useReal = rangeDef.useRealTrades && Array.isArray(extras.trades) && extras.trades.length >= 12;
  const cohorts = useReal
    ? buildTradeCohortSeries(extras.trades, { buckets: 64 })
    : buildHistoricalCohortSeries(base.series);

  // For LIVE real-trade view, build heatmap price bounds over the matching candle series
  const heatmap = buildLiquidityHeatmap({
    candles: base.series,
    orderbook: extras.orderbook,
    snapshots: extras.snapshots,
    priceBins: 96,
  });

  return {
    ...base,
    range: rangeDef.key,
    firechart: {
      range: rangeDef.key,
      labelKo: rangeDef.labelKo,
      cohortMode: cohorts.cohortMode,
      bookSource: extras.source || base.source,
      cohorts,
      heatmap,
    },
  };
}

export function clearOrderflowCache() {
  cache.clear();
  radarCache = null;
  binanceBlockedUntil = 0;
}

