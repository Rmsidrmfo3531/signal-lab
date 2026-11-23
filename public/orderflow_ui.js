// Dedicated "수급 · 청산" (#orderflow) workspace screen.
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

function fmtKst(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
 * Pure SVG 3-pane chart: Price + CVD/Delta Histogram + OI Curve.
 */
export function orderflowPriceCvdSvg(series = [], divergence = null) {
  if (!Array.isArray(series) || series.length < 3) {
    return '<div class="empty-small" style="padding:28px">차트 데이터를 불러오는 중입니다.</div>';
  }
  const W = 760, H = 330, PL = 10, PR = 68, PW = W - PL - PR;
  const n = series.length;
  const xOf = i => PL + (n > 1 ? (i / (n - 1)) * PW : PW / 2);

  // Pane 1: Price (y: 16..118)
  const pTop = 16, pH = 102;
  const prices = series.map(b => b.c);
  const pMin = Math.min(...series.map(b => b.l || b.c));
  const pMax = Math.max(...series.map(b => b.h || b.c));
  const pSpan = pMax - pMin || pMax * 0.01 || 1;
  const py = v => pTop + pH - ((v - pMin) / pSpan) * pH;
  const pricePts = series.map((b, i) => `${xOf(i).toFixed(1)},${py(b.c).toFixed(1)}`).join(' ');
  const priceArea = `${xOf(0).toFixed(1)},${(pTop + pH).toFixed(1)} ${pricePts} ${xOf(n - 1).toFixed(1)},${(pTop + pH).toFixed(1)}`;
  const lastPrice = prices.at(-1);

  // Pane 2: CVD + Bar Delta (y: 136..226)
  const cTop = 136, cH = 90;
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

  // Pane 3: OI Curve (y: 244..310)
  const oTop = 244, oH = 66;
  const oiPoints = series.map((b, i) => ({ i, v: b.oiUsd })).filter(x => x.v != null && x.v > 0);
  let oiSvg = `<text x="${PL + 8}" y="${oTop + 36}" fill="#7f9bb3" font-size="11">OI 시계열 데이터 미제공 구간</text>`;
  let oiMaxLabel = '', oiMinLabel = '';
  if (oiPoints.length >= 2) {
    const oMin = Math.min(...oiPoints.map(x => x.v));
    const oMax = Math.max(...oiPoints.map(x => x.v));
    const oSpan = oMax - oMin || oMax * 0.005 || 1;
    const oy = v => oTop + oH - ((v - oMin) / oSpan) * oH;
    const oiPts = oiPoints.map(x => `${xOf(x.i).toFixed(1)},${oy(x.v).toFixed(1)}`).join(' ');
    const oiColor = oiPoints.at(-1).v < oiPoints[0].v ? '#ffb86c' : '#7dd3fc';
    oiSvg = `<polyline fill="none" stroke="${oiColor}" stroke-width="1.8" points="${oiPts}"/>`;
    oiMaxLabel = fmtUsdCompact(oMax);
    oiMinLabel = fmtUsdCompact(oMin);
  }

  const divBadge = divergence && divergence.type && divergence.type !== 'NONE'
    ? `<text x="${PL + 64}" y="12" fill="${divergence.type.startsWith('BULL') ? '#52e0ae' : '#ff8a94'}" font-size="10.5" font-weight="700">● ${esc(divergence.labelKo)}</text>`
    : '';

  return `<svg class="of-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="가격, CVD, 미결제약정 복합 차트">
    <defs>
      <linearGradient id="ofPriceFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#60c8f5" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#60c8f5" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    <!-- Pane separators -->
    <line x1="${PL}" y1="126" x2="${W - PR}" y2="126" stroke="#22384e" stroke-dasharray="3 3"/>
    <line x1="${PL}" y1="234" x2="${W - PR}" y2="234" stroke="#22384e" stroke-dasharray="3 3"/>
    <!-- Pane 1: Price -->
    <text x="${PL + 4}" y="12" fill="#89a7c2" font-size="10.5" font-weight="700">가격 추이</text>
    ${divBadge}
    <polygon points="${priceArea}" fill="url(#ofPriceFill)"/>
    <polyline fill="none" stroke="#60c8f5" stroke-width="2" points="${pricePts}"/>
    <circle cx="${xOf(n - 1).toFixed(1)}" cy="${py(lastPrice).toFixed(1)}" r="3.2" fill="#9ee5ff"/>
    <text x="${W - PR + 6}" y="${pTop + 9}" fill="#7f9bb3" font-size="10">${esc(fmtPx(pMax))}</text>
    <text x="${W - PR + 6}" y="${py(lastPrice).toFixed(1)}" fill="#e6f5ff" font-size="10.5" font-weight="700">${esc(fmtPx(lastPrice))}</text>
    <text x="${W - PR + 6}" y="${pTop + pH}" fill="#7f9bb3" font-size="10">${esc(fmtPx(pMin))}</text>
    <!-- Pane 2: CVD -->
    <text x="${PL + 4}" y="${cTop + 2}" fill="#89a7c2" font-size="10.5" font-weight="700">CVD (누적 거래량 델타 · 막대=봉별 순매수/매도)</text>
    <line x1="${PL}" y1="${cvdZeroY.toFixed(1)}" x2="${W - PR}" y2="${cvdZeroY.toFixed(1)}" stroke="#2e4a63" stroke-width="1"/>
    ${deltaBars}
    <polyline fill="none" stroke="${cvdColor}" stroke-width="2" points="${cvdPts}"/>
    <text x="${W - PR + 6}" y="${cTop + 12}" fill="#7f9bb3" font-size="9.5">${esc(fmtUsdCompact(cMax, true))}</text>
    <text x="${W - PR + 6}" y="${cy(cvds.at(-1)).toFixed(1)}" fill="${cvdColor}" font-size="10" font-weight="700">${esc(fmtUsdCompact(cvds.at(-1), true))}</text>
    <text x="${W - PR + 6}" y="${cTop + cH}" fill="#7f9bb3" font-size="9.5">${esc(fmtUsdCompact(cMin, true))}</text>
    <!-- Pane 3: OI -->
    <text x="${PL + 4}" y="${oTop + 2}" fill="#89a7c2" font-size="10.5" font-weight="700">미결제약정 (OI · USD)</text>
    ${oiSvg}
    ${oiMaxLabel ? `<text x="${W - PR + 6}" y="${oTop + 12}" fill="#7f9bb3" font-size="9.5">${esc(oiMaxLabel)}</text>` : ''}
    ${oiMinLabel ? `<text x="${W - PR + 6}" y="${oTop + oH}" fill="#7f9bb3" font-size="9.5">${esc(oiMinLabel)}</text>` : ''}
    <!-- Time labels -->
    <text x="${PL + 4}" y="${H - 4}" fill="#6e8ca6" font-size="9.5">${esc(fmtKst(series[0].t))} KST</text>
    <text x="${(PL + PW / 2 - 22).toFixed(1)}" y="${H - 4}" fill="#6e8ca6" font-size="9.5">${esc(fmtKst(series[Math.floor(n / 2)].t))} KST</text>
    <text x="${(W - PR - 56).toFixed(1)}" y="${H - 4}" fill="#6e8ca6" font-size="9.5">${esc(fmtKst(series.at(-1).t))} KST</text>
  </svg>`;
}

/**
 * Render Estimated Liquidation Cluster Heatmap above & below mark price.
 */
export function orderflowLiqMapHTML(liqMap) {
  if (!liqMap || (!liqMap.above?.length && !liqMap.below?.length)) {
    return '<div class="empty-small" style="padding:20px">추정 청산맵을 계산할 데이터가 부족합니다.</div>';
  }
  const aboveDesc = [...(liqMap.above || [])].reverse(); // Highest price on top -> closest to mark
  const belowDesc = [...(liqMap.below || [])]; // Closest to mark -> lowest price on bottom

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
    <p class="of-liq-note">※ 무료 공개 OHLCV·거래량·OI·롱/숏 비율로 미청산 100x/50x/25x/10x/5x 구간을 산출한 <b>추정 청산맵</b>입니다 (거래소 비공개 내부 호가창 아님).</p>
  </div>`;
}

/**
 * Render clickable "실시간 수급 이상치 레이더" strip (Top OI flush / CVD strong flip / divergence / funding).
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
export function orderflowHTML(data, { symbol = 'BTCUSDT', interval = '5m', loading = false, error = '', radar = null, radarLoading = false } = {}) {
  const activeSym = data?.symbol || symbol;
  const activeIv = data?.interval || interval;
  const quick = data?.quickSymbols?.length ? data.quickSymbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'AVAXUSDT', 'LINKUSDT', 'ADAUSDT', '1000PEPEUSDT'];
  const openSet = new Set(data?.openSymbols || []);

  const chips = quick.slice(0, 18).map(s => {
    const short = s.replace(/USDT$/, '');
    const active = s === activeSym ? ' active' : '';
    const held = openSet.has(s) ? '<i class="of-held-dot" title="현재 보유 중"></i>' : '';
    return `<button type="button" class="of-chip${active}" data-of-symbol="${esc(s)}">${held}${esc(short)}</button>`;
  }).join('');

  const ivBtns = [['5m', '5분봉 (단타)'], ['15m', '15분봉'], ['1h', '1시간봉']].map(([k, lbl]) =>
    `<button type="button" class="outline-btn small${activeIv === k ? ' active-btn' : ''}" data-of-interval="${k}">${lbl}</button>`
  ).join('');

  const srcBadge = data?.source ? `<span class="of-src-badge">${esc(SOURCE_LABELS[data.source] || data.source)}</span>` : '';
  const updated = data?.at ? `<small class="muted">갱신 ${esc(fmtKst(data.at))} KST</small>` : '';

  const controls = `<div class="of-controls">
    <form class="of-search-form" data-of-form>
      <input type="text" name="symbol" value="${esc(activeSym)}" placeholder="종목 입력 (예: BTC, SOL, XRP)" aria-label="수급 조회 종목">
      <button type="submit" class="outline-btn small">조회</button>
    </form>
    <div class="of-iv-group">${ivBtns}</div>
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
      <div class="of-kpi-label">현재 마크가 <small>${esc(activeIv)} 구간 ${esc(fmtPct(px.windowChangePct))}</small></div>
      <div class="of-kpi-val">${esc(fmtPx(px.mark))}</div>
      <div class="of-kpi-sub">인덱스 ${esc(fmtPx(px.index))} · 베이시스 ${esc(fmtPct(px.basisPct, 3))}</div>
    </div>
    <div class="of-kpi">
      <div class="of-kpi-label">실시간 CVD & 다이버전스 <span class="of-tag ${divCls}">${esc(cvd.divergence?.labelKo || '중립')}</span></div>
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
      <div class="of-card-head"><h4>가격 · CVD 곡선 · OI 추이</h4><small>${esc(cvd.divergence?.detailKo || '')}</small></div>
      <div class="of-chart-box">${orderflowPriceCvdSvg(data.series, cvd.divergence)}</div>
    </div>
    <div class="of-card">
      <div class="of-card-head"><h4>추정 청산맵 (상·하단 레버리지 밀집 구간)</h4><small>100x · 50x · 25x · 10x · 5x 클러스터</small></div>
      ${orderflowLiqMapHTML(data.liquidationMap)}
    </div>
  </div>`;

  return `${controls}${radarBox}${error ? `<div class="venues-status warn" style="margin:8px 18px">${esc(error)}</div>` : ''}${verdictBanner}${kpis}${mainGrid}`;
}

// Browser controller (lazy-loaded when #orderflow tab is shown; auto-refreshes every 30s while open)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const host = document.getElementById('orderflowRoot');
  if (host) {
    const savedSym = (() => { try { return localStorage.getItem('sl_of_symbol') || 'BTCUSDT'; } catch { return 'BTCUSDT'; } })();
    const savedIv = (() => { try { return localStorage.getItem('sl_of_interval') || '5m'; } catch { return '5m'; } })();
    const state = { symbol: savedSym, interval: savedIv, data: null, loading: false, error: '', radar: null, radarLoading: false };

    const render = () => { host.innerHTML = orderflowHTML(state.data, state); };
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
        const q = `/api/orderflow?symbol=${encodeURIComponent(state.symbol)}&interval=${encodeURIComponent(state.interval)}${force ? '&force=1' : ''}`;
        const res = await fetch(q, { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
        state.data = body;
        state.symbol = body.symbol || state.symbol;
        try {
          localStorage.setItem('sl_of_symbol', state.symbol);
          localStorage.setItem('sl_of_interval', state.interval);
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
      const ivBtn = e.target.closest('[data-of-interval]');
      if (ivBtn) {
        state.interval = ivBtn.dataset.ofInterval;
        void load();
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
