// Multi-timeframe CVD Support / Resistance engine & held-position Telegram alert monitor.
// Derives LIVE (6h), 1D, 1W, 1M, 6M, and 1Y strong CVD support/resistance zones from 3 cached
// kline calls per symbol (15m x 96, 4h x 180, 1d x 365) via orderflow.mjs (Binance -> Gate -> BingX).
// Alerts via Telegram whenever a held real-account symbol gains (ADDED) or loses (REMOVED) a STRONG CVD zone.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteStore, readStore } from './persistence.mjs';
import { fetchOrderflow, normalizeOrderflowSymbol } from './orderflow.mjs';
import { displaySymbol } from './public/symbol_display.js';

export const CVD_SR_TIMEFRAMES = Object.freeze([
  { key: 'LIVE', labelKo: '실시간', source: '15m', slice: 24, maxDistPct: 20, matchTolPct: 1.5 },
  { key: '1D', labelKo: '1D', source: '15m', slice: 96, maxDistPct: 30, matchTolPct: 1.5 },
  { key: '1W', labelKo: '1W', source: '4h', slice: 42, maxDistPct: 45, matchTolPct: 2.5 },
  { key: '1M', labelKo: '1M', source: '4h', slice: 180, maxDistPct: 60, matchTolPct: 2.5 },
  { key: '6M', labelKo: '6M', source: '1d', slice: 180, maxDistPct: 75, matchTolPct: 4.0 },
  { key: '1Y', labelKo: '1Y', source: '1d', slice: 365, maxDistPct: 85, matchTolPct: 4.0 },
].map(x => Object.freeze(x)));

export const CVD_SR_STRONG_ENTER = 70;
export const CVD_SR_STRONG_EXIT = 58;
export const CVD_SR_MEDIUM_MIN = 45;
const SYMBOL_CACHE_TTL_MS = 90_000;
const ALERT_COOLDOWN_MS = 20 * 60_000;
const MAX_RECENT_EVENTS = 40;

const symbolCache = new Map();
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function fmtPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

function fmtUsdCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pure CVD price-level support/resistance detector for one candle series.
 * - Support (지지대): price bins below markPrice with concentrated positive net CVD buying.
 * - Resistance (저항대): price bins above markPrice with concentrated negative net CVD selling.
 */
export function computeCvdSrZones(series = [], markPrice = 0, {
  binCount = 60,
  minDistPct = 0.15,
  maxDistPct = 45,
  strongMin = CVD_SR_STRONG_ENTER,
  mediumMin = CVD_SR_MEDIUM_MIN,
} = {}) {
  const empty = { supports: [], resistances: [], strongSupports: [], strongResistances: [], bestSupport: null, bestResistance: null };
  if (!Array.isArray(series) || series.length < 4) return empty;
  const lastClose = num(series.at(-1)?.c);
  const price = num(markPrice) > 0 ? num(markPrice) : lastClose;
  if (!(price > 0)) return empty;

  const loBound = price * Math.max(0.05, 1 - maxDistPct / 100);
  const hiBound = price * (1 + maxDistPct / 100);

  let minP = Infinity;
  let maxP = -Infinity;
  for (const k of series) {
    const l = num(k.l), h = num(k.h);
    if (!(h >= l && h > 0)) continue;
    const cl = Math.max(loBound, l);
    const ch = Math.min(hiBound, h);
    if (ch >= cl) {
      if (cl < minP) minP = cl;
      if (ch > maxP) maxP = ch;
    }
  }
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) return empty;

  const binsN = Math.max(16, Math.min(96, Math.round(binCount)));
  const step = (maxP - minP) / binsN;
  if (!(step > 0)) return empty;

  const bins = Array.from({ length: binsN }, (_, i) => ({
    idx: i,
    low: minP + i * step,
    high: minP + (i + 1) * step,
    mid: minP + (i + 0.5) * step,
    buyUsd: 0,
    sellUsd: 0,
    netDeltaUsd: 0,
    totalUsd: 0,
    touches: 0,
  }));

  for (const k of series) {
    const l = num(k.l), h = num(k.h);
    if (!(h >= l && h > 0)) continue;
    const buy = Math.max(0, num(k.buyVol));
    const sell = Math.max(0, num(k.sellVol));
    const tot = buy + sell;
    if (!(tot > 0)) continue;
    const cl = Math.max(minP, l);
    const ch = Math.min(maxP, h);
    if (ch < cl) continue;
    const i0 = Math.max(0, Math.min(binsN - 1, Math.floor((cl - minP) / step)));
    const i1 = Math.max(0, Math.min(binsN - 1, Math.floor((ch - minP) / step)));
    const span = i1 - i0 + 1;
    const buyPer = buy / span;
    const sellPer = sell / span;
    for (let i = i0; i <= i1; i++) {
      const b = bins[i];
      b.buyUsd += buyPer;
      b.sellUsd += sellPer;
      b.netDeltaUsd += buyPer - sellPer;
      b.totalUsd += buyPer + sellPer;
      b.touches += 1;
    }
  }

  const activeBins = bins.filter(b => b.totalUsd > 0);
  if (activeBins.length < 3) return empty;
  const medTotal = Math.max(1, median(activeBins.map(b => b.totalUsd)));
  const absDeltas = activeBins.map(b => Math.abs(b.netDeltaUsd)).filter(v => v > 0);
  const medDelta = Math.max(1, median(absDeltas));
  const maxAbsDelta = Math.max(1, ...absDeltas);

  const scoreSide = kind => {
    const isSup = kind === 'SUPPORT';
    const candidates = [];
    for (const b of activeBins) {
      const distPct = ((b.mid - price) / price) * 100;
      if (isSup && distPct > -minDistPct) continue;
      if (!isSup && distPct < minDistPct) continue;
      if (Math.abs(distPct) > maxDistPct) continue;
      const signedDelta = isSup ? b.netDeltaUsd : -b.netDeltaUsd;
      if (!(signedDelta > 0)) continue;
      const dominance = (isSup ? b.buyUsd : b.sellUsd) / b.totalUsd;
      if (dominance < 0.52) continue;

      const deltaRatio = signedDelta / medDelta;
      const peakShare = signedDelta / maxAbsDelta;
      const volRatio = b.totalUsd / medTotal;
      const skewScore = Math.min(1, Math.max(0, (dominance - 0.52) / 0.22));
      const touchScore = Math.min(1, b.touches / Math.max(3, Math.min(8, series.length * 0.08)));

      const raw =
        Math.min(1, deltaRatio / 3.2) * 38 +
        Math.min(1, peakShare / 0.75) * 20 +
        Math.min(1, volRatio / 2.6) * 22 +
        skewScore * 12 +
        touchScore * 8;
      const strength = Math.max(0, Math.min(100, Math.round(raw)));
      if (strength >= mediumMin) {
        candidates.push({ ...b, signedDelta, dominance, strength });
      }
    }
    if (!candidates.length) return [];

    // Merge adjacent bins (gap <= 1 bin) into clean zones
    candidates.sort((a, b) => a.idx - b.idx);
    const groups = [];
    for (const c of candidates) {
      const prev = groups.at(-1);
      if (prev && c.idx - prev.lastIdx <= 2) {
        prev.bins.push(c);
        prev.lastIdx = c.idx;
      } else {
        groups.push({ bins: [c], lastIdx: c.idx });
      }
    }

    const zones = groups.map(g => {
      let wPrice = 0, wSum = 0, netDelta = 0, totalUsd = 0, touches = 0, maxStr = 0;
      let low = Infinity, high = -Infinity;
      for (const b of g.bins) {
        const w = Math.max(1, b.signedDelta);
        wPrice += b.mid * w;
        wSum += w;
        netDelta += b.netDeltaUsd;
        totalUsd += b.totalUsd;
        touches += b.touches;
        if (b.strength > maxStr) maxStr = b.strength;
        if (b.low < low) low = b.low;
        if (b.high > high) high = b.high;
      }
      const centerPrice = wSum > 0 ? wPrice / wSum : (low + high) / 2;
      const distPct = round(((centerPrice - price) / price) * 100, 2);
      // Multi-bin cluster bonus (up to +5)
      const clusterBonus = g.bins.length >= 2 ? Math.min(5, (g.bins.length - 1) * 2) : 0;
      const strength = Math.min(100, maxStr + clusterBonus);
      const grade = strength >= strongMin ? 'STRONG' : 'MEDIUM';
      return {
        kind,
        centerPrice: round(centerPrice, centerPrice >= 10 ? 2 : centerPrice >= 1 ? 4 : 6),
        low: round(low, low >= 10 ? 2 : low >= 1 ? 4 : 6),
        high: round(high, high >= 10 ? 2 : high >= 1 ? 4 : 6),
        distPct,
        netDeltaUsd: Math.round(netDelta),
        totalUsd: Math.round(totalUsd),
        touches,
        strength,
        grade,
      };
    });

    // Rank STRONG first, then by combined strength & proximity
    zones.sort((a, b) => {
      if (a.grade !== b.grade) return a.grade === 'STRONG' ? -1 : 1;
      const scoreA = a.strength - Math.abs(a.distPct) * 0.35;
      const scoreB = b.strength - Math.abs(b.distPct) * 0.35;
      return scoreB - scoreA;
    });
    return zones.slice(0, 3);
  };

  const supports = scoreSide('SUPPORT');
  const resistances = scoreSide('RESISTANCE');
  const strongSupports = supports.filter(z => z.grade === 'STRONG');
  const strongResistances = resistances.filter(z => z.grade === 'STRONG');

  return {
    supports,
    resistances,
    strongSupports,
    strongResistances,
    bestSupport: strongSupports[0] || supports[0] || null,
    bestResistance: strongResistances[0] || resistances[0] || null,
  };
}

/**
 * Fetch 3 kline series (15m x 96, 4h x 180, 1d x 365) and compute all 6 CVD S/R timeframes for one symbol.
 */
export async function fetchSymbolCvdSr(symbol, {
  force = false,
  budget = null,
  fetchSeries = fetchOrderflow,
  now = Date.now(),
} = {}) {
  const sym = normalizeOrderflowSymbol(symbol);
  const hit = symbolCache.get(sym);
  if (!force && hit && now - hit.at < SYMBOL_CACHE_TTL_MS) return hit.data;

  const [r15m, r4h, r1d] = await Promise.all([
    fetchSeries(sym, { interval: '15m', limit: 96, force, budget }).catch(() => null),
    fetchSeries(sym, { interval: '4h', limit: 180, force, budget }).catch(() => null),
    fetchSeries(sym, { interval: '1d', limit: 365, force, budget }).catch(() => null),
  ]);

  const bySource = { '15m': r15m, '4h': r4h, '1d': r1d };
  const markPrice =
    num(r15m?.markPrice) ||
    num(r4h?.markPrice) ||
    num(r1d?.markPrice) ||
    num(r15m?.series?.at(-1)?.c) ||
    num(r4h?.series?.at(-1)?.c) ||
    num(r1d?.series?.at(-1)?.c) ||
    0;
  const source = r15m?.source || r4h?.source || r1d?.source || null;

  const timeframes = {};
  let strongCount = 0;
  for (const tf of CVD_SR_TIMEFRAMES) {
    const src = bySource[tf.source];
    const fullSeries = Array.isArray(src?.series) ? src.series : [];
    const sliced = fullSeries.length > tf.slice ? fullSeries.slice(-tf.slice) : fullSeries;
    const res = computeCvdSrZones(sliced, markPrice, { maxDistPct: tf.maxDistPct });
    strongCount += res.strongSupports.length + res.strongResistances.length;
    timeframes[tf.key] = {
      key: tf.key,
      labelKo: tf.labelKo,
      bars: sliced.length,
      ...res,
    };
  }

  const data = {
    symbol: sym,
    displaySymbol: displaySymbol(sym),
    markPrice: round(markPrice, markPrice >= 10 ? 2 : markPrice >= 1 ? 4 : 6),
    source,
    at: now,
    strongCount,
    timeframes,
  };
  symbolCache.set(sym, { at: now, data });
  if (symbolCache.size > 80) symbolCache.delete(symbolCache.keys().next().value);
  return data;
}

/**
 * Scan multiple symbols with bounded concurrency and return a sorted matrix (held positions first).
 */
export async function scanCvdSrMatrix(symbols = [], {
  heldPositions = [],
  concurrency = 3,
  force = false,
  budget = null,
  fetchSeries = fetchOrderflow,
  now = Date.now(),
} = {}) {
  const heldMap = new Map();
  for (const p of Array.isArray(heldPositions) ? heldPositions : []) {
    const s = normalizeOrderflowSymbol(p?.symbol || p?.venueSymbol || '');
    if (!s) continue;
    if (!heldMap.has(s)) heldMap.set(s, []);
    heldMap.get(s).push(p);
  }
  const unique = [...new Set(symbols.map(normalizeOrderflowSymbol).filter(s => /^[A-Z0-9]{4,25}$/.test(s)))];
  const ordered = [
    ...unique.filter(s => heldMap.has(s)),
    ...unique.filter(s => !heldMap.has(s)),
  ];

  const rows = [];
  const limit = Math.max(1, Math.min(6, concurrency));
  for (let i = 0; i < ordered.length; i += limit) {
    const chunk = ordered.slice(i, i + limit);
    const settled = await Promise.all(chunk.map(async sym => {
      try {
        const snap = await fetchSymbolCvdSr(sym, { force, budget, fetchSeries, now });
        const pos = heldMap.get(sym) || [];
        return {
          ...snap,
          held: pos.length > 0,
          directions: [...new Set(pos.map(x => String(x.direction || '').toUpperCase()).filter(Boolean))],
        };
      } catch {
        return null;
      }
    }));
    for (const r of settled) if (r && r.markPrice > 0) rows.push(r);
  }

  return {
    ok: true,
    at: now,
    timeframes: CVD_SR_TIMEFRAMES.map(t => ({ key: t.key, labelKo: t.labelKo })),
    rows,
  };
}

export function clearCvdSrCache() {
  symbolCache.clear();
}

const TF_TOL = Object.fromEntries(CVD_SR_TIMEFRAMES.map(t => [t.key, t.matchTolPct]));
const TF_LABEL = Object.fromEntries(CVD_SR_TIMEFRAMES.map(t => [t.key, t.labelKo]));

export const CVD_SR_TF_STYLE = Object.freeze({
  LIVE: Object.freeze({ tier: 1, bar: '▫', weightKo: '단기' }),
  '1D': Object.freeze({ tier: 2, bar: '▪▪', weightKo: '일간' }),
  '1W': Object.freeze({ tier: 3, bar: '▮▮▮', weightKo: '주간' }),
  '1M': Object.freeze({ tier: 4, bar: '▮▮▮▮', weightKo: '월간' }),
  '6M': Object.freeze({ tier: 5, bar: '█████', weightKo: '대형' }),
  '1Y': Object.freeze({ tier: 6, bar: '██████', weightKo: '초대형' }),
});

/**
 * Evaluate whether a CVD S/R change is FAVORABLE or ADVERSE for the user's held direction(s).
 * - LONG:  SUPPORT ADDED / RESISTANCE REMOVED -> FAVORABLE; RESISTANCE ADDED / SUPPORT REMOVED -> ADVERSE
 * - SHORT: RESISTANCE ADDED / SUPPORT REMOVED -> FAVORABLE; SUPPORT ADDED / RESISTANCE REMOVED -> ADVERSE
 * - Hedged (both LONG & SHORT) or unknown -> NEUTRAL
 */
export function cvdSrPositionSentiment({ directions = [], kind, event = 'ADDED' } = {}) {
  const dirs = [...new Set((Array.isArray(directions) ? directions : [])
    .map(d => String(d || '').toUpperCase())
    .filter(d => d === 'LONG' || d === 'SHORT'))];
  if (dirs.length !== 1) return 'NEUTRAL';
  const isSupport = kind === 'SUPPORT';
  const isAdded = event !== 'REMOVED';
  const bullish = isSupport ? isAdded : !isAdded;
  const favorable = dirs[0] === 'LONG' ? bullish : !bullish;
  return favorable ? 'FAVORABLE' : 'ADVERSE';
}

function sameZonePrice(a, b, tfKey) {
  const tol = TF_TOL[tfKey] || 2.0;
  if (!(a > 0 && b > 0)) return false;
  return (Math.abs(a - b) / b) * 100 <= tol;
}

/** Format a clean, position-aware, timeframe-weighted Telegram alert (NO <pre> / NO <code> / NO <blockquote>). */
export function formatCvdSrChangeMessage({ symbol, directions = [], markPrice = 0, changes = [] }) {
  const sym = displaySymbol(symbol);
  const dirs = [...new Set((Array.isArray(directions) ? directions : [])
    .map(d => String(d || '').toUpperCase())
    .filter(d => d === 'LONG' || d === 'SHORT'))];
  const dirLabel = dirs.length
    ? ` (${dirs.map(d => (d === 'LONG' ? '롱' : '숏')).join('/')})`
    : '';

  const enriched = (Array.isArray(changes) ? changes : []).map(ch => {
    const style = CVD_SR_TF_STYLE[ch.tf] || CVD_SR_TF_STYLE.LIVE;
    const sentiment = ch.sentiment || cvdSrPositionSentiment({ directions: dirs, kind: ch.kind, event: ch.event });
    return { ...ch, style, sentiment };
  });
  // Longest / heaviest timeframe walls first (1Y -> 6M -> 1M -> 1W -> 1D -> LIVE)
  enriched.sort((a, b) => (b.style.tier - a.style.tier) || (Number(b.strength) || 0) - (Number(a.strength) || 0));

  const maxTier = enriched.reduce((m, x) => Math.max(m, x.style.tier), 1);
  const allFav = enriched.length > 0 && enriched.every(x => x.sentiment === 'FAVORABLE');
  const allAdv = enriched.length > 0 && enriched.every(x => x.sentiment === 'ADVERSE');
  let headIcon = '🔔';
  let headTone = 'CVD 지지/저항 변동';
  if (allFav) {
    headIcon = maxTier >= 5 ? '🟩🔥' : maxTier >= 3 ? '🟩' : '🟢';
    headTone = maxTier >= 6 ? 'CVD 초대형 유리' : maxTier >= 5 ? 'CVD 대형 유리' : 'CVD 유리';
  } else if (allAdv) {
    headIcon = maxTier >= 5 ? '🟥🚨' : maxTier >= 3 ? '🟥' : '🔴';
    headTone = maxTier >= 6 ? 'CVD 초대형 주의' : maxTier >= 5 ? 'CVD 대형 주의' : 'CVD 주의';
  }

  const lines = [
    `${headIcon} <b>${escHtml(sym)}${escHtml(dirLabel)} · ${headTone}</b>`,
    `현재가 <b>${escHtml(fmtPrice(markPrice))}</b>`,
  ];

  for (const ch of enriched) {
    const { tier, bar } = ch.style;
    const tfLbl = escHtml(TF_LABEL[ch.tf] || ch.tf);
    const kindKo = ch.kind === 'SUPPORT' ? '지지대' : '저항대';
    const isRem = ch.event === 'REMOVED';
    const evKo = isRem ? '소멸' : '신규';
    const dist = Number.isFinite(Number(ch.distPct))
      ? `${Number(ch.distPct) >= 0 ? '+' : '−'}${Math.abs(Number(ch.distPct)).toFixed(1)}%`
      : '—';

    let icon, badgeText;
    if (ch.sentiment === 'FAVORABLE') {
      icon = tier >= 5 ? '🟩🔥' : tier >= 3 ? '🟩' : '🟢';
      badgeText = tier >= 6 ? '초대형 유리' : tier >= 5 ? '대형 유리' : '유리';
    } else if (ch.sentiment === 'ADVERSE') {
      icon = tier >= 5 ? '🟥🚨' : tier >= 3 ? '🟥' : '🔴';
      badgeText = tier >= 6 ? '초대형 주의' : tier >= 5 ? '대형 주의' : '주의';
    } else {
      icon = tier >= 5 ? '🟨🔥' : tier >= 3 ? '🟨' : isRem ? '⚠️' : '🟡';
      badgeText = tier >= 6 ? `초대형 ${evKo}` : tier >= 5 ? `대형 ${evKo}` : evKo;
    }

    const badgeHtml = tier >= 5 ? `<b><u>${badgeText}</u></b>` : `<b>${badgeText}</b>`;
    const tfHtml = tier >= 5
      ? `<b><u>${tfLbl} ${bar}</u></b>`
      : tier >= 3
        ? `<b>${tfLbl} ${bar}</b>`
        : `${tfLbl} ${bar}`;
    const zoneHtml = tier >= 3 ? `<b>${kindKo} ${evKo}</b>` : `${kindKo} ${evKo}`;

    lines.push('');
    lines.push(`${icon} ${badgeHtml} │ ${tfHtml} │ ${zoneHtml}`);
    if (isRem) {
      const reason = ch.reason === 'PRICE_BREAK' ? '가격 이탈' : '수급 약화·소멸';
      lines.push(`<b>${escHtml(fmtPrice(ch.price))}</b> (${dist}) · ${reason}`);
    } else {
      lines.push(`<b>${escHtml(fmtPrice(ch.price))}</b> (${dist}) · 강도 ${ch.strength} (${escHtml(fmtUsdCompact(ch.netDeltaUsd))})`);
    }
  }
  return lines.join('\n');
}

/**
 * Stateful held-position CVD S/R change monitor.
 * Tracks STRONG zones per held symbol & timeframe, persists to disk, and sends Telegram alerts
 * when a STRONG support/resistance zone is newly ADDED (>=70) or REMOVED (<58 or price broken).
 */
export class CvdSrAlertMonitor {
  constructor({
    directory = null,
    fileName = 'cvd-sr-alerts.json',
    now = () => Date.now(),
    log = () => {},
    sendText = async () => ({ ok: false }),
    cooldownMs = ALERT_COOLDOWN_MS,
  } = {}) {
    Object.assign(this, { now, log, sendText, cooldownMs });
    this.file = directory ? path.join(directory, fileName) : null;
    const saved = this.file && fs.existsSync(this.file) ? readStore(this.file) : null;
    this.store = {
      tracked: saved?.tracked && typeof saved.tracked === 'object' ? saved.tracked : {},
      cooldowns: saved?.cooldowns && typeof saved.cooldowns === 'object' ? saved.cooldowns : {},
      recentEvents: Array.isArray(saved?.recentEvents) ? saved.recentEvents.slice(0, MAX_RECENT_EVENTS) : [],
    };
  }

  #save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteStore(this.file, { version: 1, ...this.store });
  }

  recentEvents() {
    return [...this.store.recentEvents];
  }

  /** Evaluate one held symbol's freshly computed CVD S/R snapshot against saved baseline. */
  async evaluateSymbol(snapshot, { directions = [], now = this.now() } = {}) {
    const sym = normalizeOrderflowSymbol(snapshot?.symbol || '');
    if (!sym || !(Number(snapshot?.markPrice) > 0)) return { changes: [], sent: false };
    const mark = Number(snapshot.markPrice);

    const buildCurrentMap = () => {
      const out = {};
      for (const tf of CVD_SR_TIMEFRAMES) {
        const tfData = snapshot.timeframes?.[tf.key];
        if (!tfData) continue;
        out[tf.key] = {
          SUPPORT: (tfData.strongSupports || []).map(z => ({
            price: z.centerPrice,
            low: z.low,
            high: z.high,
            strength: z.strength,
            netDeltaUsd: z.netDeltaUsd,
            distPct: z.distPct,
          })),
          RESISTANCE: (tfData.strongResistances || []).map(z => ({
            price: z.centerPrice,
            low: z.low,
            high: z.high,
            strength: z.strength,
            netDeltaUsd: z.netDeltaUsd,
            distPct: z.distPct,
          })),
        };
      }
      return out;
    };

    const current = buildCurrentMap();
    const prev = this.store.tracked[sym];

    // First scan of a newly held symbol: record baseline without spamming pre-existing zones.
    if (!prev) {
      this.store.tracked[sym] = { at: now, zones: current };
      this.#save();
      return { changes: [], sent: false, baseline: true };
    }

    const changes = [];
    const nextTracked = {};

    for (const tf of CVD_SR_TIMEFRAMES) {
      const tfKey = tf.key;
      const tfData = snapshot.timeframes?.[tfKey];
      const allSup = tfData?.supports || [];
      const allRes = tfData?.resistances || [];
      nextTracked[tfKey] = { SUPPORT: [], RESISTANCE: [] };

      for (const kind of ['SUPPORT', 'RESISTANCE']) {
        const prevList = prev.zones?.[tfKey]?.[kind] || [];
        const curStrong = current[tfKey]?.[kind] || [];
        const curAll = kind === 'SUPPORT' ? allSup : allRes;
        const kept = [];

        // 1) Check previously tracked STRONG zones for disappearance (with hysteresis exit < 58)
        for (const pz of prevList) {
          const strongMatch = curStrong.find(cz => sameZonePrice(cz.price, pz.price, tfKey));
          if (strongMatch) {
            kept.push(strongMatch);
            continue;
          }
          const hystMatch = curAll.find(cz => cz.strength >= CVD_SR_STRONG_EXIT && sameZonePrice(cz.centerPrice, pz.price, tfKey));
          if (hystMatch) {
            kept.push({
              price: hystMatch.centerPrice,
              low: hystMatch.low,
              high: hystMatch.high,
              strength: hystMatch.strength,
              netDeltaUsd: hystMatch.netDeltaUsd,
              distPct: hystMatch.distPct,
            });
            continue;
          }
          // Disappeared!
          const broken = kind === 'SUPPORT' ? mark <= pz.price : mark >= pz.price;
          const distPct = round(((pz.price - mark) / mark) * 100, 2);
          const cdKey = `${sym}|${tfKey}|${kind}|REMOVED`;
          const lastAt = Number(this.store.cooldowns[cdKey]) || 0;
          if (now - lastAt >= this.cooldownMs) {
            this.store.cooldowns[cdKey] = now;
            changes.push({
              event: 'REMOVED',
              symbol: sym,
              displaySymbol: displaySymbol(sym),
              directions: [...directions],
              sentiment: cvdSrPositionSentiment({ directions, kind, event: 'REMOVED' }),
              tf: tfKey,
              kind,
              price: pz.price,
              distPct,
              reason: broken ? 'PRICE_BREAK' : 'WEAKENED',
              at: now,
            });
          }
        }

        // 2) Check newly ADDED STRONG zones (>= 70) that were not in prevList
        for (const cz of curStrong) {
          const existed = prevList.some(pz => sameZonePrice(cz.price, pz.price, tfKey));
          if (!existed) {
            kept.push(cz);
            const cdKey = `${sym}|${tfKey}|${kind}|ADDED`;
            const lastAt = Number(this.store.cooldowns[cdKey]) || 0;
            if (now - lastAt >= this.cooldownMs) {
              this.store.cooldowns[cdKey] = now;
              changes.push({
                event: 'ADDED',
                symbol: sym,
                displaySymbol: displaySymbol(sym),
                directions: [...directions],
                sentiment: cvdSrPositionSentiment({ directions, kind, event: 'ADDED' }),
                tf: tfKey,
                kind,
                price: cz.price,
                distPct: cz.distPct,
                strength: cz.strength,
                netDeltaUsd: cz.netDeltaUsd,
                at: now,
              });
            }
          }
        }

        nextTracked[tfKey][kind] = kept;
      }
    }

    this.store.tracked[sym] = { at: now, zones: nextTracked };

    // Prune stale cooldown entries older than 2x cooldown
    for (const [k, at] of Object.entries(this.store.cooldowns)) {
      if (now - Number(at) > this.cooldownMs * 2) delete this.store.cooldowns[k];
    }

    let sent = false;
    if (changes.length) {
      for (const ch of changes) this.store.recentEvents.unshift(ch);
      this.store.recentEvents = this.store.recentEvents.slice(0, MAX_RECENT_EVENTS);
      const text = formatCvdSrChangeMessage({ symbol: sym, directions, markPrice: mark, changes });
      try {
        await this.sendText(text);
        sent = true;
      } catch (e) {
        this.log('[CVD_SR] telegram send failed', e?.message || 'ERROR');
      }
    }
    this.#save();
    return { changes, sent };
  }

  /** Prune symbols no longer held so closed positions don't linger. */
  pruneClosed(openSymbols = []) {
    const keep = new Set((Array.isArray(openSymbols) ? openSymbols : []).map(normalizeOrderflowSymbol));
    let dirty = false;
    for (const sym of Object.keys(this.store.tracked)) {
      if (!keep.has(sym)) {
        delete this.store.tracked[sym];
        dirty = true;
      }
    }
    if (dirty) this.#save();
  }

  /** Scan all currently held real-account positions and fire Telegram alerts on ADDED/REMOVED strong zones. */
  async checkHeldPositions(heldPositions = [], { fetchSeries = fetchOrderflow, budget = null, now = this.now() } = {}) {
    const bySym = new Map();
    for (const p of Array.isArray(heldPositions) ? heldPositions : []) {
      const sym = normalizeOrderflowSymbol(p?.symbol || p?.venueSymbol || '');
      if (!sym || !/^[A-Z0-9]{4,25}$/.test(sym)) continue;
      if (!bySym.has(sym)) bySym.set(sym, new Set());
      const dir = String(p?.direction || '').toUpperCase();
      if (dir) bySym.get(sym).add(dir);
    }
    const openSymbols = [...bySym.keys()];
    this.pruneClosed(openSymbols);
    const results = [];
    for (const sym of openSymbols) {
      try {
        const snap = await fetchSymbolCvdSr(sym, { fetchSeries, budget, now });
        const res = await this.evaluateSymbol(snap, { directions: [...bySym.get(sym)], now });
        if (res.changes.length) results.push({ symbol: sym, ...res });
      } catch (e) {
        this.log('[CVD_SR] check failed', sym, e?.message || 'ERROR');
      }
    }
    return results;
  }
}
