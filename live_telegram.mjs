import {tradeHorizon,holdTier} from './trade_horizon.mjs';
// Telegram notices for live (testnet) trades: entry with protection, add fills, first target and
// break-even, the settled close with its result, and order problems. Text only: symbol, side,
// prices and results — never keys, order ids or account numbers.
const SIDE={LONG:'롱',SHORT:'숏'};
const MODE={TESTNET:'테스트넷',LIVE:'신호 전략'};
const fmt=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2):'—'};
const tradeAmount=new Intl.NumberFormat('en-US',{maximumFractionDigits:12});
const observedTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const amount=v=>v==null||!Number.isFinite(Number(v))?'—':tradeAmount.format(Number(v));
const MANUAL_ACTION={MANUAL_OPEN:'신규 진입',MANUAL_ADD:'추가 진입',MANUAL_REDUCE:'부분',MANUAL_SETTLED:'전량'};
const REAL_ORIGIN={MANUAL:'수동',SIGNAL:'자동 신호'};
const RULE='━━━━━━━━━━━━━━━━';
const tradeSide={SHORT:'🔴 숏',LONG:'🟢 롱'};
const priceLine=v=>Number.isFinite(v)&&v>0?`${amount(v)} USDT`:'—';
const signed=v=>v===0?'':v>0?'+':'−';
const marginAmount=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:8});
function fillMarginText(fill,qty,leverage){
 const [price,size,multiple]=[fill,qty,leverage].map(Number);
 if(![price,size,multiple].every(v=>Number.isFinite(v)&&v>0))return '증거금 —';
 return `증거금 약 ${marginAmount.format(price*size/multiple)} USDT`;
}

function copyTradeMessage(e,action,closing,at,available){
 const lines=[],entities=[];
 let offset=0;
 // Telegram counts offsets in UTF-16, the same units as JavaScript string lengths.
 const line=(before,bold='',after='')=>{
  if(bold)entities.push({type:'bold',offset:offset+before.length,length:bold.length});
  const text=before+bold+after;lines.push(text);offset+=text.length+1;
 };
 const add=e.type==='MANUAL_ADD',fill=e.fillPrice??e.avg,qty=e.size??Math.abs(Number(e.to)-Number(e.from));
 const icon=e.netUSD>0?'🎯':e.netUSD<0?'🛑':'⚪';
 line('',closing?`${icon} ${action}`:add?'➕ 포지션 추매':'📌 포지션 진입');
 line(RULE);
 const side=[tradeSide[e.direction],e.leverage>0?`×${e.leverage}`:null].filter(Boolean).join('  ');
 line('',e.symbol,side?`  ${side}`:'');
 line(RULE);
 if(closing){
  // USDT perpetuals realize gross PnL on the closed quantity at the fill price.
  // Recover its entry cost without using a later position average after another add.
  const direction=e.direction==='LONG'?1:e.direction==='SHORT'?-1:0;
  const entry=direction&&fill>0&&qty>0&&Number.isFinite(e.pnlUSD)?fill-direction*e.pnlUSD/qty:null;
  const margin=entry>0&&e.leverage>0?entry*qty/e.leverage:null;
  const roi=margin>0?e.netUSD/margin*100:null;
  const value=Math.abs(e.netUSD),result=value>0&&value<.01?amount(value):value.toFixed(2);
  line('진입가 ',priceLine(entry));
  line(`청산가 ${priceLine(fill)}`);
  line(`청산 수량 ${amount(qty)}${e.type==='MANUAL_REDUCE'&&e.to!=null?` · 잔여 ${amount(e.to)}`:''}`);
  const percent=Number.isFinite(roi)?`${signed(roi)}${Math.abs(roi).toFixed(2)}%`:'수익률 —';
  line('손익 ',`${signed(e.netUSD)}${result} USDT (${percent})`);
 }else{
  line(add?'추매가 ':'진입가 ',priceLine(fill));
  line(`현재가 ${priceLine(fill)}`);
  line(`수량 ${add?'+':''}${amount(qty)}${add&&e.to!=null?` · 잔여 ${amount(e.to)}`:''}`);
  line(fillMarginText(fill,qty,e.leverage));
 }
 line(available);
 if(at>0&&Number.isFinite(at))line(`체결 ${observedTime.format(at)} KST`);
 return {text:lines.join('\n'),entities};
}

/** Message for a confirmed real-account change from the manual ledger. */
export function realTradeMessage(e,{availableMargin=null}={}){
 const actionBase=MANUAL_ACTION[e?.type];
 if(!actionBase||!e.symbol||e.fromFills!==true)return null;
 const closing=e.type==='MANUAL_REDUCE'||e.type==='MANUAL_SETTLED';
 const net=e.netUSD;
 if(closing&&(e.netSource!=='EXCHANGE_FILLS'||!Number.isFinite(net)))return null;
 const action=closing?`${actionBase} ${net===0?'본전':net>0?'익절':'손절'}`:actionBase;
 const at=Number(e.observedAt??e.at);
 const available=`가용 증거금 ${Number.isFinite(availableMargin)&&availableMargin>=0?`${marginAmount.format(availableMargin)} USDT`:'조회 불가'}`;
 if(e.alertOrigin==='COPY')return copyTradeMessage(e,action,closing,at,available);
 const head=[`${REAL_ORIGIN[e.alertOrigin]??REAL_ORIGIN.MANUAL} | ${action}`,[e.symbol,tradeSide[e.direction],e.leverage>0?`${e.leverage}배`:null].filter(Boolean).join(' · ')];
 let detail;
 if(e.type==='MANUAL_OPEN')detail=`수량 ${amount(e.size)} · 평균 진입가 ${amount(e.avg)} USDT`;
 else if(closing){
  const size=e.size??(Number(e.from)-Number(e.to));
  const result=net===0?'$0.00':Math.abs(net)<.01?`${net>0?'+':'−'}$${amount(Math.abs(net))}`:usd(net);
  detail=[`청산 수량 ${amount(size)}${e.type==='MANUAL_REDUCE'?` · 잔여 ${amount(e.to)}`:''}`,
   `순손익 ${result} (거래소 체결 · 수수료 포함, 펀딩 제외)`].join('\n');
 }else{
  const change=e.size??(Number(e.to)-Number(e.from));
  detail=`수량 +${amount(change)}${e.to!=null?` · 잔여 ${amount(e.to)}`:''}`;
  if(e.type==='MANUAL_ADD'&&e.avg!=null)detail+=`\n추가 체결가 ${amount(e.avg)} USDT`;
 }
 const margin=closing?null:fillMarginText(e.fillPrice??e.avg,e.size??(Number(e.to)-Number(e.from)),e.leverage);
 return {text:[...head,detail,margin,available,at>0&&Number.isFinite(at)?`체결 ${observedTime.format(at)} KST`:null].filter(Boolean).join('\n'),
  entities:[{type:'bold',offset:0,length:head[0].length}]};
}
export function realTradeText(e){return realTradeMessage(e)?.text??null}
export {realTradeText as manualTradeText};
const PROBLEM={ENTRY_OUTCOME_UNKNOWN:'진입 결과를 확인하지 못했습니다',STOP_FAILED:'손절 주문 등록 실패',TARGET_FAILED:'목표 주문 등록 실패',
 EMERGENCY_CLOSED:'보호 주문 실패로 긴급 청산했습니다',LATE_ADD_CLOSE_FAILED:'청산 뒤 체결된 추매 정리 실패',EMERGENCY_CLOSE_FAILED:'긴급 청산 실패 · 즉시 확인 필요',ERROR:'주문 처리 오류 · 긴급 정지',RECOVERY_ERROR:'재시작 후 손절 보호 복구 실패',RECOVERY_MANUAL:'재시작으로 끊긴 진입 · 자동 복구 불가(Gate.io) · 긴급 정지',LATE_ADD_CLOSED:'청산 뒤 체결된 추매를 정리했습니다',TEST_CLOSE_INCOMPLETE:'시험 주문 정리 미완료',STOP_WHOLE_FAILED:'전체 손절 주문 갱신 실패',REJECTED:'주문이 거부됐습니다'};

/** Message for one executor event, or null when it is not worth a notice. */
export function liveEventText(r,type,detail={}){
 if(!r)return null;
 if(type==='KILL_SWITCH')return `⛔ 긴급 정지 · ${MODE[r.mode]||r.mode||''}\n새 주문을 멈췄습니다 (${detail.reason||'수동'}). 실매매 화면에서 확인 후 해제하세요.`;
 const side=(r.mode==='LIVE'?tradeSide:SIDE)[r.direction]||r.direction||'';
 const head=`${r.symbol} ${side}${tradeHorizon(r.signal?.pattern)?' ['+tradeHorizon(r.signal?.pattern).label+']':''} ${r.leverage?r.leverage+'배':''} · ${MODE[r.mode]||r.mode||''}`.replace(/\s+/g,' ').trim();
 const hz=tradeHorizon(r.signal?.pattern),pattern=r.signal?.pattern?`\n패턴: ${r.signal.pattern}${r.signal.score!=null?` (${r.signal.score}점)`:''}${hz?` · ${hz.label} 예상 (${hz.hint})`:''}`:'';
 // Test orders (signalKey TEST:…, marked test after the fill): problems only.
 if(r.test===true||String(r.signalKey||'').startsWith('TEST:'))return PROBLEM[type]?`⚠️ 시험 주문 문제 · ${head}\n${PROBLEM[type]}${detail.reason?` (${detail.reason})`:''}`:null;
 if(type==='PROTECTED'){
  const entry=r.firstEntryPrice??r.plannedEntry,adds=(r.adds||[]).length;
  return `🟢 진입 · ${head}\n진입가 ${fmt(entry)} · 손절 ${fmt(r.stop)}\n목표 ${(r.targets||[]).map(fmt).join(' / ')||'—'}${adds?`\n대기 추매 ${adds}개`:''}${pattern}`;
 }
 if(type==='ADD_FILLED'){const n=(r.adds||[]).filter(a=>a.filled).length;if(!n)return null; // partial fill: the notice comes when it completes
  return `➕ 추매 ${n}차 체결 · ${head}\n평균 진입가 ${fmt(r.position?.entryPrice)} · 손절 ${fmt(r.stop)}`}
 if(type==='PARTIAL_EXIT'&&r.mode==='TESTNET')return `🎯 부분 청산 · ${head}\n청산 수량 ${amount(detail.qty)} · 잔여 ${amount(detail.left)}`;
 if(type==='PROTECTION_RECOVERED')return `🛡 손절 보호 복구 · ${head}\n서버 재시작으로 끊긴 진입을 거래소에서 확인했습니다. 손절 ${fmt(r.stop)} ${detail.reason==='STOP_FOUND'?'주문이 걸려 있습니다':'주문을 다시 걸었습니다'}.`;
 if(type==='STOP_TO_BREAKEVEN')return `🎯 1차 목표 도달 · ${head}\n손절을 진입가(${fmt(r.stop)})로 올렸습니다. 남은 물량은 손실 없이 관리됩니다.`;
 if(type==='SETTLED'){
  const net=r.realized?.netUSD,hold=r.closedAt&&r.createdAt?(r.closedAt-r.createdAt)/3600000:null;
  return `${Number(net)>0?'✅ 수익 마감':Number(net)<0?'🔻 손실 마감':'⚪ 본전 마감'} · ${head}\n실현 손익 ${usd(net)} (수수료 포함${r.realized?.source==='ESTIMATE'?', 추정':''})${hold!==null?` · 보유 ${hold<1?Math.max(1,Math.round(hold*60))+'분':hold<24?hold.toFixed(1)+'시간':(hold/24).toFixed(1)+'일'} (${holdTier(hold).label})`:''}${pattern}\n원인 분석은 매매일지에 자동 기록됩니다.`;
 }
 if(PROBLEM[type])return `⚠️ 주문 문제 · ${head}\n${PROBLEM[type]}${detail.reason?` (${detail.reason})`:''}\n실매매 화면에서 확인해 주세요.`;
 return null;
}
