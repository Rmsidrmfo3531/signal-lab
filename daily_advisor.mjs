// Daily & real-time trading/feature/UI improvement advisor (user 2026-11-22):
// Analyzes both real-account (copy + manual) and testnet (scalp + budget) trading records
// alongside current feature/UI configuration, and surfaces actionable Add / Improve / Remove
// recommendations via Telegram (daily 09:00 KST digest + deduplicated real-time HIGH alerts
// + /coach command) and the web dashboard (/api/advisor).
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {displaySymbol} from './public/symbol_display.js';

const KST_MS=9*3600000;
const REALTIME_COOLDOWN_MS=24*3600000;
const RECENT_EVENT_MS=48*3600000;
const r2=v=>Math.round(Number(v)*100)/100;
const fin=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v));
const money=v=>{const n=Number(v);return !Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};
export const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
export const kstHour=t=>new Date(Number(t)+KST_MS).getUTCHours();

export const DAILY_ADVISOR_DEFAULTS=Object.freeze({
 enabled:true,
 dailyHourKst:9,
 realtimeAlerts:true,
});

function summarizeTrades(rows){
 const list=(Array.isArray(rows)?rows:[]).filter(x=>x&&!x.archivedFromHistory&&fin(x.netUSD));
 const n=list.length;
 const wins=list.filter(x=>Number(x.netUSD)>0);
 const losses=list.filter(x=>Number(x.netUSD)<0);
 const netUSD=r2(list.reduce((s,x)=>s+Number(x.netUSD),0));
 const grossWin=wins.reduce((s,x)=>s+Number(x.netUSD),0);
 const grossLoss=-losses.reduce((s,x)=>s+Number(x.netUSD),0);
 let cum=0,peak=0,mdd=0;
 for(const x of [...list].sort((a,b)=>(Number(a.closedAt)||0)-(Number(b.closedAt)||0))){
  cum+=Number(x.netUSD);
  if(cum>peak)peak=cum;
  if(peak-cum>mdd)mdd=peak-cum;
 }
 return {
  trades:n,
  wins:wins.length,
  losses:losses.length,
  winRatePct:n?+(wins.length/n*100).toFixed(1):null,
  profitFactor:grossLoss>0?+(grossWin/grossLoss).toFixed(2):null,
  netUSD,
  maxDrawdownUSD:r2(mdd),
 };
}

function groupBySymbol(rows){
 const map=new Map();
 for(const x of Array.isArray(rows)?rows:[]){
  if(!x||x.archivedFromHistory||!fin(x.netUSD))continue;
  const sym=displaySymbol(x.symbol||'').toUpperCase();
  if(!sym||sym==='-')continue;
  let cur=map.get(sym);
  if(!cur){cur={symbol:sym,trades:0,wins:0,netUSD:0};map.set(sym,cur)}
  cur.trades++;
  if(Number(x.netUSD)>0)cur.wins++;
  cur.netUSD+=Number(x.netUSD);
 }
 return [...map.values()].map(x=>({...x,winRatePct:x.trades?+(x.wins/x.trades*100).toFixed(1):null,netUSD:r2(x.netUSD)}));
}

function rankSort(a,b){
 const p={HIGH:0,MEDIUM:1,LOW:2};
 return (p[a.priority]??9)-(p[b.priority]??9)||String(a.id).localeCompare(String(b.id));
}

/**
 * Pure advisor engine: builds Add / Improve / Remove items from real-account, testnet-scalp,
 * and current UI/feature configuration snapshots.
 */
export function buildImprovementAdvice({
 now=Date.now(),
 copyClosed=[],
 manualClosed=[],
 copyControls=null,
 copyEvents=[],
 copyAudit=null,
 analytics=null,
 realEquityUSD=null,
 realSafety=null,
 realTrailing=null,
 accountAlerts=null,
 scalpClosed=[],
 scalpStats=null,
 scalpRuntime=null,
 testnetBudget=null,
 testnetScalpOnly=false,
 paperTrading=false,
 copyTestnetTrades=0,
}={}){
 const confirmed=x=>x&&!x.archivedFromHistory&&fin(x.netUSD)&&(!x.netSource||['EXCHANGE','EXCHANGE_FILLS'].includes(x.netSource));
 const realCopyRows=(Array.isArray(copyClosed)?copyClosed:[]).filter(confirmed);
 const realManualRows=(Array.isArray(manualClosed)?manualClosed:[]).filter(confirmed);
 const scalpRows=(Array.isArray(scalpClosed)?scalpClosed:[]).filter(x=>x&&fin(x.netUSD));

 const copySum=summarizeTrades(realCopyRows);
 const manualSum=summarizeTrades(realManualRows);
 const scalpSum=scalpStats?.all?.trades!=null?{
  trades:Number(scalpStats.all.trades)||0,
  wins:Number(scalpStats.all.wins)||0,
  losses:Math.max(0,(Number(scalpStats.all.trades)||0)-(Number(scalpStats.all.wins)||0)),
  winRatePct:scalpStats.all.winRatePct??null,
  profitFactor:scalpStats.all.profitFactor??null,
  netUSD:fin(scalpStats.all.netUSD)?r2(scalpStats.all.netUSD):0,
  avgHoldMin:fin(scalpStats.all.avgHoldMin)?Math.round(Number(scalpStats.all.avgHoldMin)):null,
  avgMfeR:fin(scalpStats.all.avgMfeR)?r2(scalpStats.all.avgMfeR):null,
  avgMaeR:fin(scalpStats.all.avgMaeR)?r2(scalpStats.all.avgMaeR):null,
 }:summarizeTrades(scalpRows);

 const items=[];
 const push=(category,scope,priority,id,title,detail)=>items.push({category,scope,priority,id,title,detail});

 // ── 1) Real-Account Copy vs Manual Analysis ─────────────────────────────
 const manualHighLev=realManualRows.filter(x=>Number(x.leverage)>=20);
 const manualLowLev=realManualRows.filter(x=>Number(x.leverage)>0&&Number(x.leverage)<20);
 const hiSum=summarizeTrades(manualHighLev);
 const loSum=summarizeTrades(manualLowLev);

 if(copySum.trades>=3&&manualSum.trades>=3&&copySum.netUSD>10&&manualSum.netUSD<-20){
  push('improve','real','HIGH','real:copy-vs-manual-gap',
   '실계좌 카피 수익이 수동 매매 손실로 상쇄 중',
   `카피 ${copySum.trades}건 승률 ${copySum.winRatePct}% (${money(copySum.netUSD)}, MDD $${copySum.maxDrawdownUSD}) vs 수동 ${manualSum.trades}건 승률 ${manualSum.winRatePct}% (${money(manualSum.netUSD)}, MDD $${manualSum.maxDrawdownUSD}). 수동 매매 비중·빈도를 줄이고 검증된 카피 비중을 우선 유지하는 것이 유리합니다.`);
 }

 if(hiSum.trades>=3&&hiSum.netUSD<-30&&(loSum.trades===0||loSum.netUSD>=0||hiSum.netUSD<loSum.netUSD*2)){
  const loNote=loSum.trades>0?` 반면 20배 미만은 ${loSum.trades}건 승률 ${loSum.winRatePct}% (${money(loSum.netUSD)})입니다.`:'';
  push('improve','real','HIGH','real:manual-high-leverage',
   '실계좌 수동 20배+ 고배율 구간 손실 집중',
   `수동 20배 이상 ${hiSum.trades}건 승률 ${hiSum.winRatePct}% · ${money(hiSum.netUSD)}.${loNote} 실계좌 안전장치의 수동 최대 레버리지(20배) 제한을 켜는 것을 권장합니다.`);
 }

 const manualBySym=groupBySymbol(realManualRows).sort((a,b)=>a.netUSD-b.netUSD);
 const copyBySym=groupBySymbol(realCopyRows).sort((a,b)=>a.netUSD-b.netUSD);
 const copySymMap=new Map(copyBySym.map(x=>[x.symbol,x]));

 // Worst manual symbol overlapping a profitable copy symbol -> suggest removing manual trading on that coin
 const overlapWorst=manualBySym.find(m=>m.trades>=2&&m.netUSD<=-30&&(copySymMap.get(m.symbol)?.netUSD??0)>=10);
 if(overlapWorst){
  const cp=copySymMap.get(overlapWorst.symbol);
  push('remove','real','HIGH',`real:overlap-${overlapWorst.symbol.toLowerCase()}`,
   `${overlapWorst.symbol} 수동 진입 중단 권장 (카피와 중복·역손실)`,
   `카피 ${overlapWorst.symbol}은 ${cp.trades}건 승률 ${cp.winRatePct}% (${money(cp.netUSD)})인데, 같은 종목 수동 매매는 ${overlapWorst.trades}건 승률 ${overlapWorst.winRatePct}% (${money(overlapWorst.netUSD)})입니다. 카피 종목은 수동 진입을 빼고 카피에 맡기세요.`);
 }else if(manualBySym[0]&&manualBySym[0].trades>=3&&manualBySym[0].netUSD<=-30){
  const w=manualBySym[0];
  push('improve','real','MEDIUM',`real:manual-worst-${w.symbol.toLowerCase()}`,
   `수동 최다 손실 종목 점검 (${w.symbol})`,
   `${w.symbol} 수동 ${w.trades}건 승률 ${w.winRatePct}% · ${money(w.netUSD)}. 진입 기준 강화 또는 임시 제외를 권장합니다.`);
 }

 // Losing copy symbols not yet blocked -> suggest adding to /block
 const blockedSet=new Set((copyControls?.blockedSymbols||[]).map(s=>displaySymbol(s).toUpperCase()));
 const badCopySym=copyBySym.find(x=>x.trades>=3&&x.netUSD<=-15&&(x.winRatePct??100)<45&&!blockedSet.has(x.symbol));
 if(badCopySym){
  push('add','real','MEDIUM',`real:block-copy-${badCopySym.symbol.toLowerCase()}`,
   `카피 손실 종목 제외 목록 추가 추천 (${badCopySym.symbol})`,
   `카피 ${badCopySym.symbol} ${badCopySym.trades}건 승률 ${badCopySym.winRatePct}% · ${money(badCopySym.netUSD)}. 텔레그램 "/block ${badCopySym.symbol}"으로 제외할 수 있습니다.`);
 }

 // Recent operational copy skips
 const recentEvents=(Array.isArray(copyEvents)?copyEvents:[]).filter(e=>e&&Number(e.at)>0&&now-Number(e.at)<=RECENT_EVENT_MS);
 const overlapSkips=recentEvents.filter(e=>e.type==='SKIPPED'&&e.cause==='VENUE_POSITION_EXISTS');
 if(overlapSkips.length>=1){
  const syms=[...new Set(overlapSkips.map(e=>displaySymbol(e.symbol||'')).filter(Boolean))].slice(0,4);
  push('improve','real','MEDIUM','real:venue-position-exists-skips',
   `수동 포지션 때문에 카피 진입 ${overlapSkips.length}건 누락`,
   `최근 48시간 내 ${syms.join(', ')||'동일 종목'}에 기존 포지션이 있어 카피 진입을 건너뛰었습니다(VENUE_POSITION_EXISTS). 카피 주력 코인은 수동 보유를 피하는 편이 좋습니다.`);
 }
 const auditBlocks=recentEvents.filter(e=>['SKIPPED','ADD_SKIPPED'].includes(e.type)&&e.reason==='COPY_AUDIT_BLOCKED');
 if(auditBlocks.length>=2){
  push('improve','real','HIGH','real:copy-audit-blocked',
   `카피 감사 차단(COPY_AUDIT_BLOCKED) ${auditBlocks.length}건 발생`,
   `최근 48시간 내 카피 진입/추매가 ${auditBlocks.length}회 차단되었습니다. 실계좌 화면의 카피 감사 상태·거래소 포지션 동기화 여부를 확인하세요.`);
 }
 if(copyAudit&&copyAudit.ready===false&&copyAudit.error){
  push('improve','real','HIGH','real:copy-audit-unready',
   '실계좌 카피 감사 상태 이상',
   `현재 카피 감사가 준비되지 않았습니다(${copyAudit.error}). 해결 전까지 카피 진입이 제한됩니다.`);
 }

 // Real safety guard & trailing adoption
 const realTradesTotal=copySum.trades+manualSum.trades;
 if(realSafety&&realSafety.enabled===false&&(manualSum.maxDrawdownUSD>=100||manualSum.netUSD<=-50)){
  push('add','real','HIGH','real:enable-safety-guard',
   '실계좌 일손실 안전장치(-8% · 수동 20배 제한) 활성화 추천',
   `수동 누적 MDD $${manualSum.maxDrawdownUSD} (${money(manualSum.netUSD)})가 기록되었습니다. 실계좌 화면에서 "안전 프리셋 적용" 1클릭으로 일손실 차단과 수동 고배율 가드를 켤 수 있습니다.`);
 }
 if(realTrailing&&realTrailing.enabled===false&&realTradesTotal>=5){
  push('add','real','LOW','real:consider-trailing',
   '실계좌 자동 트레일링 익절(Net ROE) 활용 검토',
   '수수료 반영 순수익률(Net ROE) 기반 자동 트레일링이 현재 OFF 상태입니다. 익절 타이밍을 놓치는 구간이 많다면 실계좌 카드에서 보수 설정(+12% 발동 / -4% 되돌림)으로 켜볼 수 있습니다.');
 }

 // Fee/funding drag from analytics
 const costs=analytics?.costs;
 if(costs&&(costs.feeTurnedLoss||(fin(costs.feeDrainPct)&&Number(costs.feeDrainPct)>=30))){
  push('improve','real','MEDIUM','real:fee-drain',
   `실계좌 수수료·펀딩 잠식 높음 (${costs.feeDrainPct!=null?costs.feeDrainPct+'%':'손실 전환'})`,
   `실현 ${money(costs.realizedPnlUSD)} 대비 수수료·펀딩 ${money(costs.totalCostUSD)} → 순손익 ${money(costs.netUSD)}. 단기 잦은 수동 매매·고배율 시장가 횟수를 줄이면 순수익이 크게 개선됩니다.`);
 }

 // ── 2) Testnet Scalp Analysis ───────────────────────────────────────────
 if(scalpRuntime?.mode==='TESTNET'&&scalpRuntime.armed&&scalpRuntime.blocked){
  push('improve','testnet','HIGH',`scalp:blocked-${String(scalpRuntime.blocked).toLowerCase()}`,
   `테스트넷 단타 진입 중지 상태 (${scalpRuntime.blocked})`,
   scalpRuntime.blocked==='DAILY_LOSS_LIMIT'
    ?'하루 손실 한도에 걸려 5분 스캔 진입이 멈춰 있습니다. 테스트넷 화면의 "오늘 정지 해제" 또는 한도/기준 자본 설정을 확인하세요.'
    :`현재 테스트넷 단타가 "${scalpRuntime.blocked}" 사유로 진입을 멈춘 상태입니다.`);
 }

 const byExit=scalpStats?.byExitReason||{};
 const earlyTp=byExit.EARLY_TAKE_PROFIT||null;
 const manualExit=byExit.MANUAL||null;
 if(scalpSum.trades>=5&&scalpSum.winRatePct!=null&&scalpSum.winRatePct>=60&&scalpSum.profitFactor!=null&&scalpSum.profitFactor<0.8){
  const earlyNote=earlyTp?.trades?`조기익절 ${earlyTp.trades}건 승률 ${earlyTp.winRatePct}% (${money(earlyTp.netUSD)})`:`승률 ${scalpSum.winRatePct}%`;
  const manNote=manualExit?.trades?` vs 수동청산 ${manualExit.trades}건 ${money(manualExit.netUSD)} (평균 보유 ${Math.round(manualExit.avgHoldMin||0)}분)`:'';
  push('add','testnet','HIGH','scalp:max-hold-hard-stop',
   '테스트넷 단타에 최대 보유시간·강제 손절 컷 추가 필요',
   `${earlyNote}${manNote}로 소수의 장기 물림 포지션이 전체 수익을 잠식 중(PF ${scalpSum.profitFactor}, 평균 MAE ${scalpSum.avgMaeR??'—'}R). 무손절 물타기 대신 6~12시간 최대 보유 컷 또는 -25% ROE 하드스탑 추가를 강력 추천합니다.`);
 }else if(scalpSum.trades>=5&&scalpSum.avgHoldMin!=null&&scalpSum.avgHoldMin>=360){
  push('improve','testnet','MEDIUM','scalp:long-hold-time',
   `테스트넷 단타 평균 보유시간 과다 (${Math.round(scalpSum.avgHoldMin/60*10)/10}시간)`,
   `단타 전략인데 평균 보유시간이 ${scalpSum.avgHoldMin}분으로 길어 자금이 묶입니다. 시간 경과 청산(타임스탑) 도입을 검토하세요.`);
 }

 const skips=scalpRuntime?.skipCounts||{};
 if(Number(skips.UNRESOLVED_ORDER_STATE)>=3){
  push('improve','testnet','MEDIUM','scalp:unresolved-orders',
   `테스트넷 단타 미확정 주문(UNRESOLVED_ORDER_STATE) ${skips.UNRESOLVED_ORDER_STATE}회`,
   '주문 상태 확인 지연으로 스캔이 건너뛴 기록이 누적되었습니다. API 응답 지연 또는 추매 대기 상태 자동 정리 주기 단축을 점검하세요.');
 }
 if(testnetBudget&&testnetBudget.balanceError){
  push('improve','testnet','HIGH','testnet:balance-error',
   `테스트넷 잔고 조회 오류 (${testnetBudget.balanceError})`,
   'BingX 테스트넷 VST 잔고를 읽지 못해 신규 진입이 제한될 수 있습니다. API 키·네트워크 상태를 확인하세요.');
 }

 // ── 3) Feature & UI Hygiene (Add / Improve / Remove) ───────────────────
 if(accountAlerts?.positionSummaryAlerts&&Number(accountAlerts.positionSummaryIntervalMin)<=5){
  push('remove','ui','LOW','ui:pos-summary-frequency',
   `포지션 요약 알림 주기(${accountAlerts.positionSummaryIntervalMin}분) 정리 검토`,
   '5분 간격 반복 요약이 많게 느껴지면 "/pos 15" 또는 "/pos 30"으로 주기를 늘려 중요 체결·위험 경보에 집중할 수 있습니다.');
 }

 if(testnetScalpOnly&&!paperTrading&&Number(copyTestnetTrades)===0){
  push('remove','ui','LOW','ui:prune-unused-testnet-folds',
   '미사용 테스트넷 신호·모의매매 UI 영역 정리 후보',
   '현재 테스트넷 단타 전용(TESTNET_SCALP_ONLY) + 자동 모의매매 OFF + 테스트넷 카피 0건 상태입니다. 테스트넷 탭 하단의 "최근 진입 제외 사유"·"전체 주문 기록" 접힘 영역은 신호 전략용이므로 숨기거나 단타 전용으로 통합하면 UI가 더 깔끔해집니다.');
 }

 const grouped={
  add:items.filter(x=>x.category==='add').sort(rankSort),
  improve:items.filter(x=>x.category==='improve').sort(rankSort),
  remove:items.filter(x=>x.category==='remove').sort(rankSort),
 };

 return {
  generatedAt:now,
  day:kstDay(now),
  totals:{
   realTrades:realTradesTotal,
   scalpTrades:scalpSum.trades,
   allTrades:realTradesTotal+scalpSum.trades,
   itemCount:items.length,
   highCount:items.filter(x=>x.priority==='HIGH').length,
  },
  scoreboard:{
   realEquityUSD:fin(realEquityUSD)?r2(realEquityUSD):null,
   copy:copySum,
   manual:manualSum,
   scalp:{
    ...scalpSum,
    armed:Boolean(scalpRuntime?.armed),
    blocked:scalpRuntime?.blocked||null,
    capitalCapUSD:testnetBudget?.capitalCapUSD??null,
    dailyLossPct:testnetBudget?.dailyLossPct??null,
   },
  },
  add:grouped.add,
  improve:grouped.improve,
  remove:grouped.remove,
  items:[...grouped.add,...grouped.improve,...grouped.remove],
 };
}

/** Format the advisor output into a clean, concise Korean Telegram message. */
export function formatAdvisorTelegram(advice,{mode='daily',onlyItems=null}={}){
 if(!advice)return '';
 const sc=advice.scoreboard||{};
 const header=mode==='realtime'
  ?`⚡ [Signal Lab 실시간 개선 감지] ${advice.day} KST`
  :mode==='ondemand'
   ?`🧭 [Signal Lab 실시간 매매·UI 개선 코치] ${advice.day} KST`
   :`🧭 [Signal Lab 매일 매매·UI 개선 코치] ${advice.day} KST`;

 const lines=[header];
 const cp=sc.copy,man=sc.manual,sp=sc.scalp;
 if(mode!=='realtime'){
  lines.push(
   `실계좌 카피: ${cp?.trades||0}건${cp?.trades?` · 승률 ${cp.winRatePct}% · ${money(cp.netUSD)} (MDD $${cp.maxDrawdownUSD})`:''}`,
   `실계좌 수동: ${man?.trades||0}건${man?.trades?` · 승률 ${man.winRatePct}% · ${money(man.netUSD)} (MDD $${man.maxDrawdownUSD})`:''}`,
   `테스트넷 단타: ${sp?.trades||0}건${sp?.trades?` · 승률 ${sp.winRatePct}% · PF ${sp.profitFactor??'—'}`:''}${sp?.blocked?` · ⛔ ${sp.blocked}`:sp?.armed?' · ● 감시 중':''}`
  );
 }

 const pick=cat=>{
  const src=Array.isArray(onlyItems)?onlyItems.filter(x=>x.category===cat):(advice[cat]||[]);
  return src.slice(0,4);
 };
 const section=(emoji,label,list)=>{
  if(!list.length)return;
  lines.push('',`${emoji} ${label}`);
  for(const item of list){
   const tag=item.priority==='HIGH'?'[중요] ':'';
   lines.push(`· ${tag}${item.title}`,`  └ ${item.detail}`);
  }
 };

 section('➕','추가 추천',pick('add'));
 section('🔧','개선 추천',pick('improve'));
 section('🗑','삭제·정리 추천',pick('remove'));

 if(!pick('add').length&&!pick('improve').length&&!pick('remove').length){
  lines.push('','✅ 현재 매매 기록과 설정에서 눈에 띄는 개선·정리 항목이 없습니다.');
 }

 if(mode!=='realtime'){
  lines.push('','💬 언제든 /coach 로 최신 분석 조회 · 매일 자동 발송');
 }
 return lines.join('\n').slice(0,3900);
}

/** Persistent scheduler for daily coaching digest + deduplicated real-time HIGH alerts. */
export class DailyAdvisor{
 constructor({directory=null,fileName='daily-advisor.json',now=()=>Date.now(),sendText=async()=>({ok:false}),log=()=>{}}={}){
  Object.assign(this,{now,sendText,log});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={
   enabled:saved?.enabled!==false,
   dailyHourKst:Number.isInteger(saved?.dailyHourKst)&&saved.dailyHourKst>=0&&saved.dailyHourKst<=23?saved.dailyHourKst:DAILY_ADVISOR_DEFAULTS.dailyHourKst,
   realtimeAlerts:saved?.realtimeAlerts!==false,
   lastDailyDay:typeof saved?.lastDailyDay==='string'?saved.lastDailyDay:null,
   seenRealtime:saved?.seenRealtime&&typeof saved.seenRealtime==='object'&&!Array.isArray(saved.seenRealtime)?saved.seenRealtime:{},
   baselineInitialized:saved?.baselineInitialized===true,
  };
 }

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store});
 }

 status(){
  return {
   enabled:this.store.enabled,
   dailyHourKst:this.store.dailyHourKst,
   realtimeAlerts:this.store.realtimeAlerts,
   lastDailyDay:this.store.lastDailyDay,
  };
 }

 configure(patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Object.assign(Error('JSON object required'),{code:'INVALID_ADVISOR_CONFIG',httpStatus:400});
  const next={...this.store};
  if(Object.hasOwn(patch,'enabled')){
   if(typeof patch.enabled!=='boolean')throw Object.assign(Error('enabled must be boolean'),{code:'INVALID_ADVISOR_CONFIG',httpStatus:400});
   next.enabled=patch.enabled;
  }
  if(Object.hasOwn(patch,'realtimeAlerts')){
   if(typeof patch.realtimeAlerts!=='boolean')throw Object.assign(Error('realtimeAlerts must be boolean'),{code:'INVALID_ADVISOR_CONFIG',httpStatus:400});
   next.realtimeAlerts=patch.realtimeAlerts;
  }
  if(Object.hasOwn(patch,'dailyHourKst')){
   const h=Math.round(Number(patch.dailyHourKst));
   if(!Number.isInteger(h)||h<0||h>23)throw Object.assign(Error('dailyHourKst must be 0..23'),{code:'INVALID_ADVISOR_CONFIG',httpStatus:400});
   next.dailyHourKst=h;
  }
  this.store=next;
  this.#save();
  return this.status();
 }

 /** Daily coaching digest at dailyHourKst (default 09:00 KST). Silent on empty fresh sandboxes. */
 async checkDaily(ctx={}){
  if(!this.store.enabled)return {sent:false,reason:'DISABLED'};
  const t=Number(ctx.now)||this.now();
  const day=kstDay(t),hour=kstHour(t);
  const advice=buildImprovementAdvice({...ctx,now:t});
  if(this.store.lastDailyDay===day)return {sent:false,reason:'ALREADY_SENT'};
  // Silent init on empty fresh sandbox (no trades yet)
  if(advice.totals.allTrades===0){
   if(this.store.lastDailyDay===null){this.store.lastDailyDay=day;this.#save()}
   return {sent:false,reason:'NO_DATA'};
  }
  if(hour<this.store.dailyHourKst)return {sent:false,reason:'BEFORE_HOUR'};
  const text=formatAdvisorTelegram(advice,{mode:'daily'});
  await this.sendText(text);
  this.store.lastDailyDay=day;
  // Also mark currently reported HIGH items as seen so realtime doesn't echo right after daily digest
  for(const item of advice.items.filter(x=>x.priority==='HIGH'))this.store.seenRealtime[item.id]=t;
  this.store.baselineInitialized=true;
  this.#save();
  return {sent:true,day,text,advice};
 }

 /** Real-time push for newly emerging HIGH-priority trading/system issues (24h dedup per id). */
 async checkRealtime(ctx={}){
  if(!this.store.enabled||!this.store.realtimeAlerts)return {sent:false,reason:'DISABLED'};
  const t=Number(ctx.now)||this.now();
  const advice=buildImprovementAdvice({...ctx,now:t});
  if(advice.totals.allTrades===0)return {sent:false,reason:'NO_DATA'};
  const highs=advice.items.filter(x=>x.priority==='HIGH');
  if(!this.store.baselineInitialized){
   for(const item of highs)this.store.seenRealtime[item.id]=t;
   this.store.baselineInitialized=true;
   this.#save();
   return {sent:false,reason:'BASELINE_INITIALIZED'};
  }
  const fresh=highs.filter(item=>{
   const prev=Number(this.store.seenRealtime[item.id])||0;
   return t-prev>=REALTIME_COOLDOWN_MS;
  });
  if(!fresh.length)return {sent:false,reason:'NO_NEW_HIGH'};
  const text=formatAdvisorTelegram(advice,{mode:'realtime',onlyItems:fresh});
  await this.sendText(text);
  for(const item of fresh)this.store.seenRealtime[item.id]=t;
  // Prune old entries (>7 days)
  for(const [k,v] of Object.entries(this.store.seenRealtime))if(t-Number(v)>7*86400000)delete this.store.seenRealtime[k];
  this.#save();
  return {sent:true,count:fresh.length,text,items:fresh};
 }

 /** Immediate on-demand Telegram send. */
 async sendNow(ctx={}){
  const t=Number(ctx.now)||this.now();
  const advice=buildImprovementAdvice({...ctx,now:t});
  const text=formatAdvisorTelegram(advice,{mode:'ondemand'});
  await this.sendText(text);
  return {sent:true,text,advice};
 }
}
