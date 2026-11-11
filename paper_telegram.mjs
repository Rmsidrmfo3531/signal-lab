// Telegram text for paper (simulated) entries and closes, so the phone gets them while away from
// the PC. Plain text (no parse mode), clearly marked as simulation. No keys or account data.
const VENUE={BINANCE:'바이낸스',GATEIO:'Gate.io',BINGX:'BingX'};
const STRATEGY={HOURLY_1H:'1시간봉',SCALP_REVERSAL_1M:'1분 단타',SCALP_REVERSAL_5M:'5분 단타',SCALP_REVERSAL_15M:'15분 단타'};
const n=(v,d=6)=>{const x=Number(v);if(!Number.isFinite(x))return '-';const a=Math.abs(x);return x.toFixed(a>=1000?2:a>=1?4:d).replace(/\.?0+$/,'')};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'-')+'$'+Math.abs(x).toFixed(2):'-'};
const minutes=ms=>{const m=Math.max(0,Math.round(ms/60000));return m>=60?`${Math.floor(m/60)}시간 ${m%60}분`:`${m}분`};
function closeReason(event,record){
 if(event.closeReason==='ALL_TARGETS')return '목표가 모두 도달';
 if(event.closeReason==='TIME_STOP')return '보유 시간 초과(시간 청산)';
 if(event.closeReason==='STOP')return record?.closeParts?.some(p=>p.type==='TARGET')?(record?.breakevenMoved?'익절 후 본절 손절':'익절 후 잔여 손절'):'손절';
 return String(event.closeReason||'청산');
}
/** event: paper OPEN / CLOSE event; record: the paper position (optional); totals: {pnl, closed} (optional). */
export function paperTelegramText(event,record=null,{totals=null,test=false}={}){
 const r=record||{},side=event.direction==='LONG'?'롱':'숏',strategy=STRATEGY[r.strategy||'HOURLY_1H']||r.strategy||'1시간봉';
 const tag=test?'[테스트] ':'',chart=VENUE[r.chartVenue||'BINANCE']||r.chartVenue,venue=VENUE[r.executionVenue]||r.executionVenue||'-';
 if(event.type==='OPEN'){
  const targets=Array.isArray(r.targets)&&r.targets.length?r.targets.map(t=>n(t)).join(' / '):'-';
  return [`🟢 ${tag}[모의 진입] ${event.symbol} ${side}`,
   `${strategy} · ${r.pattern||'-'}${Number.isFinite(r.score)?` · ${r.score}점`:''}`,
   `진입 ${n(event.entryFill)} · 손절 ${n(event.stop??r.stop)}`,`목표 ${targets}`,
   `금액 $${Number(event.notionalUSD||0).toFixed(2)}${Number(r.sizeScale)<1?` (크기 ×${r.sizeScale})`:''}${r.dca?` · 물타기 최대 ${r.dca.adds?.length??0}회`:''}`,
   `차트 ${chart} · 체결 ${venue}`,'실제 주문 없음 (모의매매)'].join('\n');
 }
 const pnl=Number(event.realizedPnLUSD),risk=Number(r.initialRiskUSD),rMul=risk>0&&Number.isFinite(pnl)?` (${pnl>=0?'+':''}${(pnl/risk).toFixed(2)}R)`:'';
 const held=Number(r.openedAt)&&Number(event.at)?` · 보유 ${minutes(event.at-r.openedAt)}`:'';
 return [`${pnl>0?'✅':pnl<0?'❌':'➖'} ${tag}[모의 청산] ${event.symbol} ${side} ${usd(pnl)}${rMul}`,
  `${closeReason(event,r)}${held}`,`진입 ${n(event.entryFill)} → 마지막 청산 ${n(event.lastExitFill)}${r.dca?.filledAdds?` · 물타기 ${r.dca.filledAdds}회 체결`:''}`,
  `${strategy} · ${r.pattern||'-'} · 차트 ${chart}`,
  ...(totals?[`누적 모의 손익 ${usd(totals.pnl)} · 청산 ${totals.closed}건 (승 ${totals.wins})`]:[]),'실제 주문 없음 (모의매매)'].join('\n');
}
