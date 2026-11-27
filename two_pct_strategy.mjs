// 「2% 매매법」 (15분봉 +2% 이상 강한 양봉 → 후속 15분봉 아래꼬리 형성 후 양봉 전환 롱 진입
//  → 아래꼬리 저점 손절 → 일봉(1D) 주요 저항선 익절 · 최소 1:2 순손익비 · 기본 20배 레버리지).
// Coin selection is supplied by @ggangalt2_bot (pump_alert.mjs -> scalp_executor.mjs pumpAlert).
// Pure detection & daily-resistance calculation module; no network calls or side effects.

export const TWO_PCT_INTERVAL = '15m';
export const TWO_PCT_INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TWO_PCT_DEFAULTS = Object.freeze({
 interval: TWO_PCT_INTERVAL,
 intervalMs: TWO_PCT_INTERVAL_MS,
 // 기준 양봉 조건: 15분봉 최소 +2% 몸통, 마루보즈/강한 양봉 (윗꼬리 짧고 몸통 큼)
 minBodyPct: 2.0,
 minBodyRatio: 0.60,
 maxUpperWickRatio: 0.25,
 maxUpperToBody: 0.45,
 // 기준 양봉 뒤 후속 캔들 허용 개수 (첫 타점 + 상승 추세 유지 시 후속 응용 진입)
 maxFollowBars: 3,
 // 진입 캔들 조건: 시가 아래로 눌려 아래꼬리 형성 뒤 양봉 전환 (음봉 상태 진입 금지)
 minLowerWickPct: 0.25,
 minFlipAboveOpenPct: 0.05,
 // 손절(SL) 적절성 범위: 너무 좁아 수수료/노이즈에 털리거나 너무 넓어 청산 위험 큰 자리 차단
 minStopPct: 0.40,
 maxStopPct: 3.50,
 maxStopRoePct: 70,
 // 손익비 & 일봉(1D) 저항선 TP
 minNetRR: 2.0,
 athFallbackRR: 2.5,
 resistanceClusterPct: 0.8,
 resistanceBufferPct: 0.1,
 minDailyCandles: 3,
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

/** Validate a closed 15m candle as a strong >=2% bullish reference candle (Marubozu / body-dominant). */
export function isStrongBullishCandle(row, cfg = TWO_PCT_DEFAULTS) {
 const b = row && typeof row === 'object' && !Array.isArray(row) ? row : parseBar(row);
 if (!b) return { ok: false, reason: 'INVALID_BAR' };
 const body = b.close - b.open;
 const range = b.high - b.low;
 if (!(body > 0 && range > 0)) return { ok: false, reason: 'NOT_BULLISH' };
 const bodyPct = (body / b.open) * 100;
 const bodyRatio = body / range;
 const upperWick = Math.max(0, b.high - b.close);
 const upperWickRatio = upperWick / range;
 const upperToBody = upperWick / body;
 const minBodyPct = Number(cfg.minBodyPct ?? TWO_PCT_DEFAULTS.minBodyPct);
 const minBodyRatio = Number(cfg.minBodyRatio ?? TWO_PCT_DEFAULTS.minBodyRatio);
 const maxUpperWickRatio = Number(cfg.maxUpperWickRatio ?? TWO_PCT_DEFAULTS.maxUpperWickRatio);
 const maxUpperToBody = Number(cfg.maxUpperToBody ?? TWO_PCT_DEFAULTS.maxUpperToBody);
 const ok = bodyPct >= minBodyPct && bodyRatio >= minBodyRatio && upperWickRatio <= maxUpperWickRatio && upperToBody <= maxUpperToBody;
 return {
  ok,
  openTime: b.openTime,
  closeTime: b.closeTime,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  bodyPct: r4(bodyPct),
  bodyRatio: r4(bodyRatio),
  upperWickRatio: r4(upperWickRatio),
 };
}

/** Round-trip cost in price units (matching scalp_reversal.mjs buildScalpPlan). */
export function twoPctRoundTripCost(entry, costs = {}) {
 const takerRate = Number(costs.takerRate) || 0.0005;
 const slippageBps = Number(costs.slippageBps) || 2;
 const spreadBps = Math.max(0, Number(costs.spreadBps) || 2);
 const fundingRate = Math.abs(Number(costs.fundingRate) || 0);
 return entry * (2 * takerRate + (2 * slippageBps + spreadBps) / 10000 + fundingRate);
}

/** Extract major 1D overhead resistance levels strictly above entry from closed daily candles.
 * Combines 1D swing highs (1-bar & 2-bar pivots), prior day high, rolling 7D/30D/90D/180D highs,
 * and major bearish daily opens (>=3% drop), clustered conservatively to avoid overshooting walls. */
export function findDailyResistances(dailyRows, {
 now = Date.now(),
 entry,
 clusterPct = TWO_PCT_DEFAULTS.resistanceClusterPct,
 bufferPct = TWO_PCT_DEFAULTS.resistanceBufferPct,
 minCandles = TWO_PCT_DEFAULTS.minDailyCandles,
} = {}) {
 const px = pos(entry);
 if (!px || !Array.isArray(dailyRows)) return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', levels: [], nearest: null, allTimeHigh: null, isPriceDiscovery: false, dailyCount: 0 };
 const closed = dailyRows
  .map(parseBar)
  .filter(b => b && b.closeTime < now)
  .sort((a, b) => a.openTime - b.openTime);
 if (closed.length < minCandles) {
  return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', levels: [], nearest: null, allTimeHigh: null, isPriceDiscovery: false, dailyCount: closed.length };
 }
 const allTimeHigh = Math.max(...closed.map(b => b.high));
 const minAbove = px * 1.003;
 const raw = [];
 const add = (price, kind, strength) => {
  if (Number.isFinite(price) && price > minAbove) raw.push({ price, kind, strength });
 };
 // 1) 1D swing highs (pivot peaks)
 for (let i = 1; i < closed.length - 1; i++) {
  const h = closed[i].high;
  if (h >= closed[i - 1].high && h >= closed[i + 1].high) {
   const strong2 = i >= 2 && i < closed.length - 2 && h >= closed[i - 2].high && h >= closed[i + 2].high;
   add(h, strong2 ? '1D_MAJOR_SWING' : '1D_SWING', strong2 ? 3 : 2);
  }
 }
 // 2) Prior closed 1D high
 add(closed.at(-1).high, '1D_PREV_HIGH', 2);
 // 3) Rolling multi-day highs
 for (const [days, kind, strength] of [[7, '1D_7D_HIGH', 2], [30, '1D_30D_HIGH', 3], [90, '1D_90D_HIGH', 3], [180, '1D_180D_HIGH', 3]]) {
  const slice = closed.slice(-days);
  if (slice.length >= Math.min(days, minCandles)) {
   add(Math.max(...slice.map(b => b.high)), kind, strength);
  }
 }
 // 4) Major bearish 1D candle opens (institutional supply start, >=3% red body)
 for (const b of closed.slice(-60)) {
  if (b.open > b.close && (b.open - b.close) / b.open >= 0.03) {
   add(b.open, '1D_SUPPLY_OPEN', 1);
  }
 }
 raw.sort((a, b) => a.price - b.price);
 const clusters = [];
 for (const cand of raw) {
  const last = clusters.at(-1);
  if (last && ((cand.price - last.lowPrice) / last.lowPrice) * 100 <= clusterPct) {
   last.strength += cand.strength;
   last.count += 1;
   last.highPrice = Math.max(last.highPrice, cand.price);
   if (cand.strength > last.topStrength) { last.topStrength = cand.strength; last.kind = cand.kind; }
  } else {
   clusters.push({
    price: cand.price,
    lowPrice: cand.price,
    highPrice: cand.price,
    kind: cand.kind,
    strength: cand.strength,
    topStrength: cand.strength,
    count: 1,
   });
  }
 }
 const levels = clusters.map(c => {
  const targetPrice = Math.max(px * 1.001, c.lowPrice * (1 - bufferPct / 100));
  return {
   price: +c.lowPrice.toPrecision(8),
   targetPrice: +targetPrice.toPrecision(8),
   kind: c.kind,
   strength: c.strength,
   count: c.count,
  };
 });
 const isPriceDiscovery = levels.length === 0 && px >= allTimeHigh * 0.997;
 return {
  ok: true,
  levels,
  nearest: levels[0] ?? null,
  allTimeHigh: +allTimeHigh.toPrecision(8),
  isPriceDiscovery,
  dailyCount: closed.length,
 };
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

/** Detect an actionable 「2% 매매법」 LONG setup on 15m + 1D candles.
 * Returns { ok: true, entry, stop, tp, netRR, ... } or { ok: false, reason, detail }. */
export function detectTwoPctSetup({
 rows15m,
 rows1d,
 livePrice = null,
 now = Date.now(),
 leverage = TWO_PCT_DEFAULTS.leverage,
 costs = { takerRate: 0.0005, slippageBps: 2, spreadBps: 2, fundingRate: 0 },
 config = {},
} = {}) {
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
 // Find the most recent strong >=2% bullish reference candle within maxFollowBars closed candles.
 const recentClosed = closed.filter(b => b.openTime < forming.openTime).slice(-Math.max(1, cfg.maxFollowBars));
 let base = null;
 let baseIdx = -1;
 for (let i = recentClosed.length - 1; i >= 0; i--) {
  const check = isStrongBullishCandle(recentClosed[i], cfg);
  if (check.ok) {
   // Verify base candle is within maxFollowBars intervals of the forming candle (no stale gap).
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
  return { ok: false, reason: 'TWO_PCT_NO_BASE_CANDLE', detail: `직전 15m ${lastPct}% (기준 +${cfg.minBodyPct}%↑ 마루보즈)` };
 }
 // Check uptrend integrity on any closed candles between base and forming.
 const between = recentClosed.slice(baseIdx + 1);
 if (between.some(b => b.close < base.open)) {
  return { ok: false, reason: 'TWO_PCT_TREND_BROKEN', detail: `후속 15m 종가가 기준봉 시가(${base.open}) 이탈` };
 }
 // Evaluate current forming 15m candle: must dip below open (lower wick) and flip bullish (green).
 const curOpen = forming.open;
 const curPrice = pos(livePrice) ?? forming.close;
 const curLow = Math.min(forming.low, curPrice);
 if (!(curPrice > curOpen)) {
  const chg = (((curPrice - curOpen) / curOpen) * 100).toFixed(2);
  return { ok: false, reason: 'TWO_PCT_WAIT_GREEN_FLIP', detail: `15m 음봉 ${chg}% · 양봉 전환 대기` };
 }
 const lowerWickPct = ((curOpen - curLow) / curOpen) * 100;
 if (!(curLow < curOpen && lowerWickPct >= cfg.minLowerWickPct)) {
  return { ok: false, reason: 'TWO_PCT_NO_LOWER_WICK', detail: `아래꼬리 ${lowerWickPct.toFixed(2)}% < ${cfg.minLowerWickPct}%` };
 }
 const flipPct = ((curPrice - curOpen) / curOpen) * 100;
 if (flipPct < cfg.minFlipAboveOpenPct) {
  return { ok: false, reason: 'TWO_PCT_WAIT_GREEN_FLIP', detail: `양봉 전환 폭 +${flipPct.toFixed(2)}% < +${cfg.minFlipAboveOpenPct}%` };
 }
 // Stop-loss = entry candle lower-wick low, validated for tightness and liquidation safety at leverage.
 const stop = curLow;
 const stopDistPct = ((curPrice - stop) / curPrice) * 100;
 if (stopDistPct < cfg.minStopPct) {
  return { ok: false, reason: 'TWO_PCT_STOP_TOO_TIGHT', detail: `손절폭 ${stopDistPct.toFixed(2)}% < ${cfg.minStopPct}%` };
 }
 const effLev = Math.max(1, Math.floor(Number(leverage) || cfg.leverage));
 const maxStopAllowed = Math.min(cfg.maxStopPct, cfg.maxStopRoePct / effLev);
 if (stopDistPct > maxStopAllowed) {
  return { ok: false, reason: 'TWO_PCT_STOP_TOO_WIDE', detail: `손절폭 ${stopDistPct.toFixed(2)}% > ${maxStopAllowed.toFixed(2)}% (${effLev}배 한도)` };
 }
 // Daily (1D) resistance & minimum 1:2 net risk:reward verification.
 const daily = findDailyResistances(rows1d, {
  now,
  entry: curPrice,
  clusterPct: cfg.resistanceClusterPct,
  bufferPct: cfg.resistanceBufferPct,
  minCandles: cfg.minDailyCandles,
 });
 if (!daily.ok) {
  return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', detail: `일봉 ${daily.dailyCount}개` };
 }
 const roundTrip = twoPctRoundTripCost(curPrice, costs);
 const risk = curPrice - stop;
 let tp, netRR, tpSource, resistance = null;
 if (daily.nearest) {
  tp = daily.nearest.targetPrice;
  netRR = (tp - curPrice - roundTrip) / (risk + roundTrip);
  tpSource = 'DAILY_RESISTANCE';
  resistance = daily.nearest;
  if (!(netRR >= cfg.minNetRR)) {
   return {
    ok: false,
    reason: 'TWO_PCT_RR_BELOW_MIN',
    detail: `1D 저항 ${daily.nearest.price} · 손익비 1:${Number.isFinite(netRR) ? Math.max(0, netRR).toFixed(2) : '0'} < 1:${cfg.minNetRR}`,
   };
  }
 } else if (daily.isPriceDiscovery) {
  // ATH breakout (상따): no overhead 1D resistance ceiling — project clean 2.5R net TP.
  tp = curPrice + roundTrip + cfg.athFallbackRR * (risk + roundTrip);
  netRR = cfg.athFallbackRR;
  tpSource = 'ATH_BREAKOUT_RR';
 } else {
  return { ok: false, reason: 'TWO_PCT_DAILY_UNAVAILABLE', detail: '1D 저항선 산출 불가' };
 }
 const atr = simpleAtr(closed) ?? Math.max(curPrice - stop, curPrice * 0.015);
 return {
  ok: true,
  direction: 'LONG',
  interval: TWO_PCT_INTERVAL,
  entry: curPrice,
  stop,
  tp,
  netRR: r4(netRR),
  stopDistPct: r4(stopDistPct),
  lowerWickPct: r4(lowerWickPct),
  flipPct: r4(flipPct),
  leverage: effLev,
  tpSource,
  resistance,
  allTimeHigh: daily.allTimeHigh,
  atr,
  baseCandle: base,
  entryCandle: {
   openTime: forming.openTime,
   closeTime: forming.closeTime,
   open: curOpen,
   low: curLow,
   price: curPrice,
   lowerWickPct: r4(lowerWickPct),
   flipPct: r4(flipPct),
  },
 };
}
