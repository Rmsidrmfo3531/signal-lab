// Dedicated "수급 · 청산" (#orderflow) workspace screen.
// Features Material Indicators FireCharts-style Liquidity Wall Heatmap + 4-Cohort (Whale/Large/Mid/Retail)
// Normalized/Absolute CVD, plus Live 20-Coin Anomaly Radar, OI/Funding/L-S KPIs, and Estimated Liquidation Map.
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

const COHORT_META = Object.freeze([
  { key: 'retail', name: '개미', color: '#f59e0b', stepped: false },
  { key: 'mid', name: '중형', color: '#38bdf8', stepped: false },
  { key: 'large', name: '대형', color: '#22c55e', stepped: false },
  { key: 'whale', name: '고래', color: '#ef4444', stepped: true },
]);

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

/**
 * Pure SVG Material Indicators FireCharts-style Dual Pane:
 * - Upper Pane: Pitch-black canvas with Fire Colorbar + Orderbook/Liquidity Wall Heatmap + Price Line
 * - Lower Pane: 4-Cohort Multi-Line CVD (Normalized 0..1 OR Absolute USD) with Stepped Red Whale Line
 */
export function firechartSvg(data, { cvdMode = 'normalized', minPct = 93, maxPct = 99 } = {}) {
  const fc = data?.firechart;
  const candles = data?.series || [];
  const cohortPts = fc?.cohorts?.series || [];
  const hm = fc?.heatmap;
  if (!fc || candles.length < 3 || cohortPts.length < 3) {
    return '<div class="empty-small" style="padding:36px">FireCharts 유동성 히트맵과 코호트 CVD를 계산하는 중입니다…</div>';
  }

  const W = 920, H = 470;
  const PL = 86, PR = 78, PW = W - PL - PR;
  const topY = 16, topH = 212;
  const botY = 250, botH = 186;
  const loPct = Math.min(minPct, maxPct);
  const hiPct = Math.max(minPct, maxPct);

  // Upper Pane: Price scale & Liquidity Heatmap
  const minP = hm?.minPrice || Math.min(...candles.map(c => c.l || c.c));
  const maxP = hm?.maxPrice || Math.max(...candles.map(c => c.h || c.c));
  const pSpan = maxP - minP || maxP * 0.01 || 1;
  const py = v => topY + topH - ((v - minP) / pSpan) * topH;
  const pxOf = (i, len) => PL + (len > 1 ? (i / (len - 1)) * PW : PW / 2);

  const visibleCells = (hm?.cells || []).filter(c => c.pctRank >= loPct && c.pctRank <= hiPct + 0.99);
  const maxVisUsd = Math.max(1, ...visibleCells.map(c => c.usd));
  const minVisUsd = visibleCells.length ? Math.min(...visibleCells.map(c => c.usd)) : 0;
  const cellH = Math.max(2.6, topH / (hm?.priceBins || 44));

  const heatmapRects = visibleCells.map(c => {
    const x = PL + c.x0 * PW;
    const w = Math.max(4, (c.x1 - c.x0) * PW);
    const y = topY + topH - ((c.yBin + 1) / (hm?.priceBins || 44)) * topH;
    const intensity = maxVisUsd > minVisUsd ? (c.usd - minVisUsd) / (maxVisUsd - minVisUsd) : 0.7;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${fireColor(intensity)}" rx="1"/>`;
  }).join('');

  // Price line overlaid on heatmap
  const pricePts = candles.map((c, i) => `${pxOf(i, candles.length).toFixed(1)},${py(c.c).toFixed(1)}`).join(' ');
  const lastPx = candles.at(-1).c;

  // Upper grid & price ticks
  const pTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const val = minP + f * pSpan;
    const y = py(val);
    return `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#162130" stroke-width="1"/>
      <text x="${W - PR + 7}" y="${(y + 3.5).toFixed(1)}" fill="#8ba3bc" font-size="10">${esc(fmtPx(val))}</text>`;
  }).join('');

  // Left Fire Colorbar ticks
  const cbMax = hm?.maxUsd || maxVisUsd;
  const cbMin = hm?.p80Usd || minVisUsd;
  const cbTicks = [1, 0.75, 0.5, 0.25, 0].map(f => {
    const v = cbMin + f * Math.max(0, cbMax - cbMin);
    const y = topY + (1 - f) * topH;
    return `<text x="52" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#90a7bf" font-size="9.5">${esc(fmtUsdCompact(v))}</text>`;
  }).join('');

  // Lower Pane: 4-Cohort Multi-Line CVD
  const isNorm = cvdMode !== 'absolute';
  let cMin = 0, cMax = 1;
  if (!isNorm) {
    cMin = Infinity; cMax = -Infinity;
    for (const pt of cohortPts) {
      for (const m of COHORT_META) {
        const v = Number(pt.abs?.[m.key] ?? 0);
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
      }
    }
    if (!Number.isFinite(cMin) || !Number.isFinite(cMax) || cMax <= cMin) { cMin = -1; cMax = 1; }
  }
  const cSpan = cMax - cMin || 1;
  const cy = v => botY + botH - ((v - cMin) / cSpan) * botH;

  const cohortPaths = COHORT_META.map(m => {
    const coords = cohortPts.map((pt, i) => {
      const val = isNorm ? Number(pt.norm?.[m.key] ?? 0.5) : Number(pt.abs?.[m.key] ?? 0);
      return [pxOf(i, cohortPts.length), cy(val)];
    });
    if (m.stepped) {
      return `<path d="${buildSteppedPath(coords)}" fill="none" stroke="${m.color}" stroke-width="2" stroke-linejoin="miter" opacity="0.95"/>`;
    }
    const ptsStr = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return `<polyline fill="none" stroke="${m.color}" stroke-width="1.8" points="${ptsStr}" opacity="0.92"/>`;
  }).join('');

  const cTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const val = cMin + f * cSpan;
    const y = cy(val);
    const lbl = isNorm ? val.toFixed(2) : fmtUsdCompact(val, true);
    return `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="#162130" stroke-width="1"/>
      <text x="${W - PR + 7}" y="${(y + 3.5).toFixed(1)}" fill="#8ba3bc" font-size="10">${esc(lbl)}</text>`;
  }).join('');

  const zeroLine = !isNorm && cMin < 0 && cMax > 0
    ? `<line x1="${PL}" y1="${cy(0).toFixed(1)}" x2="${W - PR}" y2="${cy(0).toFixed(1)}" stroke="#395573" stroke-dasharray="4 3"/>`
    : '';

  // Time labels along bottom axis (use cohort timestamps)
  const withDate = fc.range !== 'LIVE';
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const idx = Math.min(cohortPts.length - 1, Math.round(f * (cohortPts.length - 1)));
    const x = pxOf(idx, cohortPts.length);
    return `<line x1="${x.toFixed(1)}" y1="${topY}" x2="${x.toFixed(1)}" y2="${topY + topH}" stroke="#121c29" stroke-width="1"/>
      <line x1="${x.toFixed(1)}" y1="${botY}" x2="${x.toFixed(1)}" y2="${botY + botH}" stroke="#121c29" stroke-width="1"/>
      <text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#7c96b0" font-size="9.5">${esc(fmtKst(cohortPts[idx].t, withDate))}</text>`;
  }).join('');

  return `<svg class="of-fc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="FireCharts 호가 유동성 히트맵 및 금액대별 코호트 CVD">
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
    <!-- Upper Heatmap Canvas -->
    <rect x="${PL}" y="${topY}" width="${PW}" height="${topH}" fill="#05070c" stroke="#1d2c3e" stroke-width="1"/>
    <!-- Left Fire Colorbar -->
    <rect x="58" y="${topY}" width="14" height="${topH}" fill="url(#fcFireScale)" stroke="#23364b" stroke-width="1" rx="2"/>
    ${cbTicks}
    <text x="12" y="${topY + topH / 2}" transform="rotate(-90 12 ${topY + topH / 2})" text-anchor="middle" fill="#7892ac" font-size="9.5">Volume (USDT)</text>
    <!-- Grid & Heatmap Cells -->
    ${timeTicks}
    ${pTicks}
    ${heatmapRects}
    <!-- Price Line Overlay -->
    <polyline fill="none" stroke="#45b3ff" stroke-width="2" points="${pricePts}"/>
    <circle cx="${pxOf(candles.length - 1, candles.length).toFixed(1)}" cy="${py(lastPx).toFixed(1)}" r="3.4" fill="#9fe3ff"/>
    <rect x="${W - PR + 3}" y="${(py(lastPx) - 8).toFixed(1)}" width="72" height="16" rx="3" fill="#184775" stroke="#45b3ff" stroke-width="0.8"/>
    <text x="${W - PR + 7}" y="${(py(lastPx) + 3.5).toFixed(1)}" fill="#fff" font-size="10" font-weight="700">${esc(fmtPx(lastPx))}</text>
    <!-- Lower Cohort CVD Canvas -->
    <rect x="${PL}" y="${botY}" width="${PW}" height="${botH}" fill="#070b12" stroke="#1d2c3e" stroke-width="1"/>
    ${cTicks}
    ${zeroLine}
    ${cohortPaths}
    <text x="${W - 10}" y="${botY + botH / 2}" transform="rotate(90 ${W - 10} ${botY + botH / 2})" text-anchor="middle" fill="#7892ac" font-size="9.5">${isNorm ? 'Normalized CVD (0~1)' : 'Absolute CVD (USD)'}</text>
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

/**
 * Full "수급 · 청산" screen HTML renderer (pure, unit-testable).
 */
export function orderflowHTML(data, {
  symbol = 'BTCUSDT',
  range = 'LIVE',
  cvdMode = 'normalized',
  minPct = 93,
  maxPct = 99,
  loading = false,
  error = '',
  radar = null,
  radarLoading = false,
} = {}) {
  const activeSym = data?.symbol || symbol;
  const activeRange = data?.range || range || 'LIVE';
  const quick = data?.quickSymbols?.length ? data.quickSymbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'AVAXUSDT', 'LINKUSDT', 'ADAUSDT', '1000PEPEUSDT'];
  const openSet = new Set(data?.openSymbols || []);

  const chips = quick.slice(0, 18).map(s => {
    const short = s.replace(/USDT$/, '');
    const active = s === activeSym ? ' active' : '';
    const held = openSet.has(s) ? '<i class="of-held-dot" title="현재 보유 중"></i>' : '';
    return `<button type="button" class="of-chip${active}" data-of-symbol="${esc(s)}">${held}${esc(short)}</button>`;
  }).join('');

  const rangeBtns = [['LIVE', '실시간 (체결)'], ['1D', '1D'], ['1W', '1W'], ['1M', '1M']].map(([k, lbl]) =>
    `<button type="button" class="outline-btn small${activeRange === k ? ' active-btn' : ''}" data-of-range="${k}">${lbl}</button>`
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
  <div class="of-chips" aria-label="빠른 종목 선택">${chips}</div>`;

  const radarBox = orderflowRadarHTML(radar, activeSym, radarLoading);

  if (error && !data) {
    return `${controls}${radarBox}<div class="venues-status warn" style="margin:14px 18px">수급 데이터 조회 실패: ${esc(error)}</div>`;
  }
  if (!data) {
    return `${controls}${radarBox}<div class="empty-small" style="padding:36px">종목 수급·청산 데이터를 불러오는 중입니다…</div>`;
  }

  const px = data.price || {}, cvd = data.cvd || {}, oi = data.oi || {}, ratios = data.ratios || {}, fund = data.funding || {}, liq = data.liquidations || {}, sig = data.scalpSignal || {};
  const fc = data.firechart || null;
  const thLabels = fc?.cohorts?.thresholds?.labels || { retail: '<$1K', mid: '$1K~$10K', large: '$10K~$100K', whale: '$100K+' };
  const latestAbs = fc?.cohorts?.latest?.abs || {};

  const cohortLegend = COHORT_META.map(m => {
    const val = latestAbs[m.key];
    return `<span class="of-fc-leg"><i style="background:${m.color}"></i><b>${m.name}</b> <small>(${esc(thLabels[m.key] || '')})</small> <em class="${(val ?? 0) >= 0 ? 'paper-profit' : 'paper-loss'}">${esc(fmtUsdCompact(val ?? 0, true))}</em></span>`;
  }).join('');

  const modeNote = fc?.cohortMode === 'REAL_TRADES'
    ? `실제 개별 체결 ${esc(fc.cohorts?.tradeCount ?? 0)}건 분리 · 실시간 호가벽 ${esc(fc.heatmap?.liveWalls?.length ?? 0)}개${fc.heatmap?.snapshotCount > 0 ? ` · 누적 스냅샷 ${esc(fc.heatmap.snapshotCount)}회` : ''}`
    : `거래량 유동성 선반 + 우측 실시간 호가벽(${esc(SOURCE_LABELS[fc?.bookSource] || fc?.bookSource || '')}) · 캔들 규모 기반 고래/개미 추정 코호트`;

  const firechartCard = `<section class="of-fc-card" aria-label="FireCharts 호가 히트맵 및 코호트 CVD">
    <div class="of-fc-bar">
      <div class="of-fc-pct-ctrl">
        <label>Volume Percentiles: <b data-of-pct-label>${esc(Math.min(minPct, maxPct))} .. ${esc(Math.max(minPct, maxPct))}</b></label>
        <div class="of-fc-sliders">
          <input type="range" min="50" max="98" step="1" value="${esc(minPct)}" data-of-pct-min aria-label="최소 유동성 백분위">
          <input type="range" min="60" max="99" step="1" value="${esc(maxPct)}" data-of-pct-max aria-label="최대 유동성 백분위">
        </div>
      </div>
      <div class="of-fc-mode-toggle" role="group" aria-label="CVD 표시 모드">
        <button type="button" class="of-fc-tab${cvdMode !== 'absolute' ? ' active' : ''}" data-of-cvd-mode="normalized">Normalized CVD</button>
        <button type="button" class="of-fc-tab${cvdMode === 'absolute' ? ' active' : ''}" data-of-cvd-mode="absolute">Absolute CVD</button>
      </div>
    </div>
    <div class="of-fc-legend-row">
      <div class="of-fc-legends">${cohortLegend}</div>
      <small class="of-fc-mode-note">${modeNote}</small>
    </div>
    <div class="of-fc-canvas" data-of-fc-canvas>${firechartSvg(data, { cvdMode, minPct, maxPct })}</div>
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

  return `${controls}${error ? `<div class="venues-status warn" style="margin:8px 18px">${esc(error)}</div>` : ''}${firechartCard}${verdictBanner}${kpis}${mainGrid}${radarBox}`;
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
      minPct: Number(readLS('sl_of_min_pct', '93')) || 93,
      maxPct: Number(readLS('sl_of_max_pct', '99')) || 99,
      data: null,
      loading: false,
      error: '',
      radar: null,
      radarLoading: false,
    };

    const render = () => { host.innerHTML = orderflowHTML(state.data, state); };
    const rerenderFirechartOnly = () => {
      const box = host.querySelector('[data-of-fc-canvas]');
      const lbl = host.querySelector('[data-of-pct-label]');
      if (lbl) lbl.textContent = `${Math.min(state.minPct, state.maxPct)} .. ${Math.max(state.minPct, state.maxPct)}`;
      if (box && state.data) box.innerHTML = firechartSvg(state.data, state);
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

    host.addEventListener('click', e => {
      const chip = e.target.closest('[data-of-symbol]');
      if (chip) {
        state.symbol = chip.dataset.ofSymbol;
        void load();
        return;
      }
      const rBtn = e.target.closest('[data-of-range]');
      if (rBtn) {
        state.range = rBtn.dataset.ofRange;
        void load();
        return;
      }
      const modeBtn = e.target.closest('[data-of-cvd-mode]');
      if (modeBtn) {
        state.cvdMode = modeBtn.dataset.ofCvdMode;
        try { localStorage.setItem('sl_of_cvd_mode', state.cvdMode); } catch {}
        render();
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

    host.addEventListener('input', e => {
      if (e.target.matches('[data-of-pct-min]')) {
        state.minPct = Number(e.target.value) || 80;
        try { localStorage.setItem('sl_of_min_pct', String(state.minPct)); } catch {}
        rerenderFirechartOnly();
      } else if (e.target.matches('[data-of-pct-max]')) {
        state.maxPct = Number(e.target.value) || 99;
        try { localStorage.setItem('sl_of_max_pct', String(state.maxPct)); } catch {}
        rerenderFirechartOnly();
      }
    });

    host.addEventListener('submit', e => {
      const form = e.target.closest('[data-of-form]');
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector('input[name="symbol"]');
      const raw = String(input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!raw) return;
      state.symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
      void load({ force: true });
    });

    const maybeLoadOnRoute = () => {
      if (!isVisible()) return;
      if (!state.data || Date.now() - (state.data.at || 0) > 25_000) void load();
      if (!state.radar || Date.now() - (state.radar.at || 0) > 55_000) void loadRadar();
    };
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-open-orderflow]');
      if (!btn) return;
      const raw = String(btn.dataset.openOrderflow || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!raw) return;
      state.symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
      try { localStorage.setItem('sl_of_symbol', state.symbol); } catch {}
      window.location.hash = '#orderflow';
      void load({ force: true });
    });
    window.addEventListener('hashchange', () => setTimeout(maybeLoadOnRoute, 10));
    setInterval(() => {
      if (!isVisible()) return;
      void load();
      if (!state.radar || Date.now() - (state.radar.at || 0) > 55_000) void loadRadar();
    }, 30_000);
    render();
    setTimeout(maybeLoadOnRoute, 50);
  }
}
