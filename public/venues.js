// BingX / Gate.io public quote panel. Read only: GET /api/venues, no keys, no orders.
// Text is written with textContent so venue data can never inject markup.
const LABEL={BINGX:'BingX',GATEIO:'Gate.io'};
const REASON={NOT_LISTED:'미상장',NETWORK_UNREACHABLE:'연결 실패',BOOK_STALE:'호가 지연',BOOK_CROSSED:'호가 역전',BOOK_MISSING_OR_MALFORMED:'호가 형식 오류',
 BOOK_TIME_MISSING:'호가 시각 없음',CONTRACTS_UNAVAILABLE:'계약 목록 실패',VENUE_STATUS_INACTIVE:'거래 중지',VENUE_API_TRADING_DISABLED:'API 거래 불가',
 VENUE_DELISTING:'상장 폐지 예정',VENUE_CONTRACT_NOT_LINEAR:'USDT 선형 계약 아님',VENUE_PRECISION_INVALID:'단위 정보 오류',VENUE_MIN_QUANTITY_INVALID:'최소 수량 정보 오류'};
const reasonText=code=>REASON[code]||(String(code||'').startsWith('HTTP_')?'HTTP '+String(code).slice(5):String(code||'미확인'));
const price=v=>Number.isFinite(v)?Number(v).toPrecision(8).replace(/\.?0+$/,''):'—';
const bp=v=>Number.isFinite(v)?(v>0?'+':'')+v.toFixed(1)+' bp':'—';
function cell(row,value,small){const td=document.createElement('td');td.textContent=value;if(small){const s=document.createElement('small');s.textContent=small;td.append(s)}row.append(td);return td}

export function venueQuoteCells(venue){
 if(!venue?.book)return [venue?.error?reasonText(venue.error):'—',''];
 const b=venue.book,age=Number.isFinite(b.ageMs)?Math.round(b.ageMs/1000)+'초 전':'';
 if(!b.ok)return [price(b.bid)+' / '+price(b.ask),b.reasons.map(reasonText).join(' · ')];
 return [price(b.bid)+' / '+price(b.ask),age];
}
export function contractRows(data){
 const out=[];
 for(const row of data.rows||[])for(const venue of ['BINGX','GATEIO']){
  const c=row.venues?.[venue]?.contract;if(!c)continue;
  out.push([row.symbol,LABEL[venue],c.tradable?'가능':'불가 · '+c.reasons.map(reasonText).join(' · '),c.tickSize??'—',
   c.quantityUnit==='CONTRACT'?`1계약 = ${c.contractSizeBase} ${c.baseAsset}`:`${c.quantityStep} ${c.baseAsset}`,
   c.minQuantityBase?`${c.minQuantityBase} ${c.baseAsset}`:'—',c.minNotionalUSDT?`${c.minNotionalUSDT} USDT`:'—']);
 }
 return out;
}
function render(data){
 const rows=document.getElementById('venuesRows'),contracts=document.getElementById('venuesContracts'),status=document.getElementById('venuesStatus');
 if(!rows||!contracts||!status)return;
 rows.replaceChildren();contracts.replaceChildren();
 for(const r of data.rows||[]){
  const tr=document.createElement('tr');cell(tr,r.symbol);
  for(const venue of ['BINGX','GATEIO']){const v=r.venues?.[venue],[q,s]=venueQuoteCells(v);cell(tr,q,s);cell(tr,v?.book?.ok?v.book.spreadBps.toFixed(2)+' bp':'—')}
  cell(tr,bp(r.crossVenueMidBps));
  cell(tr,r.binanceChartPrice?price(r.binanceChartPrice):'—',['BINGX','GATEIO'].map(v=>`${LABEL[v]} ${bp(r.venues?.[v]?.vsBinanceBps)}`).join(' · '));
  rows.append(tr);
 }
 if(!rows.children.length){const tr=document.createElement('tr');cell(tr,'관심 종목 없음').colSpan=7;rows.append(tr)}
 for(const values of contractRows(data)){const tr=document.createElement('tr');for(const v of values)cell(tr,v);contracts.append(tr)}
 const parts=['BINGX','GATEIO'].map(v=>{const s=data.venues?.[v];return `${LABEL[v]} ${s?.state==='connected'?'연결됨':s?.state==='error'?'오류('+reasonText(s.error)+')':'대기'}`});
 status.textContent=`${parts.join(' · ')} · 조회 전용 · 주문 기능 없음 · ${new Date(data.generatedAt).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul'})} KST`;
 status.classList.toggle('warn',['BINGX','GATEIO'].some(v=>data.venues?.[v]?.state==='error'));
}
let loading=false;
async function load(){
 if(loading)return;loading=true;const status=document.getElementById('venuesStatus');
 try{const r=await fetch('/api/venues',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'HTTP '+r.status);render(data)}
 catch(e){if(status){status.textContent='시세 조회 실패: '+e.message;status.classList.add('warn')}}
 finally{loading=false}
}
if(typeof document!=='undefined'&&document.getElementById('venues')){
 document.getElementById('venuesRefresh')?.addEventListener('click',load);
 const visible=()=>!document.getElementById('venues').hidden&&document.visibilityState!=='hidden';
 // Only while the panel is on screen: BingX allows one public request per second per IP.
 const tick=()=>{if(visible())load()};
 window.addEventListener('hashchange',()=>setTimeout(tick,50));
 setInterval(tick,20000);setTimeout(tick,300);
}
