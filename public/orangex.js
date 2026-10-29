// Display-only client. Offline PAPER has no browser trading or activation API.
import {renderOrangeXPaper,renderOrangeXPaperReplay} from './orangex_paper.js';
import {renderOrangeXOperational} from './orangex_operational.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric=value=>(typeof value==='number'||typeof value==='string')&&!(typeof value==='string'&&!value.trim())&&Number.isFinite(Number(value))?Number(value):null;
const number=value=>{const n=numeric(value);return n===null?'—':n.toLocaleString('en-US',{maximumFractionDigits:8})};
const money=value=>{const n=numeric(value);return n===null?'—':`${n<0?'-':''}$${Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}`};
const time=value=>{const n=numeric(value);return n!==null&&n>0&&Number.isFinite(new Date(n).getTime())?new Date(n).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'미확인'};
const records=value=>Array.isArray(value)?value:[];
const first=(value,...keys)=>{for(const key of keys)if(value?.[key]!==undefined&&value[key]!==null)return value[key];return undefined};
const cell=value=>`<td>${esc(value)}</td>`;
const empty=(span,message)=>`<tr><td colspan="${span}" class="orangex-empty">${esc(message)}</td></tr>`;
const statusLabels={DISABLED:'연결 비활성',UNCONFIGURED:'미설정',NOT_CONFIGURED:'미설정',CONNECTED:'연결 확인',READY:'조회 가능',
 UNTESTED:'미검증',BLOCKED:'연결 차단',ERROR:'조회 오류',FAILED:'조회 실패',UNAVAILABLE:'조회 불가',AUTH_REQUIRED:'인증 미설정',
 NOT_AUTHENTICATED:'인증 미설정',NOT_SUPPORTED:'지원 미확인',UNSUPPORTED:'지원 미확인',PENDING:'확인 중',OFFLINE:'연결 안 됨',STALE:'이전 자료 · 재조회 필요'};
const errorLabels={DISABLED:'OrangeX 조회 연결이 꺼져 있습니다.',ORANGEX_DISABLED:'OrangeX 조회 연결이 꺼져 있습니다.',
 NOT_CONFIGURED:'서버의 OrangeX 연결 설정이 필요합니다.',AUTH_REQUIRED:'계좌 조회 인증이 설정되지 않았습니다.',
 AUTH_FAILED:'계좌 조회 인증에 실패했습니다.',AUTH_ERROR:'계좌 조회 인증에 실패했습니다.',
 SPEC_UNVERIFIED:'공식 API 명세 검증이 완료되지 않았습니다.',UNVERIFIED_SPEC:'공식 API 명세 검증이 완료되지 않았습니다.',
 NETWORK_BLOCKED:'현재 환경에서 OrangeX 연결이 차단되었습니다.',NETWORK_ERROR:'거래소 네트워크 연결을 확인하세요.',
 TIMEOUT:'조회 제한시간을 초과했습니다.',HTTP_ERROR:'거래소 또는 서버 조회에 실패했습니다.',
 RATE_LIMITED:'조회 요청 한도로 인해 대기 중입니다.',SCHEMA_INVALID:'응답 형식이 확인된 명세와 다릅니다.',
 UNSUPPORTED:'아직 검증되지 않은 조회 기능입니다.',READ_ONLY:'현재 단계에서는 주문을 지원하지 않습니다.'};
const status=value=>statusLabels[String(value||'').toUpperCase()]||'미검증';
const errorCode=value=>/^[A-Z][A-Z0-9_-]{0,47}$/.test(String(value||''))?String(value):'UNKNOWN';
const signClass=value=>numeric(value)===null?'':Number(value)<0?'negative':Number(value)>0?'positive':'';
const direction=value=>value==='LONG'||value==='BUY'?'LONG':value==='SHORT'||value==='SELL'?'SHORT':'미확인';
const targetPrices=value=>records(value).slice(0,3).map((item,index)=>`${index+1}차 ${number(typeof item==='object'?item?.price:item)}`).join(' · ')||'미확인';
const unit=value=>numeric(value)===null?'미검증':number(value);
const marketState=item=>item?.instrumentVerified===false?'미검증 · 주문 차단':item?.tradable===true?'거래 가능':item?.tradable===false?'거래 불가':'미검증 · 주문 차단';
const quoteAge=item=>{
 const at=numeric(item?.priceAt),now=Date.now();
 if(item?.fresh===false||at===null||at<=0||at>now+5000||now-at>90000)return '시세 만료/미확인';
 return item?.fresh===true?'시세 시각 확인':'신선도 미검증';
};
const markAge=(item,now=Date.now())=>{
 const at=numeric(item?.markPriceAt);
 if(numeric(item?.markPrice)===null)return 'Mark 미확인';
 return item?.markPriceFresh===false||at===null||at<=0||at>now+5000||now-at>90000?'Mark 시각 만료/미확인':'Mark 시각 확인';
};
const observedNumber=value=>numeric(value)===null?'미관측':String(value).trim();
const sourceLabel=value=>({REAL_PUBLIC_READ_ONLY:'공개 조회 응답 · 독립 출처 미검증',WINDOWS_DIAGNOSTIC_REPLAY:'Windows 진단 재생 · 현재 실시간 응답 아님',
 SYNTHETIC_FIXTURE:'합성 Mock 자료 · 실제 시장 관측 아님'}[value]||'자료 출처 미확인');
const listingLabel=item=>item?.listingObserved===true?(item?.active===true?'상장·활성 관측':item?.active===false?'상장·비활성 관측':'상장 관측 · 활성 미확인'):'상장 목록 미관측';
const gridLabel=value=>({MATCH:'관측 호가 격자 일치',MISMATCH:'관측 호가 격자 불일치'}[value]||'관측 격자 미검증');
const contractNumbers=['min_trade_amount','min_qty','min_notional','tick_size','contract_size','qty_step','quantity_step','quantity_increment',
 'maker_commission','taker_commission','maker_fee','taker_fee','maker','taker','maker_fee_rate','taker_fee_rate'];
const contractCurrencies=['base_currency','quote_currency','settlement_currency'];
const contractText=value=>typeof value==='string'&&/^[A-Za-z0-9]{1,20}$/.test(value)?value:'미관측';
const listingDomains={BTC:'문서 예시 · 사용자 제공 명세',ETH:'문서 예시 · 사용자 제공 명세',
 SPOT:'문서 예시 · 현물 영역, 무기한 승인에 사용 안 함',PERPETUAL:'별도 확인 후보 · 미검증',USDT:'기존 미확인 값 · 기본값 제외'};
const readinessLabels={PUBLIC_MARKETS_UNOBSERVED:'공개 시장 관측 자료 없음',MARKET_UNOBSERVED:'해당 계약 관측 자료 없음',
 LISTING_NOT_REQUESTED:'상장 목록 조회 전',LISTING_UNOBSERVED:'상장 목록에서 해당 계약을 찾지 못함',
 LISTING_ACTIVE_UNKNOWN:'상장 활성 상태 미확인',LISTING_INACTIVE:'현재 비활성으로 관측된 계약',
 LISTING_CONFLICT:'조회 영역별 상장 상태·계약 규격 충돌',LISTING_DOMAIN_UNVERIFIED:'무기한 계약 조회 영역 미검증',
 BOOK_UNOBSERVED:'호가 미관측',BOOK_STALE:'호가 시각 만료 또는 미확인',BOOK_INTEGRITY_FAILED:'호가 배열 검증 실패',
 BOOK_DUPLICATE_PRICE:'호가 가격 중복',BOOK_UNSORTED:'호가 가격 순서 역전',BOOK_DEPTH_EXCEEDED:'요청한 호가 단계 수 초과',
 BOOK_LEVELS_INVALID:'호가 가격·수량 구조 오류',MARK_UNOBSERVED:'Mark Price 미관측',
 MARK_STALE:'Mark 시각 만료 또는 미확인',PRICE_GRID_MISMATCH:'관측 가격 격자 불일치',QUANTITY_GRID_MISMATCH:'관측 수량 격자 불일치',
 CONTRACT_UNITS_UNVERIFIED:'최소량·계약 크기·수량 증분의 공식 의미 미검증',FEES_UNVERIFIED:'Maker·Taker 수수료 단위 미검증',
 PAPER_DISABLED:'PAPER 자동 진입 OFF',READ_ONLY_MODE:'READ_ONLY · 실제 주문 차단'};
const readinessLabel=code=>typeof code==='string'&&Object.hasOwn(readinessLabels,code)?readinessLabels[code]:'세부 조건 미검증 · 조회 결과 확인 필요';
const freshClock=(value,now)=>numeric(value)!==null&&Number(value)>=1e12&&Number(value)<=now+5000&&now-Number(value)<=90000;
const safeInstrument=value=>typeof value==='string'&&/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/.test(value)?value:'계약명 미확인';
const positive=value=>numeric(value)!==null&&Number(value)>0;

export function orangeXReadinessView(payload={}, {now=Date.now()}={}){
 const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{},markets=records(data.markets);
 const readiness=data.marketReadiness&&typeof data.marketReadiness==='object'?data.marketReadiness:{};
 const perMarket=records(readiness.markets),configured=Array.isArray(data.listingCurrencies)?data.listingCurrencies:
  typeof data.listingCurrency==='string'?[data.listingCurrency]:[];
 const discoveries=records(data.listingDiscovery),domainRows=discoveries.length?discoveries:configured.map(currency=>({currency}));
 const rows=markets.map(item=>{
  const reasons=[];
  if(item?.listingObserved!==true)reasons.push('LISTING_UNOBSERVED');
  else if(item?.active===false)reasons.push('LISTING_INACTIVE');
  else if(item?.active!==true)reasons.push('LISTING_ACTIVE_UNKNOWN');
  if(item?.listingConflict===true)reasons.push('LISTING_CONFLICT');
  if(item?.listingDomainEligible!==true||!records(item?.listingMatches).some(match=>['BTC','ETH'].includes(match?.currency)))
   reasons.push('LISTING_DOMAIN_UNVERIFIED');
  if(item?.bookObserved===false||!positive(item?.bid)||!positive(item?.ask)||Number(item.bid)>=Number(item.ask))reasons.push('BOOK_UNOBSERVED');
  else if(item?.fresh===false||!freshClock(item?.priceAt,now))reasons.push('BOOK_STALE');
  if(item?.bookIntegrity?.valid===false)reasons.push('BOOK_INTEGRITY_FAILED',...records(item.bookIntegrity.issues));
  if(!positive(item?.markPrice))reasons.push('MARK_UNOBSERVED');
  else if(item?.markPriceFresh===false||!freshClock(item?.markPriceAt,now))reasons.push('MARK_STALE');
  if(item?.precision?.priceGrid==='MISMATCH')reasons.push('PRICE_GRID_MISMATCH');
  if(item?.precision?.quantityGrid==='MISMATCH')reasons.push('QUANTITY_GRID_MISMATCH');
  const server=perMarket.find(row=>row?.instrumentName===item?.instrumentName);
  reasons.push(...records(server?.reasons));
  return {instrumentName:safeInstrument(item?.instrumentName),reasons:[...new Set(reasons)],
   complete:reasons.length===0&&server?.publicDataReady===true};
 });
 // A server flag cannot refresh an old quote in an already-open browser view.
 const publicDataReady=readiness.publicDataReady===true&&data.enabled===true&&data.connected===true&&data._stale!==true&&
  rows.length>0&&rows.every(row=>row.complete)&&perMarket.length===rows.length;
 const summary=`공개 시장 검증 ${publicDataReady?'관측 조건 통과':'대기'} · 계약별 통과 ${rows.filter(row=>row.complete).length}/${rows.length} · 거래 준비 미완료 · PAPER 자동 진입 OFF · READ_ONLY`;
 const domains=domainRows.slice(0,5).map(item=>{
  const currency=Object.hasOwn(listingDomains,item?.currency)?item.currency:null;
  const count=numeric(item?.count),rowCount=count!==null&&Number.isInteger(count)&&count>=0?number(count):'미확인';
  const matched=records(item?.matchedInstruments).slice(0,30).map(safeInstrument);
  const http=numeric(item?.httpStatus),httpLabel=http!==null&&Number.isInteger(http)&&http>=100&&http<=599?`HTTP ${http}`:'HTTP 미관측';
  const observation=item?.status==='OBSERVED'?'목록 응답 관측':item?.status==='FAILED'?'목록 조회 실패':'목록 조회 미확인';
  return `<article class="orangex-domain"><strong>${esc(currency||'조회 영역 미확인')}</strong><small>${esc(currency?listingDomains[currency]:'영역 의미 미검증')}</small>`+
   `<p>${esc(observation)} · ${esc(httpLabel)} · 목록 ${esc(rowCount)}개 · 대상 계약 ${matched.length}개</p>`+
   `<p>${esc(matched.join(' · ')||'이 영역에서 일치한 대상 계약 없음')}</p></article>`;
 }).join('')||'<p class="orangex-empty">조회 영역 자료가 없습니다. API 연결만으로 상장 검증을 통과시키지 않습니다.</p>';
 const reasons=[...new Set([...records(readiness.publicDataReasons),...records(readiness.blockingReasons),
  'CONTRACT_UNITS_UNVERIFIED','FEES_UNVERIFIED','PAPER_DISABLED','READ_ONLY_MODE'])];
 const details=rows.filter(row=>row.reasons.length).map(row=>`<li><strong>${esc(row.instrumentName)}</strong>`+
  `<span>${esc(row.reasons.map(readinessLabel).join(' · '))}</span></li>`).join('');
 return {publicDataReady,tradingReady:false,paperReady:false,summary,domains,
  reasons:details+reasons.map(code=>`<li><span>${esc(readinessLabel(code))}</span></li>`).join('')};
}

export function orangeXContractDetails(markets,{dataSource,now=Date.now()}={}){
 return records(markets).slice(0,100).map(item=>{
  const fields=item?.contractFields&&typeof item.contractFields==='object'&&!Array.isArray(item.contractFields)?item.contractFields:{};
  const quantities=[['Bid 표시 잔량',item?.bids?.[0]?.[1]],['Ask 표시 잔량',item?.asks?.[0]?.[1]]];
  const comparison=item?.binanceComparison;
  const compareStatus=comparison?.mappingVerified===true?'대응 계약 확인':'대응 계약 미검증';
  const domains=[...new Set(records(item?.listingMatches).map(row=>row?.currency).filter(value=>Object.hasOwn(listingDomains,value)))];
  return `<article class="orangex-contract"><header><strong>${esc(item?.actualInstrumentName||item?.instrumentName||'계약 미확인')}</strong>`+
   `<small>${esc(listingLabel(item))} · 주문 차단</small></header>`+
   `<p class="orangex-contract-source">${esc(sourceLabel(dataSource))}</p>`+
   `<p>상장 관측 영역: ${esc(domains.join(' · ')||'미확인')} · ${item?.listingConflict===true?'영역별 규격 충돌':item?.listingDomainEligible===true?'공개 목록 일치 · 공식 단위 승인 아님':'무기한 조회 영역 미검증'}</p>`+
   `<dl>${contractNumbers.map(key=>`<div><dt>${esc(key)}</dt><dd>${esc(observedNumber(fields[key]?.value))}<small>필드 의미·단위 미검증</small></dd></div>`).join('')}`+
   `${contractCurrencies.map(key=>`<div><dt>${esc(key)}</dt><dd>${esc(contractText(fields[key]?.value))}<small>거래소 정의 미검증</small></dd></div>`).join('')}`+
   `${quantities.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(observedNumber(value))}<small>거래소 수량 단위 미검증</small></dd></div>`).join('')}</dl>`+
   `<p>Mark ${esc(observedNumber(item?.markPrice))} · ${esc(time(item?.markPriceAt))} · ${esc(markAge(item,now))}</p>`+
   `<p>가격 ${esc(gridLabel(item?.precision?.priceGrid))} · 수량 ${esc(gridLabel(item?.precision?.quantityGrid))} · 공식 정밀도 승인 아님</p>`+
   `<p>최소값과 주문 증분은 서로 대체하지 않습니다. Maker·Taker 관측값의 단위가 확인되지 않아 %·bp·예상 비용으로 환산하지 않습니다.</p>`+
   `<p>Binance 비교: ${esc(compareStatus)} · 기준가 ${esc(observedNumber(comparison?.price))} · 차이 ${esc(numeric(comparison?.gapBps)===null?'미관측':observedNumber(comparison.gapBps)+' bp')} · ${esc(time(comparison?.priceAt))}</p></article>`;
 }).join('')||'<p class="orangex-empty">관측한 계약 규격이 없습니다. 누락 값을 계산하거나 수수료를 0으로 채우지 않습니다.</p>';
}

export function orangeXView(payload={}){
 const data=payload&&typeof payload==='object'?payload:{};
 const markets=records(data.markets),account=data.account&&typeof data.account==='object'?data.account:null;
 const balances=records(account?.balances),positions=records(account?.positions),orders=records(account?.openOrders),trades=records(account?.trades);
 const verified=data.verification?.officialSpec==='VERIFIED';
 const invalidMode=data.mode!==undefined&&data.mode!=='READ_ONLY';
 const connected=data.enabled===true&&data.connected===true;
 const mode=invalidMode?'지원하지 않는 모드 · 주문 차단':'READ_ONLY · 조회 전용';
 const readiness=orangeXReadinessView(data);
 const accountReady=data.capabilities?.accountRead===true&&account!==null&&['READY','CONNECTED','OK'].includes(String(data.accountStatus||'').toUpperCase());
 const errors=records(data.errors).slice(-30).map(item=>{
  const code=errorCode(item?.code);
  // Do not echo arbitrary provider text: an upstream error can contain a URL or credential.
  return `<li><strong>${esc(code)}</strong><span>${esc(errorLabels[code]||'서버의 연결·명세·권한 상태를 확인하세요.')}</span><small>${esc(time(item?.at))}</small></li>`;
 });
 const metrics=[['운영 모드',mode],['시장 API',connected?'연결 확인':data.enabled===false?'연결 비활성':status(data.marketStatus)],
  ['계좌 조회',accountReady?'조회 가능':status(data.accountStatus)],['자동매매','OFF · 실제 데이터 진입 비활성'],
  ['공식 명세',verified?'명세 확인':'미검증'],['실제 연결 검증',status(data.verification?.liveConnection)],
  ['긴급 중지','거래 엔진 미구현 · 신규 주문 없음'],['마지막 조회',time(data.checkedAt)],['조회 자료',sourceLabel(data.dataSource)]];
 metrics.push(['공개 시장 검증',readiness.publicDataReady?'상장·호가·Mark 관측 조건 통과':'상장·시세 검증 대기'],['PAPER 자동 진입','OFF · READ_ONLY']);
 const totals=[['미실현 PNL',first(account,'unrealizedPnL','unrealizedPnl')],['당일 실현 PNL',first(account,'dailyRealizedPnL','dailyPnL')],
  ['누적 실현 PNL',first(account,'cumulativeRealizedPnL','totalRealizedPnL')]];
 return {
  mode,connected,hasAccount:accountReady,
  notice:invalidMode||data.orderSubmissionEnabled===true?'모드 확인 필요 · 이 화면은 조회만 제공하며 주문 제어 기능이 없습니다.':data._stale===true?
   '조회 갱신 실패 · 이전에 확인한 자료를 표시합니다. 시세 시각을 확인하세요.':'거래소 조회 전용 · 실제 데이터 자동 진입 OFF. 별도 OrangeX PAPER는 합성 시나리오로만 실행합니다.',
  state:connected&&verified?'orangex-ok':'orangex-pending',
  metrics:metrics.map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join(''),
  marketCount:`조회된 종목 후보 ${markets.length}개`,
  markets:markets.slice(0,100).map(item=>`<tr>${cell(item?.symbol||'미확인')}${cell(item?.instrumentName||'미확인')}`+
   `<td>${esc(marketState(item))}<small class="orangex-quote-age">${esc(listingLabel(item))}</small></td><td>${esc(number(item?.markPrice))}<small class="orangex-quote-age">${esc(time(item?.markPriceAt))} · ${esc(markAge(item))}</small></td>`+
   `${cell(number(item?.bid))}${cell(number(item?.ask))}${cell(numeric(item?.spreadBps)===null?'미검증':number(item.spreadBps)+' bp')}`+
   `${cell(unit(item?.minQty))}${cell(unit(item?.qtyStep))}${cell(unit(item?.priceTick))}<td>${esc(time(item?.priceAt))}<small class="orangex-quote-age">${esc(quoteAge(item))}</small></td></tr>`).join('')||empty(11,'확인된 OrangeX 계약·호가가 없습니다. 상장이나 가격을 추정하지 않습니다.'),
  contractDetails:orangeXContractDetails(markets,{dataSource:data.dataSource}),
  readinessSummary:readiness.summary,listingDomains:readiness.domains,readinessReasons:readiness.reasons,
  balanceNote:data.accountStatus==='STALE'?'이전 조회 자료입니다. 현재 잔고·포지션 상태는 재확인이 필요합니다.':accountReady?'거래소 조회값입니다. 기존 모의매매 PNL과 합산하지 않습니다.':'계좌 조회 미설정 또는 미검증 · 잔고와 PNL을 0으로 가정하지 않습니다.',
  balances:balances.slice(0,30).map(item=>`<tr>${cell(first(item,'asset','currency')||'미확인')}${cell(number(first(item,'balance','total')))}`+
   `${cell(number(first(item,'availableBalance','available')))}${cell(number(item?.equity))}</tr>`).join('')||empty(4,accountReady?'조회된 잔고 자료가 없습니다.':'계좌 조회 미설정 · 잔고 미확인'),
  pnl:totals.map(([label,value])=>`<div><span>${esc(label)}</span><strong class="${signClass(value)}">${esc(money(value))}</strong></div>`).join(''),
  positions:positions.slice(0,100).map(item=>`<article class="orangex-position"><header><strong>${esc(item?.symbol||'미확인')} · ${esc(direction(first(item,'direction','side')))}</strong>`+
   `<small>레버리지 ${numeric(item?.leverage)===null?'미확인':esc(number(item.leverage))+'x'}</small></header>`+
   `<dl><div><dt>수량</dt><dd>${esc(number(first(item,'size','quantity')))}</dd></div><div><dt>진입가</dt><dd>${esc(number(item?.entryPrice))}</dd></div>`+
   `<div><dt>현재가</dt><dd>${esc(number(item?.markPrice))}</dd></div><div><dt>손절가</dt><dd>${esc(number(item?.stopPrice))}</dd></div>`+
   `<div><dt>미실현 PNL</dt><dd class="${signClass(item?.unrealizedPnL)}">${esc(money(item?.unrealizedPnL))}</dd></div>`+
   `<div><dt>실현 PNL</dt><dd class="${signClass(item?.realizedPnL)}">${esc(money(item?.realizedPnL))}</dd></div></dl>`+
   `<p>익절가 ${esc(targetPrices(item?.targets))}</p></article>`).join('')||'<p class="orangex-empty">확인된 포지션 자료가 없습니다. 미조회 상태를 포지션 0건으로 해석하지 마세요.</p>',
  orders:orders.slice(0,100).map(item=>`<tr>${cell(item?.symbol||'미확인')}${cell(first(item,'orderId','id')??'미확인')}`+
   `${cell(direction(first(item,'direction','side')))}${cell(item?.status||'미확인')}${cell(number(item?.price))}`+
   `${cell(number(first(item,'quantity','size')))}${cell(number(first(item,'filledQuantity','filledSize')))}</tr>`).join('')||empty(7,'조회된 미체결 주문 자료가 없습니다.'),
  trades:trades.slice(0,100).map(item=>`<tr>${cell(item?.symbol||'미확인')}${cell(direction(first(item,'direction','side')))}`+
   `${cell(number(item?.price))}${cell(number(first(item,'quantity','size')))}${cell(money(item?.fee))}${cell(money(item?.realizedPnL))}`+
   `${cell(time(first(item,'at','timestamp')))}</tr>`).join('')||empty(7,'조회된 체결 자료가 없습니다. 요청 성공 응답을 체결로 표시하지 않습니다.'),
  errors:errors.join('')||'<li><span>표시할 오류 기록이 없습니다. 연결 성공을 의미하지는 않습니다.</span></li>',
  rejection:'1단계 조회 전용: 모든 시그널은 OrangeX 주문 제출 대상에서 제외됩니다. PAPER·LIVE 및 보호 주문은 후속 검증 대상입니다.'
 };
}

export function renderOrangeX(payload,{root=globalThis.document}={}){
 const view=orangeXView(payload),find=id=>root?.getElementById(id);
 const set=(id,value,html=false)=>{const node=find(id);if(node)node[html?'innerHTML':'textContent']=value};
 set('orangexNotice',view.notice);set('orangexMetrics',view.metrics,true);set('orangexMarketCount',view.marketCount);
 set('orangexMarkets',view.markets,true);set('orangexBalanceNote',view.balanceNote);set('orangexBalances',view.balances,true);
 set('orangexContractDetails',view.contractDetails,true);
 set('orangexReadiness',view.readinessSummary);set('orangexListingDomains',view.listingDomains,true);set('orangexReadinessReasons',view.readinessReasons,true);
 set('orangexPnl',view.pnl,true);set('orangexPositions',view.positions,true);set('orangexOrders',view.orders,true);
 set('orangexTrades',view.trades,true);set('orangexErrors',view.errors,true);set('orangexRejections',view.rejection);
 const panel=find('orangex');if(panel)panel.className='panel orangex-panel '+view.state;
 renderOrangeXOperational(payload?.operationalReadiness,{root});
 return view;
}

export function initOrangeX({root=globalThis.document,fetcher=globalThis.fetch,interval=30000,setTimer=globalThis.setInterval}={}){
 if(!root?.getElementById('orangex'))return null;
 let active=false,lastSnapshot=null,paperSnapshot=null,replaySnapshot=null;
 const button=root.getElementById('orangexRefresh');
 async function refreshPaper(){
  if(!root?.getElementById('orangexPaper'))return;
  try{
   const response=await fetcher('/api/orangex/paper',{method:'GET',cache:'no-store',headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('Offline PAPER read failed');
   paperSnapshot=await response.json();renderOrangeXPaper(paperSnapshot,{root});
  }catch{renderOrangeXPaper({...paperSnapshot,_stale:true},{root})}
 }
 async function refreshReplay(){
  if(!root?.getElementById('orangexPaperReplay'))return;
  try{
   const response=await fetcher('/api/orangex/paper/replay',{method:'GET',cache:'no-store',headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('Replay archive unavailable');
   replaySnapshot=await response.json();renderOrangeXPaperReplay(replaySnapshot,{root});
  }catch{renderOrangeXPaperReplay({...replaySnapshot,_stale:true},{root})}
 }
 async function refresh(force=false){
  if(active)return false;
  active=true;if(button)button.disabled=true;
  // Local simulation records remain available while a public venue request is
  // waiting or failing. Both reads share the same refresh serialization gate.
  const paperRead=Promise.all([refreshPaper(),refreshReplay()]);
  try{
   const response=await fetcher(force?'/api/orangex?refresh=1':'/api/orangex',{method:'GET',cache:'no-store',headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('OrangeX read-only response failed');
   const data=await response.json();lastSnapshot=data;renderOrangeX(data,{root});return true;
  }catch{
   renderOrangeX({...lastSnapshot,_stale:lastSnapshot!==null,connected:false,marketStatus:'ERROR',accountStatus:'STALE',errors:[{code:'HTTP_ERROR',at:Date.now()}]},{root});return false;
  }finally{
   await paperRead;
   active=false;if(button)button.disabled=false;
  }
 }
 button?.addEventListener('click',()=>void refresh(true));
 const timer=setTimer?.(()=>void refresh(),interval);void refresh();
 return {refresh,timer};
}

if(typeof document!=='undefined')initOrangeX();
