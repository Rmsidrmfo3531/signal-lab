// Live / testnet order control (알림 · 시스템 page). Calls only this server's /api/live endpoints; no keys are ever sent or shown here.
const LABEL={BINGX:'BingX',GATEIO:'Gate.io'};
function cell(row,value,small){const td=document.createElement('td');td.textContent=value;if(small){const s=document.createElement('small');s.textContent=small;td.append(s)}row.append(td);return td}
const LIVE_STATUS={SUBMITTING:'주문 중',OPEN:'보유(손절 설정)',CLOSED:'종료',FAILED:'주문 실패',UNKNOWN:'확인 필요'};
export function liveSummary(s){
 const keys=['BINGX','GATEIO'].map(v=>`${LABEL[v]} 키 ${s.credentialsConfigured?.[v]?'설정됨':'없음'}`).join(' · ');
 const mode={OFF:'OFF(주문 없음)',TESTNET:'테스트넷',LIVE:'실거래'}[s.mode]||s.mode;
 return `모드 ${mode} · ${s.armed?'활성화됨':'비활성'}${s.killSwitch?' · 긴급 정지 중':''} · ${keys} · ${s.limits?.sizing==='BALANCE'?`잔고 비율 1단위 ${s.limits.unitPct}% × 배율, 매물대 분할 추매 · 1회 최대 손실 ≤ 잔고 ${s.limits.maxLossPct}% · 일일 ≤ ${s.limits.dailyMaxLossPct}%`:`1회 위험 ≤ $${s.limits?.maxRiskUSD} · 일일 ≤ $${s.limits?.dailyMaxRiskUSD}`} · 동시 ${s.limits?.maxOpen}개${s.limits?.maxPerDirection?` (롱·숏 각 ${s.limits.maxPerDirection}개)`:''}`;
}
function renderLive(s){
 const status=document.getElementById('liveStatus'),rows=document.getElementById('liveRecords'),skipped=document.getElementById('liveSkipped');
 if(!status||!rows||!skipped)return;
 status.textContent=liveSummary(s);status.classList.toggle('warn',s.killSwitch||s.mode==='LIVE');
 rows.replaceChildren();
 for(const r of s.records||[]){const tr=document.createElement('tr');
  for(const v of [new Date(r.createdAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),LABEL[r.venue]||r.venue,r.symbol,r.direction,
   `${r.quantity?.total??'—'} ${r.quantity?.unit==='CONTRACT'?'계약':''}`,'$'+Number(r.plannedRiskUSD||0).toFixed(2),LIVE_STATUS[r.status]||r.status,
   r.lastEvent?`${r.lastEvent.type}${r.lastEvent.reason?' · '+r.lastEvent.reason:''}`:'—'])cell(tr,String(v));
  rows.append(tr)}
 if(!rows.children.length){const tr=document.createElement('tr');cell(tr,'주문 기록 없음').colSpan=8;rows.append(tr)}
 skipped.replaceChildren();
 for(const x of (s.skipped||[]).slice(0,10)){const li=document.createElement('li');li.textContent=`${new Date(x.at).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul'})} ${x.symbol||''} ${(x.reasons||[x.reason]).join(' · ')}`;skipped.append(li)}
 if(!skipped.children.length){const li=document.createElement('li');li.textContent='없음';skipped.append(li)}
}
async function liveCall(path,body){
 const r=await fetch(path,{method:path==='/api/live'?'GET':'POST',cache:'no-store',...(path==='/api/live'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})});
 const data=await r.json();if(!r.ok)throw Error(data.error||'HTTP '+r.status);renderLive(data);return data;
}
if(typeof document!=='undefined'&&document.getElementById('liveControl')){
 const fail=e=>{const s=document.getElementById('liveStatus');if(s){s.textContent='실주문 요청 실패: '+e.message;s.classList.add('warn')}};
 document.getElementById('liveArm')?.addEventListener('click',()=>{if(confirm('실주문을 활성화합니다. 다음 최종 신호부터 거래소에 실제 주문이 나갑니다. 계속할까요?'))liveCall('/api/live/arm',{confirm:'ARM'}).catch(fail)});
 document.getElementById('liveDisarm')?.addEventListener('click',()=>liveCall('/api/live/disarm').catch(fail));
 document.getElementById('liveKill')?.addEventListener('click',()=>liveCall('/api/live/kill').catch(fail));
 document.getElementById('liveResetKill')?.addEventListener('click',()=>{if(confirm('긴급 정지를 해제합니다. 거래소 계정 상태를 먼저 확인하셨나요?'))liveCall('/api/live/reset-kill',{confirm:'RESET'}).catch(fail)});
 const tickLive=()=>{if(!document.getElementById('livePanel')?.closest('[data-workspace-route]')?.hidden)liveCall('/api/live').catch(fail)};
 setInterval(tickLive,15000);setTimeout(tickLive,500);window.addEventListener('hashchange',()=>setTimeout(tickLive,60));
}
