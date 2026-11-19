// Parser for the followed Telegram channel's alerts (Gate.io position monitor), user 2026-11-13.
// Two formats appear in the log (emoji cards and plain lines); both are read:
//   📌 포지션 진입 / 🪙 TNSRUSDT  🔴 Short  ×5 / 진입가 0.05296 USDT / 현재가 … / 수량 880 마진 9.01 USDT
//   📊 포지션 변경 / 🪙 BTWUSDT  🟢 Long / 수량 200 → 400 / 현재가 0.075638 USDT
//   ✅ 포지션 청산 / 🪙 TNSRUSDT  🔴 Short / 진입가 0.05296 USDT / 최종손익 🟢 +1.72 USDT
//   포지션 진입 / 코인: BTWUSDT / 방향: Long  레버리지: 6X / 진입가: … / 수량: 200  마진: 2.61 USDT
//   Gate.io 모니터 시작 …   (the monitor restarted: the next 진입 cards re-announce open positions)
const num=s=>{if(s==null)return null;const clean=String(s).replace(/,/g,'').trim();if(!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(clean))return null;const v=Number(clean);return Number.isFinite(v)?v:null};
const pick=(text,re)=>{const m=re.exec(text);return m?m[1]:null};

/** One message -> {kind:'OPEN'|'CHANGE'|'CLOSE'|'MONITOR_START', symbol, direction, ...} or null. */
export function parseCopyMessage(text){
 const t=String(text||'');if(!t.trim())return null;
 const first=t.trim().split('\n')[0];
 if(/모니터 시작/.test(first))return {kind:'MONITOR_START'};
 const kind=/포지션 진입/.test(first)?'OPEN':/포지션 변경/.test(first)?'CHANGE':/포지션 청산/.test(first)?'CLOSE':null;
 if(!kind)return null;
 const symbol=pick(t,/\b([A-Z0-9]{1,20}USDT)\b/);
 const direction=/\bLong\b/i.test(t)?'LONG':/\bShort\b/i.test(t)?'SHORT':null;
 if(!symbol||!direction)return null;
 const out={kind,symbol,direction};
 const lev=num(pick(t,/×\s*(\d+(?:\.\d+)?)/)??pick(t,/레버리지[:\s]*(\d+(?:\.\d+)?)\s*X/i));if(lev>0)out.leverage=lev;
 const entry=num(pick(t,/진입가[\s:\u3000]*([\d,.]+)/));if(entry>0)out.entry=entry;
 const price=num(pick(t,/현재가[\s:\u3000]*([\d,.]+)/));if(price>0)out.price=price;
 if(kind==='CHANGE'){
  // '-' stands for no position: '0.07 → -' is a full close, '- → 0.07' a fresh position.
  const m=/수량[\s:\u3000]*([\d,.]+|-)\s*(?:→|->)\s*([\d,.]+|-)/.exec(t);if(!m)return null;
  out.from=m[1]==='-'?0:num(m[1]);out.to=m[2]==='-'?0:num(m[2]);
  if(typeof out.from!=='number'||typeof out.to!=='number'||!(out.from>=0)||!(out.to>=0)||out.from===out.to)return null;
 }else{
  const q=num(pick(t,/수량[\s:\u3000]*([\d,.]+)/));if(q>0)out.quantity=q;
  const margin=num(pick(t,/마진[\s:\u3000]*([\d,.]+)/));if(margin>0)out.marginUSD=margin;
 }
 if(kind==='CLOSE'){const p=pick(t,/(?:최종손익|미실현손익)[\s:\u3000]*[🟢🔴]?\s*([+−-]?\s*\$?\s*[\d,.]+)/u);if(p!=null){const v=num(p.replace(/[$\s]/g,'').replace(/−/g,'-'));if(v!==null)out.theirPnlUSD=v}}
 if(kind==='OPEN'&&!(out.entry>0))return null;
 return out;
}
