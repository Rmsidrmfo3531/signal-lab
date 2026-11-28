// 「2% 매매법」 양방향(롱·숏 대칭):
//  - 급등(UP → LONG): 15분봉 +2%↑ 강한 양봉(마루보즈) → 후속 15분봉 아래꼬리 형성 후 양봉 전환 롱 진입
//    → 아래꼬리 저점 손절(SL) → 일봉(1D) 주요 저항선 익절(TP) · 최소 1:2 순손익비 · 기본 20배
//  - 급락(DOWN → SHORT): 15분봉 −2%↑ 강한 음봉(마루보즈) → 후속 15분봉 윗꼬리 형성 후 음봉 전환 숏 진입
//    → 윗꼬리 고점 손절(SL) → 일봉(1D) 주요 지지선 익절(TP) · 최소 1:2 순손익비 · 기본 20배
// Coin selection & direction come from @ggangalt2_bot (pump_alert.mjs -> scalp_executor.mjs pumpAlert).
// Pure detection & daily-level calculation module; no network calls or side effects.

export const TWO_PCT_INTERVAL = '15m';
export const TWO_PCT_INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TWO_PCT_DEFAULTS = Object.freeze({
 interval: TWO_PCT_INTERVAL,
 intervalMs: TWO_PCT_INTERVAL_MS,
 // 기준봉 조건: 15분봉 최소 ±2% 몸통, 마루보즈/강한 추세봉 (진행 방향 꼬리 짧고 몸통 큼)
 minBodyPct: 2.0,
 minBodyRatio: 0.60,
 maxUpperWickRatio: 0.25,
 maxUpperToBody: 0.45,
 // 기준봉 뒤 후속 캔들 허용 개수 (첫 타점 + 추세 유지 시 후속 응용 진입)
 maxFollowBars: 3,
 // 진입 캔들 조건: 시가 반대로 눌려 꼬리 형성 뒤 방향 전환 (역방향 봉 상태 진입 금지)
 minLowerWickPct: 0.25,
 minFlipAboveOpenPct: 0.05,
 // 손절(SL) 적절성 범위: 너무 좁아 수수료/노이즈에 털리거나 너무 넓어 청산 위험 큰 자리 차단 (2026-11-27 튜닝: 2.2% / 45% ROE 상한)
 minStopPct: 0.40,
 maxStopPct: 2.20,
 maxStopRoePct: 45,
 // 손익비 & 일봉(1D) 저항/지지 TP + 1차 분할 익절(1:2 RR 50% + 본전 스탑) + 과도한 먼 TP 상한
 minNetRR: 2.0,
 partialTpRR: 2.0,
 maxTpRR: 6.0,
 maxTpDistPct: 8.0,
 athFallbackRR: 2.5,
 resistanceClusterPct: 0.8,
 resistanceBufferPct: 0.1,
 minDailyCandles: 3,
 // 동일 종목 연속 재진입 방지 쿨다운 (손절 후 4시간, 익절 후 1시간)
 lossCooldownMin: 240,
 winCooldownMin: 60,
 // 레버리지 & 감시/보유 시간
 leverage: 20,
 watchMin: 45,
 pollMs: 15000,
 maxHoldMs: DAY_MS,
});

const pos = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;

function parseBar(r) {
 if (!Array.isArray(r) || r.length < 7) return null;
 const openTime = Number(r[0]), open = pos(r[1]), high = pos(r[2]), low = pos(r[3]), close = pos(r[4]);
 const volume = Number(r[5]), closeTime = Number(r[6]);
 if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || !(closeTime > openTime)) return null;
 if (!open || !high || !low || !close) return null;
 if (high < Math.max(open, close) - 1e-12 || low > Math.min(open, close) + 1e-12) return null;
 return { openTime, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0, closeTime };
}

/** Validate a closed 15m candle as a strong >=2% trend reference candle (Marubozu / body-dominant)
 * for LONG (bullish, short upper wick) or SHORT (bearish, short lower wick). */
export function isStrongTrendCandle(row, direction = 'LONG', cfg = TWO_PCT_DEFAULTS) {
 const isShort = direction === 'SHORT';
 const dir = isShort ? -1 : 1;
 const b = row && typeof row === 'object' && !Array.isArray(row) ? row : parseBar(row);
 if (!b) return { ok: false, reason: 'INVALID_BAR' };
 const body = dir * (b.close - b.open);
 const range = b.high - b.low;
 if (!(body > 0 && range > 0)) return { ok: false, reason: isShort ? 'NOT_BEARISH' : 'NOT_BULLISH' };
 const bodyPct = (body / b.open) * 100;
 const bodyRatio = body / range;
 // Leading wick in the direction of the impulse (upper wick for bullish, lower wick for bearish)
 const leadWick = isShort ? Math.max(0, b.close - b.low) : Math.max(0, b.high - b.close);
 const leadWickRatio = leadWick / range;
 const leadToBody = leadWick / body;
 const minBodyPct = Number(cfg.minBodyPct ?? TWO_PCT_DEFAULTS.minBodyPct);
 const minBodyRatio = Number(cfg.minBodyRatio ?? TWO_PCT_DEFAULTS.minBodyRatio);
 const maxLeadWickRatio = Number(cfg.maxUpperWickRatio ?? TWO_PCT_DEFAULTS.maxUpperWickRatio);
 const maxLeadToBody = Number(cfg.maxUpperToBody ?? TWO_PCT_DEFAULTS.maxUpperToBody);
 const ok = bodyPct >= minBodyPct && bodyRatio >= minBodyRatio && leadWickRatio <= maxLeadWickRatio && leadToBody <= maxLeadToBody;
 return {
  ok,
  direction: isShort ? 'SHORT' : 'LONG',
  openTime: b.openTime,
  closeTime: b.closeTime,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  bodyPct: r4(bodyPct),
  bodyRatio: r4(bodyRatio),
  upperWickRatio: r4(leadWickRatio),
  leadWickRatio: r4(leadWickRatio),
 };
}

/** Backward-compatible LONG wrapper for isStrongTrendCandle. */
export function isStrongBullishCandle(row, cfg = TWO_PCT_DEFAULTS) {
 return isStrongTrendCandle(row, 'LONG', cfg);
}

/** Round-trip cost in price units (matching scalp_reversal.mjs buildScalpPlan). */
export function twoPctRoundTripCost(entry, costs = {}) {
 const takerRate = Number(costs.takerRate) || 0.0005;
 const slippageBps = Number(costs.slippageBps) || 2;
 const spreadBps = Math.max(0, Number(costs.spreadBps) || 2);
 const fundingRate = Math.abs(Number(costs.fundingRate) || 0);
 return entry * (2 * takerRate + (2 * slippageBps + spreadBps) / 10000 + fundingRate);
}

/** Extract major 1D target levels from closed daily candles:
 *  - LONG: overhead 1D resistance levels strictly above entry (swing highs, prior high, 7/30/90/180D highs, bearish supply opens).
 *  - SHORT: underlying 1D support levels strictly below entry (swing lows, prior low, 7/30/90/180D lows, bullish demand opens). */
export function findDailyLevels(dailyRows, {
 now = Date.now(),
 entry,
 direction = 'LONG',
 clusterPct = TWO_PCT_DEFAULTS.resistanceClusterPct,
 bufferPct = TWO_PCT_DEFAULTS.resistanceBufferPct,
 minCandles = TWO_PCT_DEFAULTS.minDailyCandles,
} = {}) {
 const isShort = direction === 'SHORT';
 const px = pos(entry);
 const empty = {
  ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', direction: isShort ? 'SHORT' : 'LONG',
  levels: [], nearest: null, allTimeHigh: null, allTimeLow: null, isPriceDiscovery: false, dailyCount: 0,
 };
 if (!px || !Array.isArray(dailyRows)) return empty;
 const closed = dailyRows
  .map(parseBar)
  .filter(b => b && b.closeTime < now)
  .sort((a, b) => a.openTime - b.openTime);
 if (closed.length < minCandles) return { ...empty, dailyCount: closed.length };

 const allTimeHigh = Math.max(...closed.map(b => b.high));
 const allTimeLow = Math.min(...closed.map(b => b.low));
 const raw = [];
 if (!isShort) {
  const minAbove = px * 1.003;
  const add = (price, kind, strength) => { if (Number.isFinite(price) && price > minAbove) raw.push({ price, kind, strength }); };
  for (let i = 1; i < closed.length - 1; i++) {
   const h = closed[i].high;
   if (h >= closed[i - 1].high && h >= closed[i + 1].high) {
    const strong2 = i >= 2 && i < closed.length - 2 && h >= closed[i - 2].high && h >= closed[i + 2].high;
    add(h, strong2 ? '1D_MAJOR_SWING' : '1D_SWING', strong2 ? 3 : 2);
   }
  }
  add(closed.at(-1).high, '1D_PREV_HIGH', 2);
  for (const [days, kind, strength] of [[7, '1D_7D_HIGH', 2], [30, '1D_30D_HIGH', 3], [90, '1D_90D_HIGH', 3], [180, '1D_180D_HIGH', 3]]) {
   const slice = closed.slice(-days);
   if (slice.length >= Math.min(days, minCandles)) add(Math.max(...slice.map(b => b.high)), kind, strength);
  }
  for (const b of closed.slice(-60)) {
   if (b.open > b.close && (b.open - b.close) / b.open >= 0.03) add(b.open, '1D_SUPPLY_OPEN', 1);
  }
  raw.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const cand of raw) {
   const last = clusters.at(-1);
   if (last && ((cand.price - last.edgePrice) / last.edgePrice) * 100 <= clusterPct) {
    last.strength += cand.strength;
    last.count += 1;
    if (cand.strength > last.topStrength) { last.topStrength = cand.strength; last.kind = cand.kind; }
   } else {
    clusters.push({ edgePrice: cand.price, kind: cand.kind, strength: cand.strength, topStrength: cand.strength, count: 1 });
   }
  }
  const levels = clusters.map(c => {
   const targetPrice = Math.max(px * 1.001, c.edgePrice * (1 - bufferPct / 100));
   return { price: +c.edgePrice.toPrecision(8), targetPrice: +targetPrice.toPrecision(8), kind: c.kind, strength: c.strength, count: c.count };
  });
  return {
   ok: true, direction: 'LONG', levels, nearest: levels[0] ?? null,
   allTimeHigh: +allTimeHigh.toPrecision(8), allTimeLow: +allTimeLow.toPrecision(8),
   isPriceDiscovery: levels.length === 0 && px >= allTimeHigh * 0.997,
   dailyCount: closed.length,
  };
 }

 // SHORT: underlying 1D support levels strictly below entry (sorted descending: nearest support first)
 const maxBelow = px * 0.997;
 const add = (price, kind, strength) => { if (Number.isFinite(price) && price > 0 && price < maxBelow) raw.push({ price, kind, strength }); };
 for (let i = 1; i < closed.length - 1; i++) {
  const l = closed[i].low;
  if (l <= closed[i - 1].low && l <= closed[i + 1].low) {
   const strong2 = i >= 2 && i < closed.length - 2 && l <= closed[i - 2].low && l <= closed[i + 2].low;
   add(l, strong2 ? '1D_MAJOR_SWING' : '1D_SWING', strong2 ? 3 : 2);
  }
 }
 add(closed.at(-1).low, '1D_PREV_LOW', 2);
 for (const [days, kind, strength] of [[7, '1D_7D_LOW', 2], [30, '1D_30D_LOW', 3], [90, '1D_90D_LOW', 3], [180, '1D_180D_LOW', 3]]) {
  const slice = closed.slice(-days);
  if (slice.length >= Math.min(days, minCandles)) add(Math.min(...slice.map(b => b.low)), kind, strength);
 }
 for (const b of closed.slice(-60)) {
  if (b.close > b.open && (b.close - b.open) / b.open >= 0.03) add(b.open, '1D_DEMAND_OPEN', 1);
 }
 raw.sort((a, b) => b.price - a.price);
 const clusters = [];
 for (const cand of raw) {
  const last = clusters.at(-1);
  // Keep conservative highest price of support cluster (closest to entry)
  if (last && ((last.edgePrice - cand.price) / last.edgePrice) * 100 <= clusterPct) {
   last.strength += cand.strength;
   last.count += 1;
   if (cand.strength > last.topStrength) { last.topStrength = cand.strength; last.kind = cand.kind; }
  } else {
   clusters.push({ edgePrice: cand.price, kind: cand.kind, strength: cand.strength, topStrength: cand.strength, count: 1 });
  }
 }
 const levels = clusters.map(c => {
  const targetPrice = Math.min(px * 0.999, c.edgePrice * (1 + bufferPct / 100));
  return { price: +c.edgePrice.toPrecision(8), targetPrice: +targetPrice.toPrecision(8), kind: c.kind, strength: c.strength, count: c.count };
 });
 return {
  ok: true, direction: 'SHORT', levels, nearest: levels[0] ?? null,
  allTimeHigh: +allTimeHigh.toPrecision(8), allTimeLow: +allTimeLow.toPrecision(8),
  isPriceDiscovery: levels.length === 0 && px <= allTimeLow * 1.003,
  dailyCount: closed.length,
 };
}

/** Backward-compatible LONG alias for findDailyLevels. */
export function findDailyResistances(dailyRows, opts = {}) {
 return findDailyLevels(dailyRows, { ...opts, direction: 'LONG' });
}

/** Compute simple 15m ATR (average true range in price units) for plan drift tolerance. */
function simpleAtr(bars, period = 14) {
 if (!Array.isArray(bars) || bars.length < 2) return null;
 const slice = bars.slice(-(period + 1));
 const trs = [];
 for (let i = 1; i < slice.length; i++) {
  const cur = slice[i], prev = slice[i - 1];
  trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
 }
 return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
}

/** Detect an actionable 「2% 매매법」 LONG (UP) or SHORT (DOWN) setup on 15m + 1D candles.
 * Returns { ok: true, direction, entry, stop, tp, netRR, ... } or { ok: false, reason, detail }. */
export function detectTwoPctSetup({
 rows15m,
 rows1d,
 direction = 'LONG',
 livePrice = null,
 now = Date.now(),
 leverage = TWO_PCT_DEFAULTS.leverage,
 costs = { takerRate: 0.0005, slippageBps: 2, spreadBps: 2, fundingRate: 0 },
 config = {},
} = {}) {
 const isShort = direction === 'SHORT';
 const dir = isShort ? -1 : 1;
 const sideName = isShort ? 'SHORT' : 'LONG';
 const cfg = { ...TWO_PCT_DEFAULTS, ...config };
 const parsed = (Array.isArray(rows15m) ? rows15m : [])
  .map(parseBar)
  .filter(Boolean)
  .sort((a, b) => a.openTime - b.openTime);
 if (parsed.length < 2) {
  return { ok: false, reason: 'TWO_PCT_NO_BASE_CANDLE', detail: '15m 캔들 부족' };
 }
 // Verify candle timeframe is genuinely 15m (reject 1m/5m feeds).
 const spanSample = parsed.slice(-3).map(b => b.closeTime - b.openTime);
 if (spanSample.some(ms => ms < 14 * 60000 || ms > 16 * 60000)) {
  return { ok: false, reason: 'SCALP_INTERVAL_UNSUPPORTED', detail: '15분봉 전용' };
 }
 // Separate closed 15m candles and the currently forming 15m candle.
 const closed = parsed.filter(b => b.closeTime < now);
 const forming = parsed.find(b => b.openTime <= now && now <= b.closeTime + 1000) ?? null;
 if (!closed.length) {
  return { ok: false, reason: 'TWO_PCT_NO_BASE_CANDLE', detail: '마감된 15분봉 없음' };
 }
 if (!forming) {
  return { ok: false, reason: 'TWO_PCT_WAIT_GREEN_FLIP', detail: '진행 중 15분봉 대기' };
 }
 // Find the most recent strong >=2% trend reference candle within maxFollowBars closed candles.
 const recentClosed = closed.filter(b => b.openTime < forming.openTime).slice(-Math.max(1, cfg.maxFollowBars));
 let base = null;
 let baseIdx = -1;
 for (let i = recentClosed.length - 1; i >= 0; i--) {
  const check = isStrongTrendCandle(recentClosed[i], sideName, cfg);
  if (check.ok) {
   const barsSince = Math.round((forming.openTime - recentClosed[i].openTime) / TWO_PCT_INTERVAL_MS);
   if (barsSince >= 1 && barsSince <= cfg.maxFollowBars) {
    base = { ...check, barsSince };
    baseIdx = i;
    break;
   }
  }
 }
 if (!base) {
  const last = recentClosed.at(-1);
  const lastPct = last ? (((last.close - last.open) / last.open) * 100).toFixed(2) : '—';
  return {
   ok: false,
   reason: 'TWO_PCT_NO_BASE_CANDLE',
   detail: `직전 15m ${lastPct}% (기준 ${isShort ? '−' : '+'}${cfg.minBodyPct}%↑ 마루보즈)`,
  };
 }
 // Check trend integrity on any closed candles between base and forming.
 const between = recentClosed.slice(baseIdx + 1);
 if (between.some(b => dir * (b.close - base.open) < 0)) {
  return { ok: false, reason: 'TWO_PCT_TREND_BROKEN', detail: `후속 15m 종가가 기준봉 시가(${base.open}) 이탈` };
 }
 // Evaluate current forming 15m candle:
 //  - LONG: dip below open (lower wick) then flip bullish (curPrice > curOpen)
 //  - SHORT: bounce above open (upper wick) then flip bearish (curPrice < curOpen)
 const curOpen = forming.open;
 const curPrice = pos(livePrice) ?? forming.close;
 const curLow = Math.min(forming.low, curPrice);
 const curHigh = Math.max(forming.high, curPrice);
 if (!(dir * (curPrice - curOpen) > 0)) {
  const chg = (((curPrice - curOpen) / curOpen) * 100).toFixed(2);
  return {
   ok: false,
   reason: 'TWO_PCT_WAIT_GREEN_FLIP',
   detail: isShort ? `15m 양봉 +${chg}% · 음봉 전환 대기` : `15m 음봉 ${chg}% · 양봉 전환 대기`,
  };
 }
 const wickPct = isShort ? ((curHigh - curOpen) / curOpen) * 100 : ((curOpen - curLow) / curOpen) * 100;
 const hasWick = isShort ? curHigh > curOpen : curLow < curOpen;
 if (!(hasWick && wickPct >= cfg.minLowerWickPct)) {
  return {
   ok: false,
   reason: 'TWO_PCT_NO_LOWER_WICK',
   detail: `${isShort ? '윗꼬리' : '아래꼬리'} ${wickPct.toFixed(2)}% < ${cfg.minLowerWickPct}%`,
  };
 }
 const flipPct = (dir * (curPrice - curOpen) / curOpen) * 100;
 if (flipPct < cfg.minFlipAboveOpenPct) {
  return {
   ok: false,
   reason: 'TWO_PCT_WAIT_GREEN_FLIP',
   detail: `${isShort ? '음봉' : '양봉'} 전환 폭 ${flipPct.toFixed(2)}% < ${cfg.minFlipAboveOpenPct}%`,
  };
 }
 // Stop-loss = lower-wick low (LONG) or upper-wick high (SHORT), validated for tightness and liquidation safety.
 const stop = isShort ? curHigh : curLow;
 const stopDistPct = (dir * (curPrice - stop) / curPrice) * 100;
 if (stopDistPct < cfg.minStopPct) {
  return { ok: false, reason: 'TWO_PCT_STOP_TOO_TIGHT', detail: `손절폭 ${stopDistPct.toFixed(2)}% < ${cfg.minStopPct}%` };
 }
 const effLev = Math.max(1, Math.floor(Number(leverage) || cfg.leverage));
 const maxStopAllowed = Math.min(cfg.maxStopPct, cfg.maxStopRoePct / effLev);
 if (stopDistPct > maxStopAllowed) {
  return { ok: false, reason: 'TWO_PCT_STOP_TOO_WIDE', detail: `손절폭 ${stopDistPct.toFixed(2)}% > ${maxStopAllowed.toFixed(2)}% (${effLev}배 한도)` };
 }
 // Daily (1D) resistance (LONG) / support (SHORT) & minimum 1:2 net risk:reward verification.
 const daily = findDailyLevels(rows1d, {
  now,
  entry: curPrice,
  direction: sideName,
  clusterPct: cfg.resistanceClusterPct,
  bufferPct: cfg.resistanceBufferPct,
  minCandles: cfg.minDailyCandles,
 });
 if (!daily.ok) {
  return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', detail: `일봉 ${daily.dailyCount}개` };
 }
 const roundTrip = twoPctRoundTripCost(curPrice, costs);
 const risk = Math.abs(curPrice - stop);
 let rawTp, rawNetRR, tpSource, level = null;
 if (daily.nearest) {
  rawTp = daily.nearest.targetPrice;
  rawNetRR = (dir * (rawTp - curPrice) - roundTrip) / (risk + roundTrip);
  tpSource = isShort ? 'DAILY_SUPPORT' : 'DAILY_RESISTANCE';
  level = daily.nearest;
  if (!(rawNetRR >= cfg.minNetRR)) {
   return {
    ok: false,
    reason: 'TWO_PCT_RR_BELOW_MIN',
    detail: `1D ${isShort ? '지지' : '저항'} ${daily.nearest.price} · 손익비 1:${Number.isFinite(rawNetRR) ? Math.max(0, rawNetRR).toFixed(2) : '0'} < 1:${cfg.minNetRR}`,
   };
  }
 } else if (daily.isPriceDiscovery) {
  const discTp = curPrice + dir * (roundTrip + cfg.athFallbackRR * (risk + roundTrip));
  if (!(discTp > curPrice * 0.05)) {
   return { ok: false, reason: 'TWO_PCT_RR_BELOW_MIN', detail: '신저점 목표가 산출 불가' };
  }
  rawTp = discTp;
  rawNetRR = cfg.athFallbackRR;
  tpSource = isShort ? 'ATL_BREAKDOWN_RR' : 'ATH_BREAKOUT_RR';
 } else {
  return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', detail: `1D ${isShort ? '지지선' : '저항선'} 산출 불가` };
 }
 // Cap unrealistic distant 1D targets (e.g. +112% / RR 38) to a realistic swing ceiling while preserving >= minNetRR.
 const tpMin = curPrice + dir * (roundTrip + cfg.minNetRR * (risk + roundTrip));
 const maxTpRR = Number(cfg.maxTpRR ?? TWO_PCT_DEFAULTS.maxTpRR);
 const maxTpDistPct = Number(cfg.maxTpDistPct ?? TWO_PCT_DEFAULTS.maxTpDistPct);
 const capCandidates = [rawTp];
 if (Number.isFinite(maxTpRR) && maxTpRR >= cfg.minNetRR) {
  const atMaxRR = curPrice + dir * (roundTrip + maxTpRR * (risk + roundTrip));
  if (atMaxRR > curPrice * 0.05) capCandidates.push(atMaxRR);
 }
 if (Number.isFinite(maxTpDistPct) && maxTpDistPct > 0) {
  const atMaxDist = curPrice * (1 + (dir * maxTpDistPct) / 100);
  if (atMaxDist > curPrice * 0.05) capCandidates.push(atMaxDist);
 }
 const rawCapped = dir > 0 ? Math.min(...capCandidates) : Math.max(...capCandidates);
 const tp2 = +(dir > 0 ? Math.max(tpMin, rawCapped) : Math.min(tpMin, rawCapped)).toPrecision(8);
 const tpCapped = dir * (rawTp - tp2) > Math.max(1e-12, curPrice * 1e-5);
 const netRR = (dir * (tp2 - curPrice) - roundTrip) / (risk + roundTrip);
 // 2-stage exit: 50% at 1:2 RR (locks profit + auto breakeven stop) + 50% runner to capped 1D target.
 const partialRR = Number(cfg.partialTpRR ?? TWO_PCT_DEFAULTS.partialTpRR);
 const splitPartial = Number.isFinite(partialRR) && partialRR >= cfg.minNetRR && netRR >= partialRR + 0.35;
 const tp1 = splitPartial ? +(curPrice + dir * (roundTrip + partialRR * (risk + roundTrip))).toPrecision(8) : tp2;
 const targets = splitPartial ? [tp1, tp2] : [tp2];
 const atr = simpleAtr(closed) ?? Math.max(risk, curPrice * 0.015);
 return {
  ok: true,
  direction: sideName,
  interval: TWO_PCT_INTERVAL,
  entry: curPrice,
  stop,
  tp: tp2,
  tp1,
  tp2,
  targets,
  splitPartial,
  tpCapped,
  rawDailyTp: +rawTp.toPrecision(8),
  netRR: r4(netRR),
  tp1NetRR: r4(splitPartial ? partialRR : netRR),
  stopDistPct: r4(stopDistPct),
  lowerWickPct: r4(wickPct),
  wickPct: r4(wickPct),
  flipPct: r4(flipPct),
  leverage: effLev,
  tpSource,
  resistance: level,
  targetLevel: level,
  allTimeHigh: daily.allTimeHigh,
  allTimeLow: daily.allTimeLow,
  atr,
  baseCandle: base,
  entryCandle: {
   openTime: forming.openTime,
   closeTime: forming.closeTime,
   open: curOpen,
   low: curLow,
   high: curHigh,
   price: curPrice,
   lowerWickPct: r4(wickPct),
   wickPct: r4(wickPct),
   flipPct: r4(flipPct),
  },
 };
}
