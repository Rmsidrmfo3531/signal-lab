/** Manual, local-only journal. Does not connect to the user's trading account. */
const numeric=(v)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const checkText=(v,max=300)=>String(v??'').trim().slice(0,max);
export function normalizeTrade(input,{now=Date.now(),allowedSymbols=null}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('거래 입력값 오류');
 const symbol=String(input.symbol||'').toUpperCase().trim();
 if(!/^[A-Z0-9]{2,22}USDT$/.test(symbol)||allowedSymbols && !allowedSymbols.has(symbol))throw Error('공통 상장 PERP 심볼 확인 필요');
 const side=String(input.side||'').toUpperCase();
 if(!['LONG','SHORT'].includes(side))throw Error('LONG/SHORT 선택 필요');
 const entry=numeric(input.entry),stop=numeric(input.stop),notional=numeric(input.notional),leverage=numeric(input.leverage),fees=numeric(input.fees)??0,funding=numeric(input.funding)??0,exit=numeric(input.exit);
 if(!entry||entry<=0||!stop||stop<=0||!notional||notional<=0||notional>100000||!leverage||leverage<1||leverage>125)throw Error('진입가·손절가·명목금액·레버리지 범위 확인 필요');
 if(side==='LONG'&&stop>=entry||side==='SHORT'&&stop<=entry)throw Error('손절은 진입가 대비 손실 방향이어야 합니다');
 if(fees<0||fees>10000||Math.abs(funding)>10000)throw Error('비용 범위 확인 필요');
 const status=exit!==null?'CLOSED':'OPEN';
 if(exit!==null&&exit<=0)throw Error('청산 가격은 양수여야 합니다');
 const stopRisk=notional*Math.abs(entry-stop)/entry+fees;
 const pnl=status==='CLOSED'? (side==='LONG'?1:-1)*notional*(exit-entry)/entry-fees-funding:null;
 return {id:input.id||null,symbol,side,entry,stop,notional,leverage,fees,funding,exit:status==='CLOSED'?exit:null,status,createdAt:now,closedAt:status==='CLOSED'?now:null,stopRiskUSD:stopRisk,realizedPnLUSD:pnl,note:checkText(input.note)};
}
export function closeTrade(trade,{exit,fees,funding,now=Date.now()}={}){
 if(!trade||trade.status!=='OPEN')throw Error('열려 있는 기록만 청산 가능');
 const x=numeric(exit),extraFees=numeric(fees)??0,extraFunding=numeric(funding)??0;
 if(!x||x<=0||extraFees<0||extraFees>10000||Math.abs(extraFunding)>10000)throw Error('청산가/비용 입력 오류');
 const newFees=trade.fees+extraFees,newFunding=trade.funding+extraFunding;
 const pnl=(trade.side==='LONG'?1:-1)*trade.notional*(x-trade.entry)/trade.entry-newFees-newFunding;
 return {...trade,status:'CLOSED',exit:x,fees:newFees,funding:newFunding,closedAt:now,realizedPnLUSD:pnl};
}
export function journalSummary(entries=[],now=Date.now()){
 const closed=entries.filter(x=>x.status==='CLOSED'&&Number.isFinite(x.realizedPnLUSD));
 const shift=9*3600000;
 const kstDate=t=>new Date(t+shift).toISOString().slice(0,10);
 const today=kstDate(now);
 const day=new Date(now+shift);const monday=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate()-(day.getUTCDay()+6)%7));
 const weekStart=monday.toISOString().slice(0,10);
 const p=arr=>arr.reduce((s,t)=>s+t.realizedPnLUSD,0);
 const currentWeek=closed.filter(x=>kstDate(x.closedAt)>=weekStart);
 const currentDay=closed.filter(x=>kstDate(x.closedAt)===today);
 return {count:entries.length,open:entries.filter(x=>x.status==='OPEN').length,closed:closed.length,winRate:closed.length?closed.filter(x=>x.realizedPnLUSD>0).length/closed.length:null,totalPnL:p(closed),todayPnL:p(currentDay),weekPnL:p(currentWeek),lossLimitDay:15,lossLimitWeek:40,dayExceeded:p(currentDay)<=-15,weekExceeded:p(currentWeek)<=-40,stopRiskOpen:entries.filter(x=>x.status==='OPEN').reduce((s,x)=>s+(Number(x.stopRiskUSD)||0),0),manualOnly:true};
}
export function exportTradesCSV(entries){
 const cols=['id','createdAt','closedAt','symbol','side','status','entry','stop','exit','notional','leverage','fees','funding','stopRiskUSD','realizedPnLUSD','note'];
 function cell(value){
  let s=value==null?'':String(value);
  if(/^[=+@\-]/.test(s) && !/^-[0-9.]+$/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
 }
 return '\uFEFF'+cols.map(cell).join(',')+'\r\n'+entries.map(e=>cols.map(k=>cell(e[k])).join(',')).join('\r\n')+'\r\n';
}
