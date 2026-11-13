import {tradeHorizon,holdTier} from './trade_horizon.mjs';
// Telegram notices for live (testnet) trades: entry with protection, add fills, first target and
// break-even, the settled close with its result, and order problems. Text only: symbol, side,
// prices and results — never keys, order ids or account numbers.
const SIDE={LONG:'롱',SHORT:'숏'};
const MODE={TESTNET:'테스트넷',LIVE:'실제 돈'};
const fmt=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2):'—'};
const PROBLEM={ENTRY_OUTCOME_UNKNOWN:'진입 결과를 확인하지 못했습니다',STOP_FAILED:'손절 주문 등록 실패',TARGET_FAILED:'목표 주문 등록 실패',
 EMERGENCY_CLOSED:'보호 주문 실패로 긴급 청산했습니다',LATE_ADD_CLOSE_FAILED:'청산 뒤 체결된 추매 정리 실패',EMERGENCY_CLOSE_FAILED:'긴급 청산 실패 · 즉시 확인 필요',ERROR:'주문 처리 오류 · 긴급 정지',RECOVERY_ERROR:'재시작 후 손절 보호 복구 실패',RECOVERY_MANUAL:'재시작으로 끊긴 진입 · 자동 복구 불가(Gate.io) · 긴급 정지',LATE_ADD_CLOSED:'청산 뒤 체결된 추매를 정리했습니다',TEST_CLOSE_INCOMPLETE:'시험 주문 정리 미완료',STOP_WHOLE_FAILED:'전체 손절 주문 갱신 실패',REJECTED:'주문이 거부됐습니다'};

/** Message for one executor event, or null when it is not worth a notice. */
export function liveEventText(r,type,detail={}){
 if(!r)return null;
 if(type==='KILL_SWITCH')return `⛔ 긴급 정지 · ${MODE[r.mode]||r.mode||''}\n새 주문을 멈췄습니다 (${detail.reason||'수동'}). 실매매 화면에서 확인 후 해제하세요.`;
 const head=`${r.symbol} ${SIDE[r.direction]||r.direction||''}${tradeHorizon(r.signal?.pattern)?' ['+tradeHorizon(r.signal?.pattern).label+']':''} ${r.leverage?r.leverage+'배':''} · ${MODE[r.mode]||r.mode||''}`.replace(/\s+/g,' ').trim();
 const hz=tradeHorizon(r.signal?.pattern),pattern=r.signal?.pattern?`\n패턴: ${r.signal.pattern}${r.signal.score!=null?` (${r.signal.score}점)`:''}${hz?` · ${hz.label} 예상 (${hz.hint})`:''}`:'';
 // Test orders (signalKey TEST:…, marked test after the fill): problems only.
 if(r.test===true||String(r.signalKey||'').startsWith('TEST:'))return PROBLEM[type]?`⚠️ 시험 주문 문제 · ${head}\n${PROBLEM[type]}${detail.reason?` (${detail.reason})`:''}`:null;
 if(type==='PROTECTED'){
  const entry=r.firstEntryPrice??r.plannedEntry,adds=(r.adds||[]).length;
  return `🟢 진입 · ${head}\n진입가 ${fmt(entry)} · 손절 ${fmt(r.stop)}\n목표 ${(r.targets||[]).map(fmt).join(' / ')||'—'}${adds?`\n대기 추매 ${adds}개`:''}${pattern}`;
 }
 if(type==='ADD_FILLED'){const n=(r.adds||[]).filter(a=>a.filled).length;if(!n)return null; // partial fill: the notice comes when it completes
  return `➕ 추매 ${n}차 체결 · ${head}\n평균 진입가 ${fmt(r.position?.entryPrice)} · 손절 ${fmt(r.stop)}`}
 if(type==='PROTECTION_RECOVERED')return `🛡 손절 보호 복구 · ${head}\n서버 재시작으로 끊긴 진입을 거래소에서 확인했습니다. 손절 ${fmt(r.stop)} ${detail.reason==='STOP_FOUND'?'주문이 걸려 있습니다':'주문을 다시 걸었습니다'}.`;
 if(type==='STOP_TO_BREAKEVEN')return `🎯 1차 목표 도달 · ${head}\n손절을 진입가(${fmt(r.stop)})로 올렸습니다. 남은 물량은 손실 없이 관리됩니다.`;
 if(type==='SETTLED'){
  const net=r.realized?.netUSD,hold=r.closedAt&&r.createdAt?(r.closedAt-r.createdAt)/3600000:null;
  return `${Number(net)>0?'✅ 수익 마감':Number(net)<0?'🔻 손실 마감':'⚪ 본전 마감'} · ${head}\n실현 손익 ${usd(net)} (수수료 포함${r.realized?.source==='ESTIMATE'?', 추정':''})${hold!==null?` · 보유 ${hold<1?Math.max(1,Math.round(hold*60))+'분':hold<24?hold.toFixed(1)+'시간':(hold/24).toFixed(1)+'일'} (${holdTier(hold).label})`:''}${pattern}\n원인 분석은 매매일지에 자동 기록됩니다.`;
 }
 if(PROBLEM[type])return `⚠️ 주문 문제 · ${head}\n${PROBLEM[type]}${detail.reason?` (${detail.reason})`:''}\n실매매 화면에서 확인해 주세요.`;
 return null;
}
