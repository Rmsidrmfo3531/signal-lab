// Telegram / screen notices for the testnet reversal scalp ledger (scalp_executor.mjs events), and the
// Korean labels of its skip and close reasons. Entries, closes, the first target and problems only:
// nothing per scan. Text only: symbol, prices and results — never keys or order ids.
import {REASON_ALIASES,REASON_CODES,reasonLabel,ladderStepText} from './public/scalp_reasons.js';
export const SCALP_LABEL='[되돌림 단타·테스트넷]';
export const SCALP_LIVE_LABEL='[되돌림 단타·실계좌]';
// Korean labels: the shared glossary (public/scalp_reasons.js, the same short labels the #live screen shows).
export const SCALP_REASON_KO=Object.freeze(Object.fromEntries([...REASON_CODES,...Object.keys(REASON_ALIASES)].map(c=>[c,reasonLabel(c)])));
export const scalpReasonKo=r=>r?reasonLabel(r):'';
const fmt=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2):'—'};
const SIDE={LONG:'롱',SHORT:'숏'},side=e=>SIDE[e?.direction]||'롱';
const zoneText=z=>z?.tf?` — ${String(z.tf).toUpperCase()} 매물대 ${fmt(z.low)}~${fmt(z.high)}${Number(z.distPct)>0?` (${Number(z.distPct).toFixed(2)}% 거리)`:''}`:'';
/** Kind label: 급변 (5 % move) / 매물대 (2.5 % at a 4H / 1D volume zone). */
export const scalpKindKo=k=>k==='ZONE_REVERSAL'?'매물대':'급변';
const mins=ms=>Number.isFinite(ms)?Math.max(1,Math.round(ms/60000))+'분':'—';

/** Text for one scalp event, or null when it is not worth a notice. */
export function scalpEventText(e){
 if(!e)return null;
 const isLive=e.mode==='LIVE',label=isLive?SCALP_LIVE_LABEL:SCALP_LABEL;
 const head=`${label} ${e.symbol||''}`.trim();
 if(e.type==='ARMED')return `${label} 활성화 — 5분봉 급락 후 반등 롱·급등 후 되돌림 숏을 ${isLive?'실계좌':'테스트넷'}에서 주문합니다.`;
 if(e.type==='DISARMED')return ['DAILY_LOSS_LIMIT','NO_PROTECTIVE_STOP'].includes(e.reason)?null:`${label} 비활성화`;
 if(e.type==='OPENED'){
  const tierPart=Number.isFinite(Number(e.scoreTierMult))&&Math.abs(Number(e.scoreTierMult)-1)>1e-4?` · 점수배수 ${e.scoreTierMult}x`:'';
  const scorePart=Number.isFinite(Number(e.score))?` · 점수 ${e.score}점(${e.grade||''}급${Number.isFinite(Number(e.sizeMult))&&Math.abs(Number(e.sizeMult)-1)>1e-4?` · 비중 ${e.sizeMult}x`:''}${tierPart})`:'';
  const sessPart=e.sessionLabel&&Number.isFinite(Number(e.sessionMult))&&Math.abs(Number(e.sessionMult)-1)>1e-4?` · ${e.sessionLabel} ${e.sessionMult}x`:'';
  const ofPart=e.orderflowSummary?` · 수급 ${e.orderflowSummary}`:'';
  const execPart=e.executionMode==='MAKER'?' · 메이커 체결':e.executionMode==='MAKER+MARKET'?' · 메이커+시장가':'';
  const stopText=e.stopLossEnabled===false
   ?(Number(e.hardStopPrice)>0?`거래소 비상스탑 ${fmt(e.hardStopPrice)} · 한도 계산 위험`:'자동 손절 없음 · 한도 계산 위험')
   :`손절 ${fmt(e.stop)} · 위험`;
  // 카피식 추매 (TRADER_LADDER, user 2026-11-24): the ladder instead of stop / targets.
  if(e.management==='TRADER_LADDER'&&e.ladder){
   const L=e.ladder;
   return `🟢 ${head} ${side(e)} ${e.leverage}배 진입 · 카피식 추매${e.trigger==='PUMP_ALERT'?' · 급변 알림':''}${e.kind==='ZONE_REVERSAL'?` · 매물대 반전(4H/1D)${zoneText(e.zone)}`:''}\n${ladderStepText(L,{fmt})}\n사다리 ${(L.units||[]).join('·')}단위 · 1단위 $${Number(L.unitMarginUSD||0).toFixed(2)} · 간격 ${L.spacingPct}% · 예약 증거금 $${Number(L.reserveMarginUSD||0).toFixed(2)}\n익절 ${fmt(L.tpPrice)} (평단 +${L.tpNetPct}% 수수료 뺀) · 마지막 선 −${L.finalLineRoePct}% ROE · 최대 ${Math.round((Number(L.maxHoldMin)||0)/60)}시간\n${e.direction==='SHORT'?'급등':'급락'} ${e.movePct??'—'}% · 거래량 ${e.volumeX??'—'}배${scorePart}${sessPart}${ofPart}${execPart}`;
  }
  return `🟢 ${head} ${side(e)} ${e.leverage}배 진입${e.trigger==='PUMP_ALERT'?' · 급변 알림':''}${e.kind==='ZONE_REVERSAL'?` · 매물대 반전(4H/1D)${zoneText(e.zone)}`:''}\n진입 ${fmt(e.entry)} · ${stopText} $${e.riskUSD}\n목표 ${(e.targets||[]).map((t,i)=>e.parts?.[i]>0?fmt(t):null).filter(Boolean).join(' / ')}${e.merged?' (최소 주문 때문에 목표 합침)':''}\n${e.direction==='SHORT'?'급등':'급락'} ${e.movePct??'—'}% · 거래량 ${e.volumeX??'—'}배${scorePart}${sessPart}${ofPart}${execPart}`;
 }
 if(e.type==='LADDER_ADD'&&e.qty>0){
  const z=e.zone?` · 강한 매물대 2배 (${(e.zone.why||[]).map(c=>scalpReasonKo(c)).join('·')})`:'';
  const view={step:e.step,of:e.of,avg:e.avg,nextAdd:e.nextAdd>0?{price:e.nextAdd}:null};
  return `➕ ${head} ${side(e)} 카피식 추매 ${e.step}/${e.of}단계${z}${e.adopted?' · 늦게 확인된 체결':''}\n수량 +${fmt(e.qty)} · 체결가 ${fmt(e.price)} · 평단 ${fmt(e.prevAvg)} → ${fmt(e.avg)}\n${ladderStepText(view,{fmt})} · 익절 ${fmt(e.tpPrice)}`;
 }
 if(e.type==='STOP_TO_BREAKEVEN')return `🎯 ${head} ${side(e)} 1차 목표 도달 · 손절을 진입가 ${fmt(e.price)}로 올림`;
 if(e.type==='SCALE_IN_FILLED'&&e.qty>0){
  const avgLine=Number(e.prevAvg)>0&&Number(e.avg)>0?`\n평단 ${fmt(e.prevAvg)} → ${fmt(e.avg)}${Number(e.avgImprovePct)>0?` (${Number(e.avgImprovePct).toFixed(2)}% 개선)`:''}`:'';
  const defTag=e.defensive?`${Number.isFinite(Number(e.defensiveRoePct))?` (${Number(e.defensiveRoePct).toFixed(1)}% ROE 방어)`:' (ROE 방어)'}`:'';
  return `${e.defensive?'🛡️':'➕'} ${head} ${side(e)} ${e.defensive?'방어 추매':'추가 진입'}${e.count>0?` ${e.count}회차`:''}${defTag}\n수량 +${fmt(e.qty)} · 체결가 ${fmt(e.price)} · 잔여 ${fmt(e.left)}${avgLine}`;
 }
 if(e.type==='PARTIAL_TAKE_PROFIT'&&e.qty>0){
  const takePct=Number.isFinite(Number(e.takePct))&&Number(e.takePct)>0?Math.round(Number(e.takePct)):50;
  const roePart=Number.isFinite(Number(e.netRoePct))?`현재 ROE ${Number(e.netRoePct)>=0?'+':''}${Number(e.netRoePct).toFixed(1)}%`:'';
  const estPart=Number.isFinite(Number(e.estProfitUSD))?`추정 수익 ${usd(e.estProfitUSD)}`:'';
  const extra=[roePart,estPart].filter(Boolean).join(' · ');
  return `💰 ${head} ${side(e)} ${takePct}% 부분 익절 확정\n청산 ${fmt(e.qty)} · 잔여 ${fmt(e.left)} (러너 트레일링 중)${extra?`\n${extra}`:''}`;
 }
 if(e.type==='PARTIAL_EXIT')return `🎯 ${head} ${side(e)} 부분 청산\n청산 수량 ${fmt(e.qty)} · 잔여 ${fmt(e.left)}`;
 if(e.type==='CLOSED'){
  const trailPart=Number(e.peakRoePct)>0?` (트레일링 고점 +${Number(e.peakRoePct).toFixed(1)}%)`:'';
  const scorePart=Number.isFinite(Number(e.score))?` · ${e.score}점(${e.grade||''}급)`:'';
  const roePart=Number.isFinite(Number(e.roePct))?` (${Number(e.roePct)>=0?'+':''}${Number(e.roePct).toFixed(1)}% ROE)`:'';
  const addPart=e.management==='TRADER_LADDER'&&Number(e.of)>0?` · 카피식 추매 ${e.step}/${e.of}단계`:Number.isFinite(Number(e.adds))?` · 추매 ${Number(e.adds)}회`:'';
  return `${Number(e.netUSD)>0?'✅':Number(e.netUSD)<0?'🔻':'⚪'} ${head} ${side(e)} 청산 · ${scalpReasonKo(e.reason)}${trailPart}${scorePart}\n손익 ${usd(e.netUSD)}${roePart} (수수료 포함 추정) · 목표 ${e.tp||0}개${addPart} · 보유 ${mins(e.holdMs)}`;
 }
 if(e.type==='DAILY_LOSS_LIMIT')return e.shared?`⛔ [테스트넷] 하루 손실 한도 도달 (신호+단타 ${usd(e.lossUSD)})\n오늘(한국 시간)은 신호 전략·단타 모두 신규 진입과 추매를 멈췄습니다.`
  :`⛔ ${label} 하루 손실 한도 도달 (${usd(e.lossUSD)})\n오늘은 신규 진입과 추매를 멈췄습니다.`;
 if(['STOP_FAILED','EMERGENCY_CLOSE_FAILED','ENTRY_OUTCOME_UNKNOWN'].includes(e.type))return `⚠️ ${head} ${e.type==='STOP_FAILED'?'손절 주문 실패 — 긴급 청산':e.type==='ENTRY_OUTCOME_UNKNOWN'?'진입 결과 확인 안 됨 — 새 진입 멈춤':'긴급 청산 실패 — 즉시 확인 필요'}${e.reason?` (${scalpReasonKo(e.reason)})`:''}`;
 return null;
}
