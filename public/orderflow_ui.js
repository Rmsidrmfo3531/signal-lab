// Dedicated "호가·CVD·청산맵" (#orderflow) workspace screen (renamed from "수급 · 청산" on user request 2026-11-25 09:51).
// Features Material Indicators FireCharts-style Liquidity Wall Heatmap + order-size CVD in the 6 FireCharts classes
// (새우 $100~$1000 .. 고래 $1M~$10M, All Orders; Normalized/Absolute), the combined CVD and OI trend, the estimated
// liquidation map and the market-wide anomaly radar. Display only: nothing here places or changes an order.
// Pure rendering helpers are exported for unit tests; DOM bindings initialize automatically in browser.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function fmtPx(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

function fmtUsdCompact(v, signed = false) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** 3 significant digits for the narrow colour-scale labels: $236M, $38.2M, $4.10K. */
function fmtUsdShort(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  const s = x => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  if (a >= 1e9) return `${sign}$${s(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${s(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${s(a / 1e3)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtPct(v, d = 2) {
  if (!fin(v)) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;
}

function fmtKst(ts, withDate = false) {
  if (!ts) return '—';
  try {
    const opts = withDate
      ? { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    return new Date(ts).toLocaleString('ko-KR', opts);
  } catch { return '—'; }
}

/** KST calendar day with the year (6M / 1Y / 3Y axes): 2026.11.25 → "26.11.25". */
function fmtKstDay(ts) {
  if (!ts) return '—';
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ts)).map(x => [x.type, x.value]));
    return `${p.year}.${p.month}.${p.day}`;
  } catch { return '—'; }
}

function fmtCountdown(nextTs, now = Date.now()) {
  if (!fin(nextTs) || Number(nextTs) <= now) return '';
  const mins = Math.max(1, Math.round((Number(nextTs) - now) / 60_000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}시간 ${m}분 후` : `${m}분 후`;
}

const SOURCE_LABELS = Object.freeze({
  BINANCE: 'Binance 선물',
  GATEIO: 'Gate.io 선물',
  BINGX: 'BingX 선물',
});

/**
 * The 6 CVD lines of the user's FireCharts screenshot (2026-11-25 09:20), small to large, then All Orders.
 * Same keys, legend text and dark-theme colours as firechart.mjs FIRECHART_CLASSES (a test keeps them equal);
 * on screen every line and chip takes its colour from the CSS token --wcv-<key> (light theme has its own values).
 */
export const FIRECHART_CVD_CLASSES = Object.freeze([
  { key: 'orange', legend: '$100~$1000 (새우)', color: '#fb923c', width: 1.7, stepped: false },
  { key: 'green', legend: '$1000~$10000', color: '#4ade80', width: 1.6, stepped: false },
  { key: 'red', legend: '$10K~$100K', color: '#f87171', width: 1.6, stepped: false },
  { key: 'purple', legend: '$100K~$1M', color: '#c084fc', width: 1.8, stepped: false },
  { key: 'brown', legend: '$1M~$10M (고래)', color: '#d19a66', width: 2.1, stepped: true },
  { key: 'blue', legend: 'All Orders', color: '#60a5fa', width: 2.2, stepped: false },
].map(c => Object.freeze(c)));
const CVD_KEYS = FIRECHART_CVD_CLASSES.map(c => c.key);
/** The two readings printed on the screenshot, shown under the legend. */
export const FIRECHART_CVD_NOTES = Object.freeze(['고래 : CVD 증가 = 매집 경향', '새우 : CVD 감소 = 매도 경향']);
export const FIRECHART_HEAT_NOTE = '색이 밝을수록 매물대가 두터움';
// A payload from before 2026-11-25 (개미/중형/대형/고래) still draws: retail→orange, mid→green, large→red, whale→brown.
const LEGACY_CVD_KEY = Object.freeze({ orange: 'retail', green: 'mid', red: 'large', brown: 'whale' });

/** One point's value for one class: mode 'normalized' → 0..1 (flat/missing 0.5), 'absolute' → USD (missing 0). */
export function cvdPointValue(pt, key, mode = 'normalized') {
  const isNorm = mode !== 'absolute';
  const box = isNorm ? pt?.norm : pt?.abs;
  const fallback = isNorm ? 0.5 : 0;
  if (!box) return fallback;
  const raw = box[key] !== undefined ? box[key] : box[LEGACY_CVD_KEY[key]];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Y range of the CVD pane. Normalized: always 0..1 (each line already min-max scaled on the server).
 * Absolute: one shared USD scale over the shown lines, always including 0 so the zero line is visible.
 */
export function cvdPaneScale(points = [], { mode = 'normalized', hidden = [] } = {}) {
  if (mode !== 'absolute') return { min: 0, max: 1 };
  const hide = new Set(hidden);
  let min = 0, max = 0;
  for (const pt of points) {
    for (const key of CVD_KEYS) {
      if (hide.has(key)) continue;
      const v = cvdPointValue(pt, key, 'absolute');
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!(max > min)) return { min: -1, max: 1 };
  return { min, max };
}

/** Keep only well-formed whale zones (low < high, finite, side BUY|SELL). Anything else → []. */
export function parseWhaleZones(body) {
  const zones = Array.isArray(body?.zones) ? body.zones : [];
  return zones
    .map(z => ({ low: Number(z?.low), high: Number(z?.high), net: Number(z?.net), side: String(z?.side || '').toUpperCase() }))
    .filter(z => Number.isFinite(z.low) && Number.isFinite(z.high) && z.low > 0 && z.high > z.low && (z.side === 'BUY' || z.side === 'SELL'))
    .map(z => ({ ...z, net: Number.isFinite(z.net) ? z.net : 0 }))
    .slice(0, 24);
}

/**
 * HOOK — 고래 매물대 bands on the heatmap.
 * Reads GET /api/whale-zones?symbol=<SYM> → {zones:[{low, high, net, side:'BUY'|'SELL'}]} (USD prices, net = signed USD).
 * That endpoint is built in a separate change. Until it exists the server answers 404 and this returns
 * {available:false, zones:[]} so nothing is drawn; any other error or a bad body also draws nothing.
 * The controller below calls it after each symbol load and passes the zones to firechartSvg({whaleZones}).
 */
export const WHALE_ZONES_ENDPOINT = '/api/whale-zones';
export async function fetchWhaleZones(symbol, { fetcher = globalThis.fetch } = {}) {
  if (!symbol || typeof fetcher !== 'function') return { available: false, zones: [] };
  try {
    const res = await fetcher(`${WHALE_ZONES_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    if (!res || res.status === 404) return { available: false, zones: [] };
    if (!res.ok) return { available: true, zones: [] };
    const body = await res.json().catch(() => null);
    return { available: true, zones: parseWhaleZones(body) };
  } catch {
    return { available: true, zones: [] };
  }
}

/** Map 0..1 intensity to Material Indicators FireCharts color ramp (Dark Red -> Red -> Orange -> Yellow -> White). */
function fireColor(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  if (x < 0.25) return `rgba(${Math.round(90 + x * 4 * 120)}, 14, 14, ${(0.45 + x * 1.4).toFixed(2)})`;
  if (x < 0.55) {
    const u = (x - 0.25) / 0.30;
    return `rgba(${Math.round(210 + u * 45)}, ${Math.round(18 + u * 105)}, 12, ${(0.78 + u * 0.14).toFixed(2)})`;
  }
  if (x < 0.85) {
    const u = (x - 0.55) / 0.30;
    return `rgba(255, ${Math.round(123 + u * 120)}, ${Math.round(14 + u * 45)}, 0.94)`;
  }
  const u = (x - 0.85) / 0.15;
  return `rgba(255, ${Math.round(243 + u * 12)}, ${Math.round(59 + u * 185)}, 0.98)`;
}

function buildSteppedPath(coords) {
  if (!coords.length) return '';
  let d = `M ${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    d += ` H ${coords[i][0].toFixed(1)} V ${coords[i][1].toFixed(1)}`;
  }
  return d;
}

const PRICE_SPAN_PRESETS = Object.freeze({
  LIVE: {
    tight:  { spanMult: 0.18, pctPad: 0.01 },
    normal: { spanMult: 0.55, pctPad: 0.03 },
    wide:   { spanMult: 1.15, pctPad: 0.08 },
    ultra:  { spanMult: 2.20, pctPad: 0.20 },
  },
  '1D': {
    tight:  { spanMult: 0.18, pctPad: 0.02 },
    normal: { spanMult: 0.50, pctPad: 0.06 },
    wide:   { spanMult: 1.00, pctPad: 0.16 },
    ultra:  { spanMult: 1.85, pctPad: 0.35 },
  },
  MACRO: {
    tight:  { spanMult: 0.16, pctPad: 0.04 },
    normal: { spanMult: 0.45, pctPad: 0.14 },
    wide:   { spanMult: 0.95, pctPad: 0.35 },
    ultra:  { spanMult: 1.65, pctPad: 0.60 },
  },
});

/**
 * Compute visible Y-axis [minP, maxP] for FireCharts heatmap according to user's zoom preset
 * ('tight' | 'normal' | 'wide' | 'ultra') while preserving backward compatibility when candle bounds are absent.
 */
export function computeFirechartPriceBounds(data, priceSpan = 'wide') {
  const hm = data?.firechart?.heatmap;
  const candles = data?.series || [];
  const lastPx = Number(data?.price?.mark) || Number(candles.at(-1)?.c) || 0;
  // Backward compatibility: synthetic or legacy heatmaps without candleMinPrice/candleMaxPrice use exact hm bounds
  if (hm && (!(Number(hm.candleMinPrice) > 0) || !(Number(hm.candleMaxPrice) > 0)) && Number(hm.minPrice) > 0 && Number(hm.maxPrice) > Number(hm.minPrice)) {
    return { minP: Number(hm.minPrice), maxP: Number(hm.maxPrice) };
  }
  const cMin = Number(hm?.candleMinPrice) || (candles.length ? Math.min(...candles.map(c => c.l || c.c)) : 0);
  const cMax = Number(hm?.candleMaxPrice) || (candles.length ? Math.max(...candles.map(c => c.h || c.c)) : 0);
  if (!(cMax > 0)) return { minP: 0, maxP: 1 };
  const rangeKey = String(data?.firechart?.range || data?.range || 'LIVE').toUpperCase();
  const group = rangeKey === 'LIVE' ? PRICE_SPAN_PRESETS.LIVE : rangeKey === '1D' ? PRICE_SPAN_PRESETS['1D'] : PRICE_SPAN_PRESETS.MACRO;
  const preset = group[priceSpan] || group.wide;
  const cSpan = Math.max(cMax - cMin, lastPx * 0.012);
  const pad = Math.max(cSpan * preset.spanMult, lastPx * preset.pctPad);
  const floorMin = lastPx > 0 ? lastPx * 0.12 : 1e-12;
  const minP = Math.max(floorMin, cMin - pad);
  const maxP = cMax + pad;
  return { minP, maxP: maxP > minP ? maxP : minP * 1.01 };
}

/**
 * Find the nearest visible liquidity wall to a touched/hovered (xNorm, yNorm) coordinate
 * inside the FireCharts upper heatmap canvas, or fall back to the exact touched price level.
 */
export function findFirechartWallAt(data, { xNorm = 0.5, yNorm = 0.5, minPct = 93, maxPct = 99, priceSpan = 'wide' } = {}) {
  const hm = data?.firechart?.heatmap;
  const candles = data?.series || [];
  if (!hm || !candles.length) return null;
  const { minP, maxP } = computeFirechartPriceBounds(data, priceSpan);
  const pSpan = maxP - minP || 1;
  const mark = Number(data?.price?.mark) || Number(candles.at(-1)?.c) || 0;
  const loPct = Math.min(minPct, maxPct);
  const hiPct = Math.max(minPct, maxPct);
  const yClamped = Math.max(0, Math.min(1, Number(yNorm)));
  const xClamped = Math.max(0, Math.min(1, Number(xNorm)));
  const touchedPrice = maxP - yClamped * pSpan;

  const visible = (hm.cells || []).filter(c => c.pctRank >= loPct && c.pctRank <= hiPct + 0.99 && c.price >= minP && c.price <= maxP);
  let best = null;
  let bestScore = -Infinity;

  for (const c of visible) {
    const wallYNorm = (maxP - c.price) / pSpan;
    const dy = Math.abs(wallYNorm - yClamped);
    const inX = xClamped >= c.x0 - 0.045 && xClamped <= c.x1 + 0.045;
    const maxDy = inX ? 0.06 : 0.032; // generous touch tolerance on overlapping horizontal bar
    if (dy > maxDy) continue;
    // Prefer closer vertically, overlapping horizontally, and larger liquidity size
    const score = (inX ? 100 : 0) - dy * 1200 + Math.log10(Math.max(10, c.usd)) * 4;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (best) {
    const distPct = mark > 0 ? +(((best.price - mark) / mark) * 100).toFixed(2) : null;
    return {
      snapped: true,
      price: best.price,
      usd: best.usd,
      side: best.side,
      pctRank: best.pctRank,
      live: Boolean(best.live),
      distPct,
    };
  }

  const px = Number(touchedPrice.toPrecision(6));
  const distPct = mark > 0 ? +(((px - mark) / mark) * 100).toFixed(2) : null;
  return {
    snapped: false,
    price: px,
    usd: null,
    side: mark > 0 && px < mark ? 'BID' : 'ASK',
    pctRank: null,
    live: false,
    distPct,
  };
}

/**
 * Render the touched/selected liquidity wall price readout banner with one-click real-account limit order handoff.
 */
export function firechartInspectBarHTML(inspected, symbol = '') {
  if (!inspected || !fin(inspected.price)) {
    return '<div class="of-fc-inspect idle" data-of-fc-inspect><span>💡 차트의 매물대 줄을 터치(클릭)하면 정확한 가격대와 유동성 규모가 표시되며, 실계좌 지정가 주문으로 바로 전달할 수 있습니다.</span></div>';
  }
  const isAsk = inspected.side === 'ASK';
  const sideTag = inspected.snapped
    ? (isAsk ? '<span class="of-tag neg">매도벽 (저항)</span>' : '<span class="of-tag pos">매수벽 (지지)</span>')
    : '<span class="of-tag neutral">선택 가격대</span>';
  const distTxt = fin(inspected.distPct) ? `<span class="${inspected.distPct >= 0 ? 'paper-loss' : 'paper-profit'}">(${esc(fmtPct(inspected.distPct, 2))})</span>` : '';
  const wallMeta = inspected.snapped
    ? `<span class="of-fc-insp-meta">규모 <b>${esc(fmtUsdCompact(inspected.usd))}</b> · 상위 ${esc(inspected.pctRank)}% · ${inspected.live ? '실시간 L2 호가벽' : '거래량 매물대'}</span>`
    : '<span class="of-fc-insp-meta">현재가 대비 위치 확인</span>';
  const sendOrderBtn = `<button type="button" class="of-fc-insp-order" data-of-send-real-order data-symbol="${esc(symbol)}" data-price="${esc(inspected.price)}" data-side="${isAsk ? 'SHORT' : 'LONG'}" data-wall-label="${esc(inspected.snapped ? (isAsk ? '매도벽' : '매수벽') : '선택가')}" title="이 가격을 실계좌 수동 주문 지정가(LIMIT)로 바로 채웁니다">⚡ 실계좌 지정가 주문 →</button>`;
  return `<div class="of-fc-inspect active ${isAsk ? 'ask' : 'bid'}" data-of-fc-inspect>
    <div class="of-fc-insp-main">${sideTag}<b class="of-fc-insp-px">$${esc(fmtPx(inspected.price))}</b>${distTxt}${wallMeta}</div>
    <div class="of-fc-insp-actions">${sendOrderBtn}<button type="button" class="of-fc-insp-close" data-of-inspect-clear aria-label="가격 표시 닫기">✕</button></div>
  </div>`;
}

/**
 * Render tappable major ASK/BID wall price chips under the FireCharts heatmap for quick mobile inspection.
 */
export function firechartWallSummaryHTML(data, { minPct = 93, maxPct = 99, priceSpan = 'wide', inspected = null } = {}) {
  const hm = data?.firechart?.heatmap;
  const mark = Number(data?.price?.mark) || Number(data?.series?.at(-1)?.c) || 0;
  if (!hm?.cells?.length || !(mark > 0)) return '';
  const { minP, maxP } = computeFirechartPriceBounds(data, priceSpan);
  const loPct = Math.min(minPct, maxPct);
  const hiPct = Math.max(minPct, maxPct);
  const inRange = hm.cells.filter(c => c.pctRank >= loPct && c.pctRank <= hiPct + 0.99 && c.price >= minP && c.price <= maxP);
  const vis = inRange.length ? inRange : hm.cells.filter(c => c.pctRank >= loPct && c.pctRank <= hiPct + 0.99);
  if (!vis.length) return '';

  // Deduplicate by yBin keeping strongest wall per price shelf
  const byBin = new Map();
  for (const c of vis) {
    const prev = byBin.get(c.yBin);
    if (!prev || c.usd > prev.usd) byBin.set(c.yBin, c);
  }
  const unique = [...byBin.values()];
  const asks = unique.filter(c => c.price >= mark).sort((a, b) => b.usd - a.usd).slice(0, 3).sort((a, b) => a.price - b.price);
  const bids = unique.filter(c => c.price < mark).sort((a, b) => b.usd - a.usd).slice(0, 3).sort((a, b) => b.price - a.price);

  const chip = c => {
    const isAsk = c.price >= mark;
    const dist = +(((c.price - mark) / mark) * 100).toFixed(2);
    const active = inspected && Math.abs(Number(inspected.price) - c.price) / mark < 0.0005 ? ' active' : '';
    return `<button type="button" class="of-wall-chip ${isAsk ? 'ask' : 'bid'}${active}" data-fc-wall-pick data-wall-price="${esc(c.price)}" data-wall-usd="${esc(c.usd)}" data-wall-side="${isAsk ? 'ASK' : 'BID'}" data-wall-pct="${esc(c.pctRank)}" data-wall-live="${c.live ? '1' : '0'}"><b>$${esc(fmtPx(c.price))}</b><small>${esc(fmtPct(dist, 1))} · ${esc(fmtUsdCompact(c.usd))}</small></button>`;
  };
  if (!asks.length && !bids.length) return '';
  return `<div class="of-wall-strip" data-of-wall-strip>
    ${asks.length ? `<div class="of-wall-group"><span class="of-wg-lbl neg">상단 매도벽</span>${asks.map(chip).join('')}</div>` : ''}
    ${bids.length ? `<div class="of-wall-group"><span class="of-wg-lbl pos">하단 매수벽</span>${bids.map(chip).join('')}</div>` : ''}
  </div>`;
}

/**
 * Layout of the two panes for a given drawing width (px). The SVG is drawn at the container's real width so text
 * stays readable on a phone (a 920-wide drawing shrunk to 360 px would print 4 px labels).
 */
export function firechartLayout(width = 920) {
  const W = Math.round(Math.max(280, Math.min(1400, Number(width) || 920)));
  const compact = W < 560;
  const PL = compact ? 70 : 94;
  const PR = compact ? 60 : 80;
  const topY = 24;
  const topH = compact ? 210 : 246;
  const botY = topY + topH + 30;
  const botH = compact ? 156 : 190;
  const H = botY + botH + 22;
  return { W, H, PL, PR, PW: W - PL - PR, topY, topH, botY, botH, compact, font: compact ? 9.5 : 10 };
}

/**
 * Pure SVG Material Indicators FireCharts-style Dual Pane:
 * - Upper "Fire Chart": black canvas, vertical colour scale (색이 밝을수록 매물대가 두터움), liquidity wall heatmap,
 *   optional 고래 매물대 bands (whaleZones hook), price line and touch crosshair.
 * - Lower CVD: the 6 order-size lines (Normalized 0..1 per line, or Absolute USD on one shared scale).
 */
export function firechartSvg(data, {
  cvdMode = 'normalized', minPct = 93, maxPct = 99, priceSpan = 'wide', inspected = null,
  width = 920, hiddenClasses = [], whaleZones = [],
} = {}) {
  const fc = data?.firechart;
  const candles = data?.series || [];
  const cohortPts = fc?.cohorts?.series || [];
  const hm = fc?.heatmap;
  if (!fc || candles.length < 3 || cohortPts.length < 3) {
    return '<div class="empty-small" style="padding:36px">FireCharts 유동성 히트맵과 금액대별 CVD를 계산하는 중입니다…</div>';
  }

  const L = firechartLayout(width);
  const { W, H, PL, PR, PW, topY, topH, botY, botH, compact, font } = L;
  const loPct = Math.min(minPct, maxPct);
  const hiPct = Math.max(minPct, maxPct);
  const hidden = new Set(hiddenClasses || []);

  // Upper Pane: price scale & liquidity heatmap
  const { minP, maxP } = computeFirechartPriceBounds(data, priceSpan);
  const pSpan = maxP - minP || maxP * 0.01 || 1;
  const py = v => topY + topH - ((v - minP) / pSpan) * topH;
  const pxOf = (i, len) => PL + (len > 1 ? (i / (len - 1)) * PW : PW / 2);

  const visibleCells = (hm?.cells || []).filter(c => c.pctRank >= loPct && c.pctRank <= hiPct + 0.99 && c.price >= minP && c.price <= maxP);
  const maxVisUsd = visibleCells.length ? Math.max(...visibleCells.map(c => c.usd)) : 0;
  const minVisUsd = visibleCells.length ? Math.min(...visibleCells.map(c => c.usd)) : 0;
  const masterSpan = Math.max(1e-12, (hm?.maxPrice || maxP) - (hm?.minPrice || minP));
  const binPxStep = masterSpan / Math.max(1, hm?.priceBins || 72);
  const cellH = Math.max(2.6, Math.min(10, (binPxStep / pSpan) * topH));

  const heatmapRects = visibleCells.map(c => {
    const x = PL + c.x0 * PW;
    const w = Math.max(4, (c.x1 - c.x0) * PW);
    const yCenter = py(c.price);
    const y = Math.max(topY, Math.min(topY + topH - cellH, yCenter - cellH / 2));
    const intensity = maxVisUsd > minVisUsd ? (c.usd - minVisUsd) / (maxVisUsd - minVisUsd) : 0.7;
    return `<rect class="of-fc-wall" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${fireColor(intensity)}" rx="1" data-wall-price="${esc(c.price)}" data-wall-usd="${esc(c.usd)}" data-wall-side="${esc(c.side)}" data-wall-pct="${esc(c.pctRank)}" data-wall-live="${c.live ? '1' : '0'}"/>`;
  }).join('');

  // 고래 매물대 bands (hook: empty until GET /api/whale-zones exists)
  const zoneSvg = (whaleZones || [])
    .filter(z => z && z.high > minP && z.low < maxP)
    .map(z => {
      const yTop = py(Math.min(maxP, z.high));
      const yBot = py(Math.max(minP, z.low));
      const h = Math.max(2, yBot - yTop);
      const buy = z.side === 'BUY';
      const label = `고래 ${buy ? '매수' : '매도'} ${fmtUsdCompact(z.net, true)}`;
      return `<g class="of-fc-whale-zone ${buy ? 'buy' : 'sell'}" data-whale-zone data-zone-low="${esc(z.low)}" data-zone-high="${esc(z.high)}" style="pointer-events:none">
      <rect x="${PL}" y="${yTop.toFixed(1)}" width="${PW}" height="${h.toFixed(1)}" fill="${buy ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)'}" stroke="${buy ? '#4ade80' : '#f87171'}" stroke-width="1" stroke-dasharray="4 3"/>
      <text x="${PL + 6}" y="${(yTop + Math.min(h, 14) - 3).toFixed(1)}" fill="${buy ? '#86efac' : '#fca5a5'}" font-size="${font - 0.5}" font-weight="700">${esc(label)}</text>
    </g>`;
    }).join('');

  const pricePts = candles.map((c, i) => `${pxOf(i, candles.length).toFixed(1)},${py(c.c).toFixed(1)}`).join(' ');
  const lastPx = candles.at(-1).c;
  const badgeW = PR - 6;

  let inspectSvg = '';
  if (inspected && fin(inspected.price) && Number(inspected.price) >= minP && Number(inspected.price) <= maxP) {
    const iy = py(Number(inspected.price));
    const lineColor = inspected.snapped ? '#ffd166' : '#7dd3fc';
    const boxFill = inspected.snapped ? (inspected.side === 'ASK' ? '#7a1f2d' : '#115e49') : '#1c3e63';
    inspectSvg = `<g class="of-fc-crosshair" data-fc-crosshair>
      <line x1="${PL}" y1="${iy.toFixed(1)}" x2="${W - PR}" y2="${iy.toFixed(1)}" stroke="${lineColor}" stroke-width="1.4" stroke-dasharray="5 3"/>
      <rect x="${W - PR + 2}" y="${(iy - 9).toFixed(1)}" width="${badgeW}" height="18" rx="3" fill="${boxFill}" stroke="${lineColor}" stroke-width="1"/>
      <text x="${W - PR + 6}" y="${(iy + 3.5).toFixed(1)}" fill="#fff" font-size="${font}" font-weight="800">${esc(fmtPx(inspected.price))}</text>
    </g>`;
  }

  const pTicks = [0, 0.2, 0.4, 0.6, 0.8, 1].map(f => {
    const val = minP + f * pSpan;
    const y = py(val);
    return `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#162130" stroke-width="1"/>
      <text class="of-fc-axis" x="${W - PR + 6}" y="${(y + 3.5).toFixed(1)}" fill="#8ba3bc" font-size="${font}">${esc(fmtPx(val))}</text>`;
  }).join('');

  // Vertical colour scale: the visible cells' USD range mapped onto the same ramp the cells use
  const barX = compact ? 18 : 30, barW = compact ? 10 : 14;
  const cbMax = maxVisUsd || hm?.maxUsd || 0;
  const cbMin = visibleCells.length ? minVisUsd : (hm?.p80Usd || 0);
  const cbTicks = (compact ? [1, 0.5, 0] : [1, 0.75, 0.5, 0.25, 0]).map(f => {
    const v = cbMin + f * Math.max(0, cbMax - cbMin);
    const y = topY + (1 - f) * topH;
    return `<text class="of-fc-axis" x="${barX + barW + 4}" y="${(y + (f === 1 ? 8 : f === 0 ? -2 : 3.5)).toFixed(1)}" fill="#8ba3bc" font-size="${font - 0.5}">${esc(fmtUsdShort(v))}</text>`;
  }).join('');
  const noteX = compact ? 10 : 15;
  const noteY = topY + topH / 2;

  // Lower Pane: 6 CVD lines
  const isNorm = cvdMode !== 'absolute';
  const mode = isNorm ? 'normalized' : 'absolute';
  const { min: cMin, max: cMax } = cvdPaneScale(cohortPts, { mode, hidden: [...hidden] });
  const cSpan = cMax - cMin || 1;
  const cy = v => botY + botH - ((Math.max(cMin, Math.min(cMax, v)) - cMin) / cSpan) * botH;

  // All Orders first (behind), then small → large so the whale lines stay on top
  const drawOrder = ['blue', 'orange', 'green', 'red', 'purple', 'brown'];
  const cohortPaths = drawOrder.map(key => FIRECHART_CVD_CLASSES.find(m => m.key === key)).filter(m => m && !hidden.has(m.key)).map(m => {
    const coords = cohortPts.map((pt, i) => [pxOf(i, cohortPts.length), cy(cvdPointValue(pt, m.key, mode))]);
    const cls = `of-fc-line of-fc-l-${m.key}`;
    if (m.stepped) {
      return `<path class="${cls}" d="${buildSteppedPath(coords)}" fill="none" stroke="${m.color}" stroke-width="${m.width}" stroke-linejoin="miter" data-cvd-line="${m.key}"/>`;
    }
    const ptsStr = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return `<polyline class="${cls}" fill="none" stroke="${m.color}" stroke-width="${m.width}" stroke-linejoin="round" points="${ptsStr}" data-cvd-line="${m.key}"/>`;
  }).join('');

  const cTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const val = cMin + f * cSpan;
    const y = cy(val);
    const lbl = isNorm ? val.toFixed(2) : fmtUsdCompact(val, true);
    return `<line class="of-fc-grid" x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#162130" stroke-width="1"/>
      <text class="of-fc-axis" x="${W - PR + 6}" y="${(y + 3.5).toFixed(1)}" fill="#8ba3bc" font-size="${font}">${esc(lbl)}</text>`;
  }).join('');

  const zeroLine = !isNorm && cMin < 0 && cMax > 0
    ? `<line class="of-fc-zero" x1="${PL}" y1="${cy(0).toFixed(1)}" x2="${W - PR}" y2="${cy(0).toFixed(1)}" stroke="#395573" stroke-dasharray="4 3"/>`
    : '';

  const withDate = fc.range !== 'LIVE';
  const dailyAxis = ['6M', '1Y', '3Y'].includes(fc.range);
  const tickFs = compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const timeTicks = tickFs.map(f => {
    const idx = Math.min(cohortPts.length - 1, Math.round(f * (cohortPts.length - 1)));
    const x = pxOf(idx, cohortPts.length);
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
    return `<line x1="${x.toFixed(1)}" y1="${topY}" x2="${x.toFixed(1)}" y2="${topY + topH}" stroke="#121c29" stroke-width="1"/>
      <line class="of-fc-grid" x1="${x.toFixed(1)}" y1="${botY}" x2="${x.toFixed(1)}" y2="${botY + botH}" stroke="#121c29" stroke-width="1"/>
      <text class="of-fc-axis" x="${x.toFixed(1)}" y="${H - 7}" text-anchor="${anchor}" fill="#8ba3bc" font-size="${font - 0.5}">${esc(dailyAxis ? fmtKstDay(cohortPts[idx].t) : fmtKst(cohortPts[idx].t, withDate))}</text>`;
  }).join('');

  const cvdTitle = isNorm ? 'Normalized CVD (0~1)' : 'Absolute CVD (USD)';
  return `<svg class="of-fc-svg" data-fc-svg data-w="${W}" data-h="${H}" data-pl="${PL}" data-pw="${PW}" data-top-y="${topY}" data-top-h="${topH}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Fire Chart 호가 유동성 히트맵(${esc(FIRECHART_HEAT_NOTE)})과 금액대별 ${esc(cvdTitle)}">
    <defs>
      <linearGradient id="fcFireScale" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#140404"/>
        <stop offset="25%" stop-color="#8b0000"/>
        <stop offset="50%" stop-color="#e51a1a"/>
        <stop offset="75%" stop-color="#ff8c00"/>
        <stop offset="93%" stop-color="#ffee32"/>
        <stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    </defs>
    <text class="of-fc-title" x="${PL}" y="${topY - 8}" fill="#d6e7f8" font-size="${font + 1.5}" font-weight="800">Fire Chart</text>
    <rect x="${PL}" y="${topY}" width="${PW}" height="${topH}" fill="#05070c" stroke="#1d2c3e" stroke-width="1"/>
    <!-- Vertical colour scale + note -->
    <rect x="${barX}" y="${topY}" width="${barW}" height="${topH}" fill="url(#fcFireScale)" stroke="#23364b" stroke-width="1" rx="2" data-fc-scale/>
    ${cbTicks}
    <text class="of-fc-title of-fc-scale-note" x="${noteX}" y="${noteY}" transform="rotate(-90 ${noteX} ${noteY})" text-anchor="middle" fill="#d6e7f8" font-size="${font}" font-weight="600">${esc(FIRECHART_HEAT_NOTE)}</text>
    ${timeTicks}
    ${pTicks}
    ${zoneSvg}
    ${heatmapRects}
    <polyline fill="none" stroke="#45b3ff" stroke-width="2" points="${pricePts}" style="pointer-events:none"/>
    <circle cx="${pxOf(candles.length - 1, candles.length).toFixed(1)}" cy="${py(lastPx).toFixed(1)}" r="3.4" fill="#9fe3ff" style="pointer-events:none"/>
    <rect x="${W - PR + 3}" y="${(py(lastPx) - 8).toFixed(1)}" width="${badgeW - 1}" height="16" rx="3" fill="#184775" stroke="#45b3ff" stroke-width="0.8"/>
    <text x="${W - PR + 6}" y="${(py(lastPx) + 3.5).toFixed(1)}" fill="#fff" font-size="${font}" font-weight="700">${esc(fmtPx(lastPx))}</text>
    ${inspectSvg}
    <!-- Lower CVD pane -->
    <text class="of-fc-title" x="${PL}" y="${botY - 9}" fill="#d6e7f8" font-size="${font + 1.5}" font-weight="800">${cvdTitle}</text>
    <rect class="of-fc-cvd-bg" x="${PL}" y="${botY}" width="${PW}" height="${botH}" fill="#070b12" stroke="#1d2c3e" stroke-width="1"/>
    ${cTicks}
    ${zeroLine}
    ${cohortPaths}
  </svg>`;
}

/**
 * Pure SVG 3-pane chart: Price + Total CVD/Delta Histogram + OI Curve (kept for OI correlation view).
 */
export function orderflowPriceCvdSvg(series = [], divergence = null) {
  if (!Array.isArray(series) || series.length < 3) {
    return '<div class="empty-small" style="padding:28px">차트 데이터를 불러오는 중입니다.</div>';
  }
  const W = 760, H = 310, PL = 10, PR = 68, PW = W - PL - PR;
  const n = series.length;
  const xOf = i => PL + (n > 1 ? (i / (n - 1)) * PW : PW / 2);

  // Pane 1: Total CVD + Bar Delta (y: 18..148)
  const cTop = 18, cH = 130;
  const cvds = series.map(b => b.cvd);
  const cMin = Math.min(0, ...cvds), cMax = Math.max(0, ...cvds);
  const cSpan = cMax - cMin || 1;
  const cy = v => cTop + cH - ((v - cMin) / cSpan) * cH;
  const cvdZeroY = cy(0);
  const cvdPts = series.map((b, i) => `${xOf(i).toFixed(1)},${cy(b.cvd).toFixed(1)}`).join(' ');
  const maxAbsDelta = Math.max(1, ...series.map(b => Math.abs(b.delta || 0)));
  const barW = Math.max(2, Math.min(8, (PW / n) * 0.65));
  const deltaMidY = cTop + cH * 0.5;
  const deltaBars = series.map((b, i) => {
    const h = Math.max(1, (Math.abs(b.delta || 0) / maxAbsDelta) * (cH * 0.42));
    const y = (b.delta || 0) >= 0 ? deltaMidY - h : deltaMidY;
    const fill = (b.delta || 0) >= 0 ? 'rgba(82, 224, 174, 0.34)' : 'rgba(255, 114, 128, 0.34)';
    return `<rect x="${(xOf(i) - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`;
  }).join('');
  const cvdColor = (cvds.at(-1) ?? 0) >= (cvds[0] ?? 0) ? '#52e0ae' : '#ff7280';

  // Pane 2: OI Curve (y: 174..288)
  const oTop = 174, oH = 114;
  const oiPoints = series.map((b, i) => ({ i, v: b.oiUsd })).filter(x => x.v != null && x.v > 0);
  let oiSvg = `<text x="${PL + 8}" y="${oTop + 56}" fill="#7f9bb3" font-size="11">OI 시계열 데이터 미제공 구간</text>`;
  let oiMaxLabel = '', oiMinLabel = '';
  if (oiPoints.length >= 2) {
    const oMin = Math.min(...oiPoints.map(x => x.v));
    const oMax = Math.max(...oiPoints.map(x => x.v));
    const oSpan = oMax - oMin || oMax * 0.005 || 1;
    const oy = v => oTop + oH - ((v - oMin) / oSpan) * oH;
    const oiPts = oiPoints.map(x => `${xOf(x.i).toFixed(1)},${oy(x.v).toFixed(1)}`).join(' ');
    const oiColor = oiPoints.at(-1).v < oiPoints[0].v ? '#ffb86c' : '#7dd3fc';
    oiSvg = `<polyline fill="none" stroke="${oiColor}" stroke-width="2" points="${oiPts}"/>`;
    oiMaxLabel = fmtUsdCompact(oMax);
    oiMinLabel = fmtUsdCompact(oMin);
  }

  const divBadge = divergence && divergence.type && divergence.type !== 'NONE'
    ? `<text x="${PL + 250}" y="13" fill="${divergence.type.startsWith('BULL') ? '#52e0ae' : '#ff8a94'}" font-size="10.5" font-weight="700">● ${esc(divergence.labelKo)}</text>`
    : '';

  return `<svg class="of-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="전체 CVD 및 미결제약정 추이 차트">
    <line x1="${PL}" y1="160" x2="${W - PR}" y2="160" stroke="#22384e" stroke-dasharray="3 3"/>
    <text x="${PL + 4}" y="13" fill="#89a7c2" font-size="10.5" font-weight="700">전체 합산 CVD · 봉별 순매수/매도 막대</text>
    ${divBadge}
    <line x1="${PL}" y1="${cvdZeroY.toFixed(1)}" x2="${W - PR}" y2="${cvdZeroY.toFixed(1)}" stroke="#2e4a63" stroke-width="1"/>
    ${deltaBars}
    <polyline fill="none" stroke="${cvdColor}" stroke-width="2" points="${cvdPts}"/>
    <text x="${W - PR + 6}" y="${cTop + 12}" fill="#7f9bb3" font-size="9.5">${esc(fmtUsdCompact(cMax, true))}</text>
    <text x="${W - PR + 6}" y="${cy(cvds.at(-1)).toFixed(1)}" fill="${cvdColor}" font-size="10" font-weight="700">${esc(fmtUsdCompact(cvds.at(-1), true))}</text>
    <text x="${W - PR + 6}" y="${cTop + cH}" fill="#7f9bb3" font-size="9.5">${esc(fmtUsdCompact(cMin, true))}</text>
    <text x="${PL + 4}" y="${oTop + 2}" fill="#89a7c2" font-size="10.5" font-weight="700">미결제약정 (OI · USD)</text>
    ${oiSvg}
    ${oiMaxLabel ? `<text x="${W - PR + 6}" y="${oTop + 12}" fill="#7f9bb3" font-size="9.5">${esc(oiMaxLabel)}</text>` : ''}
    ${oiMinLabel ? `<text x="${W - PR + 6}" y="${oTop + oH}" fill="#7f9bb3" font-size="9.5">${esc(oiMinLabel)}</text>` : ''}
    <text x="${PL + 4}" y="${H - 4}" fill="#6e8ca6" font-size="9.5">${esc(fmtKst(series[0].t, true))}</text>
    <text x="${(W - PR - 74).toFixed(1)}" y="${H - 4}" fill="#6e8ca6" font-size="9.5">${esc(fmtKst(series.at(-1).t, true))}</text>
  </svg>`;
}

/**
 * Render Estimated Liquidation Cluster Heatmap above & below mark price.
 */
export function orderflowLiqMapHTML(liqMap) {
  if (!liqMap || (!liqMap.above?.length && !liqMap.below?.length)) {
    return '<div class="empty-small" style="padding:20px">추정 청산맵을 계산할 데이터가 부족합니다.</div>';
  }
  const aboveDesc = [...(liqMap.above || [])].reverse();
  const belowDesc = [...(liqMap.below || [])];

  const rowHTML = b => {
    const isShort = b.side === 'SHORT_LIQ';
    const pct = Math.max(4, Math.min(100, Math.round((b.intensity || 0) * 100)));
    const hot = b.intensity >= 0.72 ? ' hot' : '';
    return `<div class="of-liq-row ${isShort ? 'short' : 'long'}${hot}">
      <span class="of-liq-px">${esc(fmtPx(b.price))}</span>
      <span class="of-liq-dist">${esc(fmtPct(b.distPct, 2))}</span>
      <div class="of-liq-bar-wrap"><div class="of-liq-bar" style="width:${pct}%"></div></div>
      <span class="of-liq-lev">${esc(b.dominantLeverage)}x</span>
      <span class="of-liq-usd">${esc(fmtUsdCompact(b.usd))}</span>
    </div>`;
  };

  const sMag = liqMap.nearestShortMagnet;
  const lMag = liqMap.nearestLongMagnet;

  return `<div class="of-liq-wrap">
    <div class="of-liq-head"><span>구간 가격</span><span>괴리</span><span>추정 청산 밀집도 (상단=숏 청산 · 하단=롱 청산)</span><span>주 배율</span><span>추정 규모</span></div>
    <div class="of-liq-side">${aboveDesc.map(rowHTML).join('')}</div>
    <div class="of-liq-mark"><span>현재 마크가</span><b>${esc(fmtPx(liqMap.markPrice))}</b><small>스캔 폭 ±${esc(liqMap.spanPct ?? 6)}%</small></div>
    <div class="of-liq-side">${belowDesc.map(rowHTML).join('')}</div>
    <div class="of-liq-magnets">
      <div class="of-mag short"><span>상단 최대 숏 청산존</span><b>${sMag ? `${esc(fmtPx(sMag.price))} (${esc(fmtPct(sMag.distPct))}) · ${esc(fmtUsdCompact(sMag.usd))}` : '—'}</b></div>
      <div class="of-mag long"><span>하단 최대 롱 청산존</span><b>${lMag ? `${esc(fmtPx(lMag.price))} (${esc(fmtPct(lMag.distPct))}) · ${esc(fmtUsdCompact(lMag.usd))}` : '—'}</b></div>
    </div>
    <p class="of-liq-note">※ 공개 OHLCV·거래량·OI·롱/숏 기울기 기반 <b>추정 청산맵</b>입니다 (거래소 비공개 내부 호가창 아님).</p>
  </div>`;
}

/**
 * Render clickable "실시간 수급 이상치 레이더" strip.
 */
export function orderflowRadarHTML(radar, activeSymbol = '', loading = false) {
  const items = radar?.anomalies || [];
  const meta = radar?.scanned
    ? `${radar.scanned}종목 스캔 · 이상치 ${radar.flaggedCount ?? 0}건 · ${fmtKst(radar.at)} KST`
    : loading ? '상위 20종목 5분봉 수급 스캔 중…' : '스캔 대기 중';
  const cards = items.length
    ? items.slice(0, 8).map(x => {
      const short = String(x.symbol || '').replace(/USDT$/, '');
      const active = x.symbol === activeSymbol ? ' active' : '';
      const tags = (x.tags || []).slice(0, 2).map(t => `<span class="of-tag ${esc(t.tone || 'neutral')}">${esc(t.text)}</span>`).join('')
        || `<span class="of-tag neutral">매수 ${esc(x.lastBuySharePct ?? 50)}%</span>`;
      return `<button type="button" class="of-radar-card${active}" data-of-symbol="${esc(x.symbol)}">
        <div class="of-rc-top"><b>${esc(short)}</b><span>${esc(fmtPx(x.markPrice))}</span></div>
        <div class="of-rc-tags">${tags}</div>
        <div class="of-rc-meta">30m OI ${esc(fmtPct(x.oiChange30mPct))} · 매수 ${esc(x.lastBuySharePct ?? 50)}%</div>
      </button>`;
    }).join('')
    : `<div class="empty-small" style="padding:8px 0">${loading ? '상위 종목의 OI·CVD·다이버전스를 스캔하고 있습니다…' : '표시할 수급 레이더 데이터가 없습니다.'}</div>`;

  return `<section class="of-radar" aria-label="전 종목 수급 이상치 레이더">
    <div class="of-radar-head">
      <div><b>실시간 수급 이상치 레이더</b><small>${esc(meta)}</small></div>
      <button type="button" class="outline-btn small" data-of-radar-refresh>${loading ? '스캔 중…' : '↻ 레이더 스캔'}</button>
    </div>
    <div class="of-radar-grid">${cards}</div>
  </section>`;
}

/** Range tabs: 실시간 plus the FireCharts 1D 1W 1M 6M 1Y 3Y (3Y = 1,095 daily candles, see firechart.mjs). */
export const FIRECHART_RANGE_TABS = Object.freeze([['LIVE', '실시간'], ['1D', '1D'], ['1W', '1W'], ['1M', '1M'], ['6M', '6M'], ['1Y', '1Y'], ['3Y', '3Y']]);

/** Clamp a percentile pair to 0..100 with low <= high (the low thumb cannot pass the high one, and back). */
export function clampPercentiles(minPct, maxPct, moved = 'min') {
  const c = v => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));
  let lo = c(minPct), hi = c(maxPct);
  if (lo > hi) { if (moved === 'max') lo = hi; else hi = lo; }
  return { minPct: lo, maxPct: hi };
}

/** "Volume Percentiles a .. b": one track with two thumbs (two native range inputs, so keyboard and screen readers work). */
export function firechartPercentileHTML(minPct = 93, maxPct = 99) {
  const { minPct: lo, maxPct: hi } = clampPercentiles(Math.min(minPct, maxPct), Math.max(minPct, maxPct));
  return `<div class="of-fc-pct-ctrl" role="group" aria-label="Volume Percentiles (호가 유동성 백분위 범위)">
        <span class="of-fc-pct-title">Volume Percentiles: <b data-of-pct-label>${esc(lo)} .. ${esc(hi)}</b></span>
        <div class="of-fc-dual" data-of-pct-dual style="--lo:${lo};--hi:${hi}">
          <span class="of-fc-dual-track" aria-hidden="true"></span>
          <span class="of-fc-dual-fill" aria-hidden="true"></span>
          <input type="range" min="0" max="100" step="1" value="${esc(lo)}" data-of-pct-min aria-label="최소 유동성 백분위">
          <input type="range" min="0" max="100" step="1" value="${esc(hi)}" data-of-pct-max aria-label="최대 유동성 백분위">
        </div>
      </div>`;
}

/**
 * CVD legend under the chart, as in the screenshot: one chip per line (same colour token), the latest cumulative
 * value, the Normalized / Absolute toggle ("CVD 표시 모드"), the two readings and how this range's CVD was made.
 * A chip toggles its line (aria-pressed).
 */
export function firechartLegendHTML(data, { cvdMode = 'normalized', hiddenClasses = [] } = {}) {
  const fc = data?.firechart;
  if (!fc) return '';
  const hidden = new Set(hiddenClasses || []);
  const latest = fc.cohorts?.series?.at(-1) || fc.cohorts?.latest || null;
  const counts = fc.cohorts?.classCounts || null;
  const real = fc.cohortMode === 'REAL_TRADES';
  const chips = FIRECHART_CVD_CLASSES.map(m => {
    const on = !hidden.has(m.key);
    const val = cvdPointValue(latest, m.key, 'absolute');
    const none = real && counts && counts[m.key] === 0;
    const valTxt = none ? '체결 없음' : fmtUsdCompact(val, true);
    const tone = none ? 'muted' : val > 0 ? 'paper-profit' : val < 0 ? 'paper-loss' : 'muted';
    return `<button type="button" class="of-fc-leg wcv-${m.key}${on ? '' : ' off'}" data-of-cvd-class="${m.key}" aria-pressed="${on}" title="${esc(m.legend)} 선 ${on ? '숨기기' : '보이기'} · 최근 누적 CVD"><i aria-hidden="true"></i><b>${esc(m.legend)}</b><em class="${tone}">${esc(valTxt)}</em></button>`;
  }).join('');

  const cDiv = fc.cohorts?.divergence;
  const divBadge = cDiv && cDiv.badgeKo
    ? `<span class="of-tag ${cDiv.tone === 'pos' ? 'pos' : cDiv.tone === 'neg' ? 'neg' : 'neutral'}" data-of-cohort-div title="${esc(cDiv.detailKo || '')}">${esc(cDiv.badgeKo)}</span>`
    : '';
  const spanMin = Number(fc.cohorts?.spanSec) > 0 ? Math.max(1, Math.round(fc.cohorts.spanSec / 60)) : null;
  const modeNote = real
    ? `실제 체결 ${esc(fc.cohorts?.tradeCount ?? 0)}건${spanMin ? `(최근 약 ${esc(spanMin)}분)` : ''}을 주문 금액대로 나눠 누적 · 실시간 호가벽 ${esc(fc.heatmap?.liveWalls?.length ?? 0)}개${fc.heatmap?.snapshotCount > 0 ? ` · 누적 스냅샷 ${esc(fc.heatmap.snapshotCount)}회` : ''}`
    : `All Orders는 봉별 실제 테이커 순매수 · 금액대 5개는 봉 거래 규모로 나눈 추정 · 우측 실시간 호가벽(${esc(SOURCE_LABELS[fc.bookSource] || fc.bookSource || '—')})`;
  const isAbs = cvdMode === 'absolute';
  return `<div class="of-fc-legend-row">
      <div class="of-fc-legends" role="group" aria-label="CVD 금액대 (눌러서 선 숨기기·보이기)">${chips}</div>
    </div>
    <div class="of-fc-notes">
      <div class="of-fc-note-list">
        ${FIRECHART_CVD_NOTES.map((t, i) => `<span class="of-fc-note"><i class="wcv-dot wcv-${i === 0 ? 'brown' : 'orange'}" aria-hidden="true"></i>${esc(t)}</span>`).join('')}
        ${divBadge}
      </div>
      <div class="of-fc-mode-toggle" role="group" aria-label="CVD 표시 모드">
        <button type="button" class="of-fc-tab${isAbs ? '' : ' active'}" data-of-cvd-mode="normalized" aria-pressed="${!isAbs}">Normalized CVD</button>
        <button type="button" class="of-fc-tab${isAbs ? ' active' : ''}" data-of-cvd-mode="absolute" aria-pressed="${isAbs}">Absolute CVD</button>
      </div>
      <small class="of-fc-mode-note">${modeNote}</small>
    </div>`;
}

const CVD_SR_TFS = Object.freeze([
  ['LIVE', '실시간'],
  ['1D', '1D'],
  ['1W', '1W'],
  ['1M', '1M'],
  ['6M', '6M'],
  ['1Y', '1Y'],
]);

/**
 * All-symbol multi-timeframe CVD Support / Resistance summary table (no clicking one-by-one).
 */
export function orderflowCvdSrMatrixHTML(cvdSr, { activeSymbol = '', loading = false, filter = 'all' } = {}) {
  const allRows = Array.isArray(cvdSr?.rows) ? cvdSr.rows : [];
  const activeFilter = ['all', 'held', 'strong'].includes(filter) ? filter : 'all';
  const rows = allRows.filter(r => {
    if (activeFilter === 'held') return r.held === true;
    if (activeFilter === 'strong') return (Number(r.strongCount) || 0) > 0;
    return true;
  });
  const heldCount = allRows.filter(r => r.held).length;
  const recent = Array.isArray(cvdSr?.recentEvents) ? cvdSr.recentEvents.slice(0, 3) : [];
  const monBadge = cvdSr?.monitoring ? '<span class="of-sr-mon">🔔 보유 종목 생성·소멸 텔레그램 감시 ON</span>' : '';

  const zonePill = (z, sym, tfLabel) => {
    if (!z) return '<span class="of-sr-none">—</span>';
    const isStrong = z.grade === 'STRONG';
    if (activeFilter === 'strong' && !isStrong) return '<span class="of-sr-none">—</span>';
    const isSup = z.kind === 'SUPPORT';
    const cls = `${isSup ? 'of-sr-sup' : 'of-sr-res'}${isStrong ? ' is-strong' : ' is-mid'}`;
    const tag = isSup ? '지' : '저';
    const dist = fin(z.distPct) ? `${Number(z.distPct) >= 0 ? '+' : '−'}${Math.abs(Number(z.distPct)).toFixed(1)}%` : '';
    const side = isSup ? 'LONG' : 'SHORT';
    const wallLabel = `CVD ${tfLabel} ${isStrong ? '강력 ' : ''}${isSup ? '지지대' : '저항대'}`;
    return `<button type="button" class="of-sr-pill ${cls}" data-of-send-real-order data-symbol="${esc(sym)}" data-price="${esc(z.centerPrice)}" data-side="${side}" data-wall-label="${esc(wallLabel)}" title="${esc(wallLabel)} · 강도 ${esc(z.strength)} · CVD ${esc(fmtUsdCompact(z.netDeltaUsd, true))} (클릭 시 실계좌 지정가 입력)">
      <i>${tag}</i><b>$${esc(fmtPx(z.centerPrice))}</b><small>${esc(dist)}</small>${isStrong ? '<em>강</em>' : ''}
    </button>`;
  };

  const body = rows.length ? `<div class="of-sr-scroll"><table class="of-sr-table">
    <thead><tr><th>종목</th><th>현재가</th>${CVD_SR_TFS.map(([, lbl]) => `<th>${lbl}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => {
      const sym = String(r.symbol || '');
      const short = String(r.displaySymbol || sym).replace(/USDT$/, '');
      const isAct = sym === activeSymbol;
      const dirs = Array.isArray(r.directions) && r.directions.length
        ? r.directions.map(d => `<span class="of-sr-dir ${d === 'SHORT' ? 'neg' : 'pos'}">${d === 'SHORT' ? '숏' : '롱'}</span>`).join('')
        : '';
      const cells = CVD_SR_TFS.map(([k, lbl]) => {
        const tf = r.timeframes?.[k];
        return `<td class="of-sr-cell">${zonePill(tf?.bestResistance, sym, lbl)}${zonePill(tf?.bestSupport, sym, lbl)}</td>`;
      }).join('');
      return `<tr class="${r.held ? 'is-held' : ''}${isAct ? ' is-active' : ''}">
        <td class="of-sr-sym"><button type="button" class="of-sr-sym-btn" data-of-symbol="${esc(sym)}" title="${esc(sym)} 상세 차트 보기">${r.held ? '<i class="of-held-dot"></i>' : ''}<b>${esc(short)}</b>${dirs}</button></td>
        <td class="of-sr-px">$${esc(fmtPx(r.markPrice))}</td>
        ${cells}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`
    : `<div class="empty-small" style="padding:10px 0">${loading ? '전 종목의 실시간·1D·1W·1M·6M·1Y CVD 지지/저항대를 스캔하고 있습니다…' : activeFilter === 'held' ? '현재 실계좌 보유 중인 종목이 없습니다.' : '표시할 CVD 지지/저항대 데이터가 없습니다.'}</div>`;

  const recentStrip = recent.length ? `<div class="of-sr-recent">${recent.map(ev => {
    const short = String(ev.displaySymbol || ev.symbol || '').replace(/USDT$/, '');
    const kindKo = ev.kind === 'SUPPORT' ? '지지' : '저항';
    const isRem = ev.event === 'REMOVED';
    return `<span class="of-sr-ev ${isRem ? 'rem' : 'add'}">${isRem ? '⚠️ 소멸' : ev.kind === 'SUPPORT' ? '🟢 신규' : '🔴 신규'} <b>${esc(short)}</b> ${esc(ev.tf)} ${kindKo} $${esc(fmtPx(ev.price))}</span>`;
  }).join('')}</div>` : '';

  const fBtn = (k, lbl) => `<button type="button" class="of-fc-tab${activeFilter === k ? ' active' : ''}" data-of-sr-filter="${k}" aria-pressed="${activeFilter === k}">${lbl}</button>`;

  return `<section class="of-sr-box" aria-label="전 종목 CVD 멀티 타임프레임 지지·저항대">
    <div class="of-sr-head">
      <div>
        <b>🧱 전 종목 CVD 지지·저항대</b>
        <small>실시간 · 1D · 1W · 1M · 6M · 1Y 한눈에 보기 (가격 클릭 → 지정가 입력)</small>
        ${monBadge}
      </div>
      <div class="of-sr-actions">
        <div class="of-fc-span-toggle" role="group" aria-label="CVD 지지/저항 필터">
          ${fBtn('all', `전체 (${allRows.length})`)}
          ${fBtn('held', `보유 (${heldCount})`)}
          ${fBtn('strong', '강력만')}
        </div>
        <button type="button" class="outline-btn small" data-of-sr-refresh>${loading ? '스캔 중…' : '↻ 스캔'}</button>
      </div>
    </div>
    ${recentStrip}
    ${body}
  </section>`;
}

/**
 * Full "호가·CVD·청산맵" screen HTML renderer (pure, unit-testable).
 */
export function orderflowHTML(data, {
  symbol = 'BTCUSDT',
  range = 'LIVE',
  cvdMode = 'normalized',
  minPct = 93,
  maxPct = 99,
  priceSpan = 'wide',
  inspected = null,
  loading = false,
  error = '',
  radar = null,
  radarLoading = false,
  cvdSr = null,
  cvdSrLoading = false,
  cvdSrFilter = 'all',
  fcWidth = 920,
  hiddenClasses = [],
  whaleZones = [],
} = {}) {
  const activeSym = data?.symbol || symbol;
  const activeRange = data?.range || range || 'LIVE';
  const activeSpan = ['tight', 'normal', 'wide', 'ultra'].includes(priceSpan) ? priceSpan : 'wide';
  const quick = data?.quickSymbols?.length ? data.quickSymbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'AVAXUSDT', 'LINKUSDT', 'ADAUSDT', '1000PEPEUSDT'];
  const openSet = new Set(data?.openSymbols || []);

  const chips = quick.slice(0, 18).map(s => {
    const short = s.replace(/USDT$/, '');
    const active = s === activeSym ? ' active' : '';
    const held = openSet.has(s) ? '<i class="of-held-dot" title="실계좌 보유 중"></i>' : '';
    return `<button type="button" class="of-chip${active}" data-of-symbol="${esc(s)}">${held}${esc(short)}</button>`;
  }).join('');

  const realPosList = Array.isArray(data?.realPositions) ? data.realPositions : [];
  const realPosStrip = realPosList.length ? `<div class="of-real-positions" aria-label="실계좌 보유 포지션">
    <span class="of-real-label">실계좌 보유 ${realPosList.length}</span>
    ${realPosList.map(p => {
      const sym = String(p.symbol || '');
      const short = sym.replace(/USDT$/, '');
      const active = sym === activeSym ? ' active' : '';
      const dirKo = p.direction === 'SHORT' ? '숏' : p.direction === 'LONG' ? '롱' : '';
      const dirCls = p.direction === 'SHORT' ? 'neg' : p.direction === 'LONG' ? 'pos' : '';
      const levTxt = fin(p.leverage) ? `${Number(p.leverage)}x` : '';
      const pnlVal = fin(p.unrealized) ? Number(p.unrealized) : null;
      const roeVal = fin(p.roePct) ? Number(p.roePct) : null;
      const pnlCls = pnlVal == null ? '' : pnlVal > 0 ? 'pos' : pnlVal < 0 ? 'neg' : '';
      const pnlTxt = pnlVal == null ? '' : `${pnlVal >= 0 ? '+' : '−'}$${Math.abs(pnlVal).toFixed(2)}`;
      const roeTxt = roeVal == null ? '' : `(${roeVal >= 0 ? '+' : '−'}${Math.abs(roeVal).toFixed(1)}%)`;
      const origTxt = p.origin === 'copy' ? (p.manualLinked ? '비율연결' : '카피') : p.origin === 'scalp' ? '단타' : '수동';
      return `<button type="button" class="of-real-chip${active}" data-of-symbol="${esc(sym)}" title="실계좌 ${esc(origTxt)} 포지션 — 클릭하면 해당 종목 CVD 조회">
        <i class="of-held-dot"></i><b>${esc(short)}</b>
        ${dirKo ? `<span class="${dirCls}">${dirKo}</span>` : ''}
        ${levTxt ? `<small class="muted">${esc(levTxt)}</small>` : ''}
        ${pnlTxt ? `<b class="${pnlCls}">${pnlTxt} <small>${roeTxt}</small></b>` : ''}
      </button>`;
    }).join('')}
  </div>` : '';

  const rangeBtns = FIRECHART_RANGE_TABS.map(([k, lbl]) =>
    `<button type="button" class="outline-btn small${activeRange === k ? ' active-btn' : ''}" data-of-range="${k}" aria-pressed="${activeRange === k}">${lbl}</button>`
  ).join('');

  const spanBtns = [['tight', '좁게'], ['normal', '표준'], ['wide', '넓게'], ['ultra', '초광역']].map(([k, lbl]) =>
    `<button type="button" class="of-fc-tab${activeSpan === k ? ' active' : ''}" data-of-price-span="${k}" aria-pressed="${activeSpan === k}">${lbl}</button>`
  ).join('');

  const srcBadge = data?.source ? `<span class="of-src-badge">${esc(SOURCE_LABELS[data.source] || data.source)}</span>` : '';
  const updated = data?.at ? `<small class="muted">갱신 ${esc(fmtKst(data.at))} KST</small>` : '';

  const controls = `<div class="of-controls">
    <form class="of-search-form" data-of-form>
      <input type="text" name="symbol" value="${esc(activeSym)}" placeholder="종목 입력 (예: BTC, SOL, ORCA)" aria-label="수급 조회 종목">
      <button type="submit" class="outline-btn small">조회</button>
    </form>
    <div class="of-iv-group">${rangeBtns}</div>
    <div class="of-meta-right">${srcBadge}${updated}<button type="button" class="outline-btn small" data-of-refresh>${loading ? '불러오는 중…' : '↻ 새로고침'}</button></div>
  </div>
  ${realPosStrip}
  <div class="of-chips" aria-label="빠른 종목 선택">${chips}</div>`;

  const cvdSrBox = orderflowCvdSrMatrixHTML(cvdSr, { activeSymbol: activeSym, loading: cvdSrLoading, filter: cvdSrFilter });
  const radarBox = orderflowRadarHTML(radar, activeSym, radarLoading);

  if (error && !data) {
    return `${controls}${cvdSrBox}${radarBox}<div class="venues-status warn" style="margin:14px 18px">수급 데이터 조회 실패: ${esc(error)}</div>`;
  }
  if (!data) {
    return `${controls}${cvdSrBox}${radarBox}<div class="empty-small" style="padding:36px">호가·CVD·청산맵 데이터를 불러오는 중입니다…</div>`;
  }

  const px = data.price || {}, cvd = data.cvd || {}, oi = data.oi || {}, ratios = data.ratios || {}, fund = data.funding || {}, liq = data.liquidations || {}, sig = data.scalpSignal || {};
  const fc = data.firechart || null;
  const firechartCard = `<section class="of-fc-card" aria-label="Fire Chart 호가 히트맵 및 금액대별 CVD">
    <div class="of-fc-bar">
      ${firechartPercentileHTML(minPct, maxPct)}
      <div class="of-fc-span-ctrl">
        <span>가격 범위</span>
        <div class="of-fc-span-toggle" role="group" aria-label="가격 Y축 범위">${spanBtns}</div>
      </div>
    </div>
    <div data-of-fc-inspect-wrap>${firechartInspectBarHTML(inspected, activeSym)}</div>
    <div class="of-fc-canvas" data-of-fc-canvas>${firechartSvg(data, { cvdMode, minPct, maxPct, priceSpan: activeSpan, inspected, width: fcWidth, hiddenClasses, whaleZones })}</div>
    <div data-of-fc-legend-wrap>${firechartLegendHTML(data, { cvdMode, hiddenClasses })}</div>
    <div data-of-wall-strip-wrap>${firechartWallSummaryHTML(data, { minPct, maxPct, priceSpan: activeSpan, inspected })}</div>
  </section>`;

  const buyPct = fin(cvd.lastBuySharePct) ? Number(cvd.lastBuySharePct) : 50;
  const sellPct = +(100 - buyPct).toFixed(1);
  const divCls = cvd.divergence?.type?.startsWith('BULL') ? 'pos' : cvd.divergence?.type?.startsWith('BEAR') ? 'neg' : 'neutral';
  const oiCls = oi.state === 'OI_FLUSH' ? 'pos' : oi.state === 'OI_PILE_IN' ? 'warn' : 'neutral';
  const oiLabel = oi.state === 'OI_FLUSH' ? '청산 소진 (+5점 조건)' : oi.state === 'OI_PILE_IN' ? '신규 레버리지 유입' : '보합';
  const fundCls = fund.state === 'LONG_CROWDED' ? 'neg' : fund.state === 'SHORT_CROWDED' ? 'pos' : 'neutral';
  const fundLabel = fund.state === 'LONG_CROWDED' ? '롱 과열 (숏 유리)' : fund.state === 'SHORT_CROWDED' ? '숏 과열 (롱 유리)' : '중립';
  const countdown = fmtCountdown(fund.nextFundingTime, data.at);

  const acc = ratios.account, top = ratios.topTrader;
  const ratioBar = (label, r) => r
    ? `<div class="of-ratio-row"><span>${label} <b>${esc(r.ratio)}</b></span><div class="of-split-bar"><i class="buy" style="width:${r.longPct}%"></i><i class="sell" style="width:${r.shortPct}%"></i></div><small>롱 ${r.longPct}% · 숏 ${r.shortPct}%</small></div>`
    : `<div class="of-ratio-row"><span>${label}</span><small class="muted">미제공</small></div>`;

  const boostPills = [
    sig.oiBonusEligible ? '<span class="of-pill pos">OI 소진 +5점 충족</span>' : '<span class="of-pill muted">OI +5점 대기 (30m -1%↓)</span>',
    sig.cvdBoostSide === 'LONG' ? '<span class="of-pill pos">롱 CVD 강한반전 1.5x 충족</span>'
      : sig.cvdBoostSide === 'SHORT' ? '<span class="of-pill neg">숏 CVD 강한반전 1.5x 충족</span>'
        : '<span class="of-pill muted">CVD 1.5x 대기 (±15%↑)</span>',
  ].join('');

  const verdictBanner = `<div class="of-verdict">
    <div class="of-verdict-main"><b>${esc(activeSym)}</b> <span>${esc(sig.summaryKo || '수급 분석 완료')}</span></div>
    <div class="of-verdict-pills">${boostPills}</div>
  </div>`;

  const kpis = `<div class="of-kpi-grid">
    <div class="of-kpi">
      <div class="of-kpi-label">현재 마크가 <small>${esc(activeRange)} 구간 ${esc(fmtPct(px.windowChangePct))}</small></div>
      <div class="of-kpi-val">${esc(fmtPx(px.mark))}</div>
      <div class="of-kpi-sub">인덱스 ${esc(fmtPx(px.index))} · 베이시스 ${esc(fmtPct(px.basisPct, 3))}</div>
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">합산 CVD & 다이버전스 <span class="of-tag ${divCls}">${esc(cvd.divergence?.labelKo || '중립')}</span></div>
      <div class="of-kpi-val ${cvd.current >= 0 ? 'paper-profit' : 'paper-loss'}">${esc(fmtUsdCompact(cvd.current, true))}</div>
      <div class="of-split-bar"><i class="buy" style="width:${buyPct}%"></i><i class="sell" style="width:${sellPct}%"></i></div>
      <div class="of-kpi-sub">직전 봉 매수 ${buyPct}% · 매도 ${sellPct}% · 6봉 ${esc(fmtUsdCompact(cvd.change6, true))}</div>
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">미결제약정 (OI) <span class="of-tag ${oiCls}">${oiLabel}</span></div>
      <div class="of-kpi-val">${esc(fmtUsdCompact(oi.usd))}</div>
      <div class="of-kpi-sub">30분 <b class="${(oi.change30mPct ?? 0) <= -1 ? 'paper-profit' : ''}">${esc(fmtPct(oi.change30mPct))}</b> · 1시간 ${esc(fmtPct(oi.change1hPct))} · 4시간 ${esc(fmtPct(oi.change4hPct))}</div>
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">롱 / 숏 비율 (계정 · 상위 트레이더)</div>
      ${ratioBar('전체 계정', acc)}
      ${ratioBar('상위 고래', top)}
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">펀딩비 (8h) <span class="of-tag ${fundCls}">${fundLabel}</span></div>
      <div class="of-kpi-val ${(fund.ratePct ?? 0) > 0 ? 'paper-loss' : (fund.ratePct ?? 0) < 0 ? 'paper-profit' : ''}">${fin(fund.ratePct) ? fmtPct(fund.ratePct, 4) : '—'}</div>
      <div class="of-kpi-sub">연환산 ${fin(fund.annualPct) ? fmtPct(fund.annualPct, 1) : '—'}${countdown ? ` · 다음 정산 ${esc(countdown)}` : ''}</div>
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">최근 강제청산 실측 <small>${liq.hasActualData ? 'Gate.io 실측' : '미제공'}</small></div>
      <div class="of-kpi-liq">
        <span>30분 롱 청산 <b class="paper-loss">${esc(fmtUsdCompact(liq.recent30m?.longUsd ?? 0))}</b></span>
        <span>30분 숏 청산 <b class="paper-profit">${esc(fmtUsdCompact(liq.recent30m?.shortUsd ?? 0))}</b></span>
      </div>
      <div class="of-kpi-sub">전체 구간 롱 ${esc(fmtUsdCompact(liq.window?.longUsd ?? 0))} · 숏 ${esc(fmtUsdCompact(liq.window?.shortUsd ?? 0))}</div>
    </div>
  </div>`;

  const mainGrid = `<div class="of-main-grid">
    <div class="of-card">
      <div class="of-card-head"><h4>합산 CVD · 미결제약정 (OI) 추이</h4><small>${esc(cvd.divergence?.detailKo || '')}</small></div>
      <div class="of-chart-box">${orderflowPriceCvdSvg(data.series, cvd.divergence)}</div>
    </div>
    <div class="of-card">
      <div class="of-card-head"><h4>추정 청산맵 (상·하단 레버리지 밀집 구간)</h4><small>100x · 50x · 25x · 10x · 5x 클러스터</small></div>
      ${orderflowLiqMapHTML(data.liquidationMap)}
    </div>
  </div>`;

  return `${controls}${error ? `<div class="venues-status warn" style="margin:8px 18px">${esc(error)}</div>` : ''}${cvdSrBox}${firechartCard}${verdictBanner}${kpis}${mainGrid}${radarBox}`;
}

// Browser controller (lazy-loaded when #orderflow tab is shown; auto-refreshes every 30s while open)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const host = document.getElementById('orderflowRoot');
  if (host) {
    const readLS = (k, fb) => { try { return localStorage.getItem(k) || fb; } catch { return fb; } };
    const state = {
      symbol: readLS('sl_of_symbol', 'BTCUSDT'),
      range: readLS('sl_of_range', 'LIVE'),
      cvdMode: readLS('sl_of_cvd_mode', 'normalized'),
      priceSpan: readLS('sl_of_price_span', 'wide'),
      minPct: Number(readLS('sl_of_min_pct', '93')) || 93,
      maxPct: Number(readLS('sl_of_max_pct', '99')) || 99,
      inspected: null,
      inspectLocked: false,
      data: null,
      loading: false,
      error: '',
      radar: null,
      radarLoading: false,
      cvdSr: null,
      cvdSrLoading: false,
      cvdSrFilter: readLS('sl_of_sr_filter', 'all'),
      fcWidth: 920,
      hiddenClasses: (() => { try { return JSON.parse(readLS('sl_of_cvd_hidden', '[]')).filter(k => CVD_KEYS.includes(k)); } catch { return []; } })(),
      whaleZones: [],
      whaleZonesSymbol: '',
      whaleZonesMissingUntil: 0,
    };
    ({ minPct: state.minPct, maxPct: state.maxPct } = clampPercentiles(state.minPct, state.maxPct));

    // Draw the SVG at the canvas' real width (minus its 8 px side padding) so labels stay readable on a phone.
    const measureWidth = () => {
      const box = host.querySelector('[data-of-fc-canvas]');
      const w = (box?.clientWidth || host.clientWidth || 920) - 16;
      return Math.max(280, Math.min(1400, Math.round(w)));
    };
    const render = () => {
      if (host.clientWidth > 0) state.fcWidth = measureWidth();
      host.innerHTML = orderflowHTML(state.data, state);
      const w = measureWidth();
      if (state.data && Math.abs(w - state.fcWidth) > 4) { state.fcWidth = w; rerenderFirechartOnly(); }
    };
    const rerenderFirechartOnly = () => {
      const box = host.querySelector('[data-of-fc-canvas]');
      const lbl = host.querySelector('[data-of-pct-label]');
      const inspWrap = host.querySelector('[data-of-fc-inspect-wrap]');
      const stripWrap = host.querySelector('[data-of-wall-strip-wrap]');
      if (lbl) lbl.textContent = `${Math.min(state.minPct, state.maxPct)} .. ${Math.max(state.minPct, state.maxPct)}`;
      if (inspWrap) inspWrap.innerHTML = firechartInspectBarHTML(state.inspected, state.data?.symbol || state.symbol);
      const legendWrap = host.querySelector('[data-of-fc-legend-wrap]');
      const dual = host.querySelector('[data-of-pct-dual]');
      if (dual) { dual.style.setProperty('--lo', String(state.minPct)); dual.style.setProperty('--hi', String(state.maxPct)); }
      if (box && state.data) box.innerHTML = firechartSvg(state.data, { ...state, width: state.fcWidth });
      if (legendWrap && state.data) legendWrap.innerHTML = firechartLegendHTML(state.data, state);
      if (stripWrap && state.data) stripWrap.innerHTML = firechartWallSummaryHTML(state.data, state);
      host.querySelectorAll('[data-of-price-span]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.ofPriceSpan === state.priceSpan);
      });
    };

    const wallFromElement = el => {
      if (!el || !state.data) return null;
      const price = Number(el.dataset.wallPrice);
      if (!Number.isFinite(price) || price <= 0) return null;
      const mark = Number(state.data?.price?.mark) || Number(state.data?.series?.at(-1)?.c) || 0;
      const distPct = mark > 0 ? +(((price - mark) / mark) * 100).toFixed(2) : null;
      return {
        snapped: true,
        price,
        usd: Number(el.dataset.wallUsd) || 0,
        side: el.dataset.wallSide || (mark > 0 && price < mark ? 'BID' : 'ASK'),
        pctRank: Number(el.dataset.wallPct) || 95,
        live: el.dataset.wallLive === '1',
        distPct,
      };
    };

    const inspectFromPointer = (e, svg) => {
      if (!svg || !state.data) return null;
      const directWall = e.target?.closest?.('.of-fc-wall');
      if (directWall) {
        const hit = wallFromElement(directWall);
        if (hit) return hit;
      }
      const rect = svg.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      const W = Number(svg.dataset.w) || 920;
      const H = Number(svg.dataset.h) || 496;
      const PL = Number(svg.dataset.pl) || 86;
      const PW = Number(svg.dataset.pw) || 756;
      const topY = Number(svg.dataset.topY) || 16;
      const topH = Number(svg.dataset.topH) || 238;
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      const svgY = ((e.clientY - rect.top) / rect.height) * H;
      if (svgX < PL - 12 || svgX > PL + PW + 65 || svgY < topY - 8 || svgY > topY + topH + 8) return null;
      const xNorm = Math.max(0, Math.min(1, (svgX - PL) / PW));
      const yNorm = Math.max(0, Math.min(1, (svgY - topY) / topH));
      return findFirechartWallAt(state.data, { xNorm, yNorm, minPct: state.minPct, maxPct: state.maxPct, priceSpan: state.priceSpan });
    };
    const isVisible = () => {
      const sec = document.getElementById('orderflow');
      return Boolean(sec && !sec.hidden);
    };

    async function load({ force = false } = {}) {
      if (state.loading) return;
      state.loading = true;
      state.error = '';
      render();
      try {
        const q = `/api/orderflow?symbol=${encodeURIComponent(state.symbol)}&range=${encodeURIComponent(state.range)}${force ? '&force=1' : ''}`;
        const res = await fetch(q, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
        state.data = body;
        state.symbol = body.symbol || state.symbol;
        try {
          localStorage.setItem('sl_of_symbol', state.symbol);
          localStorage.setItem('sl_of_range', state.range);
        } catch {}
      } catch (e) {
        state.error = e?.message || '수급 데이터 조회 실패';
      } finally {
        state.loading = false;
        render();
      }
      void loadWhaleZones();
    }

    // 고래 매물대 hook (see fetchWhaleZones): one read per symbol load; a 404 pauses the reads for 10 minutes.
    async function loadWhaleZones() {
      const sym = state.data?.symbol || state.symbol;
      if (!sym || Date.now() < state.whaleZonesMissingUntil) return;
      const { available, zones } = await fetchWhaleZones(sym);
      if (!available) state.whaleZonesMissingUntil = Date.now() + 10 * 60_000;
      const before = JSON.stringify(state.whaleZonesSymbol === sym ? state.whaleZones : []);
      state.whaleZones = zones;
      state.whaleZonesSymbol = sym;
      if ((state.data?.symbol || state.symbol) === sym && JSON.stringify(zones) !== before) rerenderFirechartOnly();
    }

    async function loadRadar({ force = false } = {}) {
      if (state.radarLoading) return;
      state.radarLoading = true;
      render();
      try {
        const res = await fetch(`/api/orderflow/radar${force ? '?force=1' : ''}`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) state.radar = body;
      } catch {}
      finally {
        state.radarLoading = false;
        render();
      }
    }

    async function loadCvdSr({ force = false } = {}) {
      if (state.cvdSrLoading) return;
      state.cvdSrLoading = true;
      render();
      try {
        const res = await fetch(`/api/orderflow/cvd-sr${force ? '?force=1' : ''}`, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) state.cvdSr = body;
      } catch {}
      finally {
        state.cvdSrLoading = false;
        render();
      }
    }

    host.addEventListener('click', e => {
      const sendBtn = e.target.closest('[data-of-send-real-order]');
      if (sendBtn) {
        const sym = sendBtn.dataset.symbol || state.data?.symbol || state.symbol;
        const limitPrice = Number(sendBtn.dataset.price);
        const wallLabel = sendBtn.dataset.wallLabel || '매물대';
        const side = ['LONG', 'SHORT'].includes(String(sendBtn.dataset.side || '').toUpperCase()) ? String(sendBtn.dataset.side).toUpperCase() : null;
        if (sym && Number.isFinite(limitPrice) && limitPrice > 0) {
          const sideKo = side === 'LONG' ? '롱 추천 · ' : side === 'SHORT' ? '숏 추천 · ' : '';
          const detail = {
            symbol: sym,
            ...(side ? { side } : {}),
            orderType: 'LIMIT',
            limitPrice,
            note: `📌 FireCharts ${wallLabel} ${sideKo}$${fmtPx(limitPrice)} 지정가 자동 입력 완료 (수량 확인 후 주문하세요)`,
          };
          window.__signalLabPendingRealOrder = detail;
          window.location.hash = '#real';
          window.dispatchEvent(new CustomEvent('signal-lab:prefill-real-trade', { detail }));
        }
        return;
      }
      if (e.target.closest('[data-of-inspect-clear]')) {
        state.inspected = null;
        state.inspectLocked = false;
        rerenderFirechartOnly();
        return;
      }
      const srFilter = e.target.closest('[data-of-sr-filter]');
      if (srFilter) {
        state.cvdSrFilter = srFilter.dataset.ofSrFilter || 'all';
        try { localStorage.setItem('sl_of_sr_filter', state.cvdSrFilter); } catch {}
        render();
        return;
      }
      if (e.target.closest('[data-of-sr-refresh]')) {
        void loadCvdSr({ force: true });
        return;
      }
      const spanBtn = e.target.closest('[data-of-price-span]');
      if (spanBtn) {
        state.priceSpan = spanBtn.dataset.ofPriceSpan || 'wide';
        try { localStorage.setItem('sl_of_price_span', state.priceSpan); } catch {}
        rerenderFirechartOnly();
        return;
      }
      const wallPick = e.target.closest('[data-fc-wall-pick]');
      if (wallPick) {
        const hit = wallFromElement(wallPick);
        if (hit) {
          state.inspected = hit;
          state.inspectLocked = true;
          rerenderFirechartOnly();
        }
        return;
      }
      const svg = e.target.closest('[data-fc-svg]');
      if (svg) {
        const hit = inspectFromPointer(e, svg);
        if (hit) {
          state.inspected = hit;
          state.inspectLocked = true;
          rerenderFirechartOnly();
        }
        return;
      }
      const legBtn = e.target.closest('[data-of-cvd-class]');
      if (legBtn) {
        const key = legBtn.dataset.ofCvdClass;
        const set = new Set(state.hiddenClasses);
        if (set.has(key)) set.delete(key); else set.add(key);
        state.hiddenClasses = CVD_KEYS.filter(k => set.has(k));
        try { localStorage.setItem('sl_of_cvd_hidden', JSON.stringify(state.hiddenClasses)); } catch {}
        rerenderFirechartOnly();
        host.querySelector(`[data-of-cvd-class="${key}"]`)?.focus();
        return;
      }
      const chip = e.target.closest('[data-of-symbol]');
      if (chip) {
        state.symbol = chip.dataset.ofSymbol;
        state.whaleZones = [];
        state.inspected = null;
        state.inspectLocked = false;
        void load();
        return;
      }
      const rBtn = e.target.closest('[data-of-range]');
      if (rBtn) {
        state.range = rBtn.dataset.ofRange;
        state.inspected = null;
        state.inspectLocked = false;
        void load();
        return;
      }
      const modeBtn = e.target.closest('[data-of-cvd-mode]');
      if (modeBtn) {
        state.cvdMode = modeBtn.dataset.ofCvdMode === 'absolute' ? 'absolute' : 'normalized';
        try { localStorage.setItem('sl_of_cvd_mode', state.cvdMode); } catch {}
        rerenderFirechartOnly();
        host.querySelector(`[data-of-cvd-mode="${state.cvdMode}"]`)?.focus();
        return;
      }
      if (e.target.closest('[data-of-radar-refresh]')) {
        void loadRadar({ force: true });
        return;
      }
      if (e.target.closest('[data-of-refresh]')) {
        void load({ force: true });
      }
    });

    host.addEventListener('pointermove', e => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (state.inspectLocked) return;
      const svg = e.target.closest?.('[data-fc-svg]');
      if (!svg) return;
      const hit = inspectFromPointer(e, svg);
      if (!hit && !state.inspected) return;
      if (hit && state.inspected && hit.price === state.inspected.price && hit.snapped === state.inspected.snapped) return;
      state.inspected = hit;
      rerenderFirechartOnly();
    });

    host.addEventListener('pointerleave', () => {
      if (!state.inspectLocked && state.inspected) {
        state.inspected = null;
        rerenderFirechartOnly();
      }
    });

    host.addEventListener('input', e => {
      const isMin = e.target.matches('[data-of-pct-min]');
      if (!isMin && !e.target.matches('[data-of-pct-max]')) return;
      const next = clampPercentiles(isMin ? e.target.value : state.minPct, isMin ? state.maxPct : e.target.value, isMin ? 'min' : 'max');
      state.minPct = next.minPct;
      state.maxPct = next.maxPct;
      // The moved thumb stops at the other one (low <= high)
      e.target.value = String(isMin ? state.minPct : state.maxPct);
      try {
        localStorage.setItem('sl_of_min_pct', String(state.minPct));
        localStorage.setItem('sl_of_max_pct', String(state.maxPct));
      } catch {}
      rerenderFirechartOnly();
    });

    host.addEventListener('submit', e => {
      const form = e.target.closest('[data-of-form]');
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector('input[name="symbol"]');
      const raw = String(input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!raw) return;
      state.symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
      state.inspected = null;
      state.inspectLocked = false;
      void load({ force: true });
    });

    const maybeLoadOnRoute = () => {
      if (!isVisible()) return;
      if (!state.data || Date.now() - (state.data.at || 0) > 25_000) void load();
      if (!state.cvdSr || Date.now() - (state.cvdSr.at || 0) > 85_000) void loadCvdSr();
      if (!state.radar || Date.now() - (state.radar.at || 0) > 55_000) void loadRadar();
    };
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-open-orderflow]');
      if (!btn) return;
      const raw = String(btn.dataset.openOrderflow || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!raw) return;
      state.symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
      state.inspected = null;
      state.inspectLocked = false;
      try { localStorage.setItem('sl_of_symbol', state.symbol); } catch {}
      window.location.hash = '#orderflow';
      void load({ force: true });
    });
    window.addEventListener('hashchange', () => setTimeout(maybeLoadOnRoute, 10));
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!isVisible() || !state.data) return;
        const w = measureWidth();
        if (Math.abs(w - state.fcWidth) > 4) { state.fcWidth = w; rerenderFirechartOnly(); }
      }, 150);
    });
    setInterval(() => {
      if (!isVisible()) return;
      void load();
      if (!state.cvdSr || Date.now() - (state.cvdSr.at || 0) > 85_000) void loadCvdSr();
      if (!state.radar || Date.now() - (state.radar.at || 0) > 55_000) void loadRadar();
    }, 30_000);
    render();
    setTimeout(maybeLoadOnRoute, 50);
  }
}
