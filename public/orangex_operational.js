// Status display only. No credentials, transport, settings or activation controls.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={SOURCE_PROVENANCE:'공개 응답 출처',EVIDENCE_FORMAT:'검증 자료 형식',READ_ONLY_CONTEXT:'조회 전용 상태',CONTRACT_NAME:'정확한 계약명',LISTING_ACTIVE:'상장·활성 상태',
 CONTRACT_SIZE:'계약 크기',QUANTITY_UNIT:'주문 수량 단위',MINIMUM_QUANTITY:'최소 주문량',QUANTITY_INCREMENT:'수량 증분',MIN_NOTIONAL:'최소 명목금액',
 PRICE_TICK:'가격 단위',FEE_UNITS:'Maker·Taker 수수료 단위',FUNDING:'펀딩 정산 정보',TIMESTAMP_UNITS:'타임스탬프 단위',
 BOOK_FRESHNESS:'호가 신선도',MARK_FRESHNESS:'Mark 신선도',BOOK_INTEGRITY:'호가 잔량·정렬',PRICE_PRECISION:'가격 정밀도',
 QUANTITY_PRECISION:'수량 정밀도',BINANCE_MAPPING:'Binance 계약 대응'};
const statuses={PASS:'PASS · 확인',FAIL:'FAIL · 불일치',UNVERIFIED:'UNVERIFIED · 미검증'};
const rows=value=>Array.isArray(value)?value:[];
const checkTable=checks=>checks.slice(0,60).map(check=>{
 const status=Object.hasOwn(statuses,check?.status)?check.status:'UNVERIFIED',label=Object.hasOwn(labels,check?.id)?labels[check.id]:'검증 자료 확인';
 return `<tr><td>${esc(label)}</td><td>${esc(statuses[status])}</td></tr>`;
}).join('')||'<tr><td colspan="2">검증 자료 미확인</td></tr>';
export function orangeXOperationalView(report={}){
 const globalIds=['SOURCE_PROVENANCE','EVIDENCE_FORMAT','READ_ONLY_CONTEXT'],marketIds=Object.keys(labels).filter(id=>!globalIds.includes(id)),
  exactPass=(checks,ids)=>ids.every(id=>rows(checks).filter(check=>check?.id===id).length===1&&rows(checks).find(check=>check?.id===id)?.status==='PASS');
 const ready=report?.kind==='ORANGEX_OPERATIONAL_READINESS'&&report?.status==='READY'&&rows(report.checks).length>0&&
  report.checks.every(check=>check?.status==='PASS')&&exactPass(report.checks,globalIds)&&rows(report.markets).length===3&&
  ['BTC','ETH','SOL'].every(asset=>report.markets.filter(row=>row?.asset===asset).length===1&&exactPass(report.markets.find(row=>row.asset===asset).checks,marketIds));
 const global=rows(report.checks).filter(check=>globalIds.includes(check?.id));
 const markets=rows(report.markets).slice(0,3).map(row=>{
  const asset=['BTC','ETH','SOL'].includes(row?.asset)?row.asset:'종목 미확인';
  return `<article class="orangex-operational-market"><h5>${esc(asset)}</h5><table><tbody>${checkTable(rows(row?.checks))}</tbody></table></article>`;
 }).join('');
 return {status:`${ready?'READY · 필수 정보 확인':'NOT_READY · 필수 정보 미검증 또는 불일치'} · 상태 보고 전용 · 실제 데이터 PAPER 자동 진입 OFF · READ_ONLY`,
  checks:`<article class="orangex-operational-market"><h5>공통 검증</h5><table><tbody>${checkTable(global)}</tbody></table></article>`+
   (markets||'<p class="orangex-empty">BTC·ETH·SOL 검증 자료가 없습니다. HTTP 200만으로 준비 완료를 표시하지 않습니다.</p>')};
}
export function renderOrangeXOperational(report,{root=globalThis.document}={}){
 const view=orangeXOperationalView(report),status=root?.getElementById?.('orangexOperationalStatus'),checks=root?.getElementById?.('orangexOperationalChecks');
 if(status)status.textContent=view.status;if(checks)checks.innerHTML=view.checks;return view;
}
