import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateTrade,backtestHourly,backtestScalp,summarize,scoreBucket} from '../backtest.mjs';
import {parseArgs,buildReport} from '../scripts/backtest.mjs';
import {scoreGatePassed} from '../signal_policy.mjs';

const M5=300000,T0=Date.parse('2026-09-01T00:00:00Z');
const c=(i,o,h,l,cl)=>({t:T0+i*M5,o,h,l,c:cl,v:1,ct:T0+i*M5+M5-1});
const costs={takerRate:0,makerRate:0,slippageBps:0,spreadBps:0,fundingRate:0};

test('a candle touching both stop and target counts as the stop; a gap fills at the open',()=>{
 const both=simulateTrade({direction:'LONG',m5:[c(0,100,106,98,100)],startIdx:0,entryRef:100,stop:99,targets:[105,106,107],quantity:1,costs});
 assert.equal(both.exitReason,'STOP');assert.equal(both.netUSD,-1);
 const gap=simulateTrade({direction:'LONG',m5:[c(0,100,100.5,99.5,99.6),c(1,97,97.5,96,97)],startIdx:0,entryRef:100,stop:99,targets:[105,106,107],quantity:1,costs});
 assert.equal(gap.netUSD,-3,'filled at the gapped open 97, not at 99');
});

test('targets fill 40/35/25 and the stop moves to break-even from the next candle',()=>{
 const t=simulateTrade({direction:'LONG',m5:[c(0,100,105.5,99.5,105),c(1,105,105.2,99.9,100)],startIdx:0,entryRef:100,stop:99,targets:[105,106,107],quantity:1,costs});
 assert.equal(t.tp,1);assert.equal(t.exitReason,'BREAKEVEN_STOP');assert.ok(Math.abs(t.netUSD-2)<1e-9,'0.4 x 5 profit, the rest at entry');
 const all=simulateTrade({direction:'SHORT',m5:[c(0,100,100.2,94,95)],startIdx:0,entryRef:100,stop:101,targets:[98,96,94],quantity:1,costs});
 assert.equal(all.exitReason,'ALL_TARGETS');assert.ok(Math.abs(all.netUSD-(.4*2+.35*4+.25*6))<1e-9);
});

test('zone adds lower the average, the time stop closes the rest, costs are charged on every fill',()=>{
 const t=simulateTrade({direction:'LONG',m5:[c(0,100,100.2,97.9,98),c(1,98,98.5,97.5,98),c(2,98,98.2,97.8,98)],startIdx:0,entryRef:100,stop:95,targets:[103,104,105],
  quantity:1,adds:[{price:98,quantity:1}],maxHoldMs:2*M5,costs});
 assert.equal(t.addsFilled,1);assert.equal(t.averageEntry,99);assert.equal(t.exitReason,'TIME_STOP');assert.ok(Math.abs(t.netUSD-(-2))<1e-9,'2 units closed at 98 vs average 99');
 const fee=simulateTrade({direction:'LONG',m5:[c(0,100,100,99,99.5)],startIdx:0,entryRef:100,stop:99,targets:[105,106,107],quantity:1,costs:{...costs,takerRate:.001}});
 assert.ok(Math.abs(fee.netUSD-(-1-.1-.099))<1e-9);
});

// Synthetic market: a 5m random walk with occasional crashes, aggregated to 15m/1h/4h.
function market(days=72,seed=3){
 let s=seed;const rnd=()=>{s=(s*16807)%2147483647;return s/2147483647};const g=()=>Math.sqrt(-2*Math.log(rnd()))*Math.cos(2*Math.PI*rnd());
 const start=Date.parse('2026-06-01T00:00:00Z'),n=days*288,m5=[];let p=100,trend=0;
 for(let i=0;i<n;i++){
  if(i%2000===0)trend=(rnd()-.5)*.0006;
  const crash=i%1500===1200;const o=p;p*=Math.exp(trend+.0025*g()+(crash?-.04:0));
  const hi=Math.max(o,p)*(1+.001*rnd()),lo=Math.min(o,p)*(1-.001*rnd())*(crash?.99:1),v=100*(1+rnd())*(crash?8:1);
  m5.push([start+i*M5,o.toFixed(4),hi.toFixed(4),lo.toFixed(4),p.toFixed(4),v.toFixed(2),start+i*M5+M5-1]);
 }
 const agg=k=>{const out=[];for(let i=0;i+k<=m5.length;i+=k){const b=m5.slice(i,i+k);out.push([b[0][0],b[0][1],String(Math.max(...b.map(x=>+x[2]))),String(Math.min(...b.map(x=>+x[3]))),b.at(-1)[4],String(b.reduce((a,x)=>a+ +x[5],0)),b.at(-1)[6]])}return out};
 return {m5,m15:agg(3),h1:agg(12),h4:agg(48),start};
}

test('full replay on synthetic candles runs both strategies end to end and the report renders',()=>{
 const {m5,m15,h1,h4,start}=market();
 const filters={tickSize:.0001,stepSize:.01,minQty:.01,minNotional:5},startAt=start+58*86400000;
 const hourly=backtestHourly({symbol:'SOLUSDT',h1,h4,btcH4:h4,m15,m5,filters,startAt});
 // The split-buy book never changes the fixed-risk books.
 const withSplit=backtestHourly({symbol:'SOLUSDT',h1,h4,btcH4:h4,m15,m5,filters,startAt,split:{balanceUSD:400,marketCap:9e10}});
 assert.deepEqual(withSplit.trades.filter(t=>t.book!=='SPLIT').map(t=>t.netUSD),hourly.trades.map(t=>t.netUSD));
 for(const t of withSplit.trades.filter(t=>t.book==='SPLIT')){assert.ok(t.leverage>=10&&t.leverage<=30);assert.ok(Number.isFinite(t.pnlPctOfBalance))}
 assert.ok(hourly.funnel.bars>300);assert.ok(hourly.funnel.patterns>0,'patterns are detected');
 assert.ok(hourly.trades.every(t=>t.book!=='LIVE'||scoreGatePassed(t.score,t.pattern)),'the live book only takes 90+ (or an approved 4H-trend pattern)');
 assert.ok(hourly.trades.every(t=>t.book==='LIVE'||t.book==='BUCKET:'+scoreBucket(t.score)),'each candidate is booked in its own score bucket');
 const scalp=backtestScalp({symbol:'SOLUSDT',m5,m15,filters,startAt});
 assert.ok(scalp.funnel.bars>3500);
 for(const t of [...hourly.trades,...scalp.trades]){assert.ok(t.exitAt>=t.entryAt);assert.ok(Number.isFinite(t.netUSD));assert.ok(t.entryAt>t.signalAt,'never enters before the signal closes')}
 const report=buildReport({args:parseArgs([]),startAt,endAt:start+72*86400000,results:[{symbol:'SOLUSDT',trades:[...hourly.trades,...scalp.trades]}],
  hourlyFunnel:hourly.funnel,scalpFunnel:scalp.funnel,finalBalances:{SOLUSDT:scalp.finalBalance}});
 for(const part of ['[1] 1시간봉 전략','[2] 1시간봉 점수 구간별','[3] 5분봉 단타','[4] 단타 + 매물대 분할','[주의]'])assert.ok(report.includes(part),part);
});

test('summary statistics and arguments',()=>{
 const s=summarize([{netUSD:2,R:1,exitAt:1,holdMs:60000,exitReason:'ALL_TARGETS',tp:3},{netUSD:-1,R:-.5,exitAt:2,holdMs:60000,exitReason:'STOP',tp:0},{netUSD:-2,R:-1,exitAt:3,holdMs:60000,exitReason:'STOP',tp:0}]);
 assert.equal(s.trades,3);assert.equal(s.maxDrawdownUSD,3);assert.equal(s.profitFactor,2/3);assert.ok(Math.abs(s.winRatePct-100/3)<1e-9);
 assert.equal(scoreBucket(92),'90점 이상');assert.equal(scoreBucket(86),'85~89점');
 const a=parseArgs(['--days','30','--symbols','ethusdt,bad!,SOLUSDT','--leverage','50']);
 assert.equal(a.days,30);assert.deepEqual(a.symbols,['ETHUSDT','SOLUSDT']);assert.equal(a.leverage,20,'leverage clamped to 10~20');
});

test('scalp replay: a crash + hammer opens a fixed-risk trade and a zone scale-in trade on the same signal',()=>{
 const start=Date.parse('2026-08-01T00:00:00Z'),rows=[];let p=100;
 const push=(o,h,l,cl,v)=>{const t=start+rows.length*M5;rows.push([t,o.toFixed(4),h.toFixed(4),l.toFixed(4),cl.toFixed(4),String(v),t+M5-1])};
 // Three quiet days build volume zones around 97-98 and 94-95 below 100.
 for(let i=0;i<864;i++){const lvl=i%3===0?97.5:i%3===1?94.5:100;const o=lvl,cl=lvl+(i%2?.05:-.05);push(o,Math.max(o,cl)+.1,Math.min(o,cl)-.1,cl,100)}
 p=100;for(let i=0;i<40;i++){const o=p,cl=p+(i%2?.05:-.05);push(o,Math.max(o,cl)+.1,Math.min(o,cl)-.1,cl,100);p=cl}
 for(let i=0;i<4;i++){const o=p,cl=p-1;push(o,o+.05,cl-.1,cl,(i===3?1000:500));p=cl}
 push(p,p+.15,p-.8,p+.1,800);p+=.1;
 for(let i=0;i<30;i++){const o=p,cl=p+.12;push(o,cl+.05,o-.05,cl,150);p=cl}
 const m15=[];for(let i=0;i+3<=rows.length;i+=3){const b=rows.slice(i,i+3);m15.push([b[0][0],b[0][1],String(Math.max(...b.map(x=>+x[2]))),String(Math.min(...b.map(x=>+x[3]))),b[2][4],String(b.reduce((a,x)=>a+ +x[5],0)),b[2][6]])}
 const r=backtestScalp({symbol:'SOLUSDT',m5:rows,m15,filters:{tickSize:.0001,stepSize:.01,minQty:.01,minNotional:1},startAt:start+864*M5});
 assert.ok(r.funnel.signals>=1,JSON.stringify(r.funnel));
 const fixed=r.trades.find(t=>t.book==='FIXED');assert.ok(fixed,'fixed-risk scalp trade');assert.ok(fixed.tp>=1,'the rebound reaches TP1');assert.ok(fixed.netRR>=1,'TP1 net RR is kept on the trade');
 const dca=r.trades.find(t=>t.book==='DCA');assert.ok(dca||Object.keys(r.funnel.dcaRejected).length,'scale-in trade or a recorded reason');
 if(dca){assert.ok(Number.isFinite(dca.pnlPctOfBalance));assert.equal(r.finalBalance,1000+dca.netUSD)}
 // 4H trend tag (user 2026-11-16): measured with h4 even without the filter; the filter alone blocks.
 const H4=14400000,h4=k=>{const out=[];let q=100;for(let i=0;i<330;i++){const o=q;q*=k;const t=start-330*H4+i*H4;out.push([t,String(o),String(Math.max(o,q)*1.001),String(Math.min(o,q)*.999),String(q),'1',t+H4-1])}return out};
 const base={symbol:'SOLUSDT',m5:rows,m15,filters:{tickSize:.0001,stepSize:.01,minQty:.01,minNotional:1},startAt:start+864*M5,books:['FIXED']};
 const down=backtestScalp({...base,h4:h4(.997),trendFilter:false}).trades[0];assert.equal(down.trend4h,'down');assert.equal(down.withTrend,false,'rebound LONG in a 4H downtrend = against');
 const up=backtestScalp({...base,h4:h4(1.003),trendFilter:false}).trades[0];assert.equal(up.trend4h,'up');assert.equal(up.withTrend,true);
 const on=backtestScalp({...base,h4:h4(.997),trendFilter:true});assert.equal(on.trades.length,0);assert.ok(on.funnel.trendBlocked>=1);
});

test('scalp trend filter: with 4H candles a rebound LONG in a 4H downtrend is skipped',()=>{
 const start=Date.parse('2026-01-01T00:00:00Z'),H4=14400000,h4=[];let p=200;
 for(let i=0;i<320;i++){const o=p;p*=.997;h4.push([start+i*H4,String(o),String(o*1.001),String(p*.999),String(p),'1',start+i*H4+H4-1])}
 const m5=[[start+319*H4+H4,'1','1','1','1','1',start+319*H4+H4+M5-1]];
 const r=backtestScalp({symbol:'SOLUSDT',m5,m15:[],h4,trendFilter:true,filters:{tickSize:.01,stepSize:.01,minQty:.01,minNotional:1},startAt:0});
 assert.equal(r.funnel.trendBlocked,0,'no signal, nothing blocked');assert.equal(r.trades.length,0);
});

test('textbook candidate detectors: stops on the protective side, replay never enters before the signal closes',async()=>{
 const {backtestCandidates}=await import('../backtest.mjs');const {DETECTORS,prepare}=await import('../research/candidates.mjs');
 const {m5,m15,h1,h4,start}=market();
 const p=prepare(h1.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5],ct:+r[6]})));let hits=0;
 for(let j=210;j<h1.length;j++)for(const detect of Object.values(DETECTORS)){const s=detect(p,j);if(!s)continue;hits++;
  assert.ok(s.direction==='LONG'?s.stop<s.entry:s.stop>s.entry,'stop on the protective side');assert.equal(s.entry,p.close[j],'entry is the signal close')}
 assert.ok(hits>0,'synthetic data triggers some detectors');
 const r=backtestCandidates({symbol:'SOLUSDT',h1,h4,m15,m5,filters:{tickSize:.0001,stepSize:.01,minQty:.01,minNotional:5},startAt:start+58*86400000});
 for(const t of r.trades){assert.ok(t.entryAt>t.signalAt);assert.ok(['CANDIDATE:RAW','CANDIDATE:TREND'].includes(t.book))}
});

test('blog detectors: Bollinger two-candle rule fires after a band pierce on extreme RSI; fixed-percent exits are honoured',async()=>{
 const {bollingerTwoCandles,prepare}=await import('../pattern_detectors.mjs');const {backtestCandidates}=await import('../backtest.mjs');
 // 40 flat candles, then a sharp bearish candle through the lower band with RSI < 30, then two bullish candles.
 const bars=[];let p=100;for(let i=0;i<40;i++){const o=p,c=p+(i%2?.05:-.05);bars.push({t:i,o,h:Math.max(o,c)+.05,l:Math.min(o,c)-.05,c,v:1,ct:i+1});p=c}
 for(let i=0;i<6;i++){const o=p,c=p-.4;bars.push({t:40+i,o,h:o+.02,l:c-.05,c,v:1,ct:41+i});p=c}
 const o=p;bars.push({t:46,o,h:o+.02,l:o-1.2,c:o-1,v:1,ct:47});p=o-1;
 bars.push({t:47,o:p,h:p+.35,l:p-.05,c:p+.3,v:1,ct:48});p+=.3;bars.push({t:48,o:p,h:p+.35,l:p-.05,c:p+.3,v:1,ct:49});
 const s=prepare(bars),sig=bollingerTwoCandles(s,bars.length-1,1);
 assert.ok(sig,'signal after the two bullish candles');assert.equal(sig.direction,'LONG');assert.ok(sig.stop<o-1.2,'stop below the piercing wick');
 assert.equal(bollingerTwoCandles(s,bars.length-2,1),null,'one opposite candle is not enough');
 const {m5,m15,h1,h4,start}=market();
 const r=backtestCandidates({symbol:'SOLUSDT',h1,h4,m15,m5,filters:{tickSize:.0001,stepSize:.01,minQty:.01,minNotional:5},startAt:start+58*86400000,fixedTargetPct:.005});
 for(const t of r.trades)if(t.exitReason==='ALL_TARGETS')assert.ok(Math.abs(t.targets[0]/t.entryFill-1)<.0062,'single target about 0.5 % away');
});

// 4H+ volume zones for the 5m scalp (user 2026-11-17): tags without look-ahead, candidate B in its own book.
function crashScalp(){
 const start=Date.parse('2026-08-01T00:00:00Z'),rows=[];let p=100;
 const push=(o,h,l,cl,v)=>{const t=start+rows.length*M5;rows.push([t,o.toFixed(4),h.toFixed(4),l.toFixed(4),cl.toFixed(4),String(v),t+M5-1])};
 for(let i=0;i<864;i++){const lvl=i%3===0?97.5:i%3===1?94.5:100;const o=lvl,cl=lvl+(i%2?.05:-.05);push(o,Math.max(o,cl)+.1,Math.min(o,cl)-.1,cl,100)}
 p=100;for(let i=0;i<40;i++){const o=p,cl=p+(i%2?.05:-.05);push(o,Math.max(o,cl)+.1,Math.min(o,cl)-.1,cl,100);p=cl}
 for(let i=0;i<4;i++){const o=p,cl=p-1;push(o,o+.05,cl-.1,cl,(i===3?1000:500));p=cl}
 push(p,p+.15,p-.8,p+.1,800);p+=.1;
 for(let i=0;i<30;i++){const o=p,cl=p+.12;push(o,cl+.05,o-.05,cl,150);p=cl}
 const m15=[];for(let i=0;i+3<=rows.length;i+=3){const b=rows.slice(i,i+3);m15.push([b[0][0],b[0][1],String(Math.max(...b.map(x=>+x[2]))),String(Math.min(...b.map(x=>+x[3]))),b[2][4],String(b.reduce((a,x)=>a+ +x[5],0)),b[2][6]])}
 return {start,rows,m15,signalAt:Number(rows[864+40+4][6])};
}
// 4H candles: `blocks` of [count, low, high, volume]; the last block ends at `endAt` (open time of the next candle).
function h4Blocks(blocks,endAt){
 const H4=14400000,n=blocks.reduce((a,b)=>a+b[0],0),out=[];let t=endAt-n*H4;
 for(const [count,lo,hi,v] of blocks)for(let i=0;i<count;i++,t+=H4){const mid=(lo+hi)/2;out.push([t,String(mid),String(hi),String(lo),String(mid),String(v),t+H4-1])}
 return out;
}

test('scalp zone tags: 4H zones from candles closed before the move; a zone formed later never counts',async()=>{
 const {zoneBook,zoneTouch}=await import('../backtest.mjs');
 const {start,rows,m15,signalAt}=crashScalp(),filters={tickSize:.0001,stepSize:.01,minQty:.01,minNotional:1};
 const base={symbol:'SOLUSDT',m5:rows,m15,filters,startAt:start+864*M5,books:['FIXED'],trendFilter:false};
 // Zone at 94.9-95.6 (the crash extreme is about 95.2) and one at 110, both closed before the signal.
 const before=h4Blocks([[150,109.5,110.5,1],[120,94.9,95.6,10]],start);
 const t=backtestScalp({...base,h4:before}).trades[0];
 assert.ok(t,'trade');assert.equal(t.atZone4h,true);assert.equal(t.zoneDistPct4h,0,'extreme inside the zone band');
 assert.equal(t.zoneRank4h,1);assert.ok(t.zoneShare4h>0&&t.zoneShare4h<=100);assert.equal(t.atZone1d,null,'no daily candles, no 1D tag');assert.equal(t.atZone,true);
 // Same 95 zone, but its candles close after the signal: only the 110 zone is known at the signal.
 const H4=14400000,later=h4Blocks([[170,109.5,110.5,1],[40,94.9,95.6,10]],start+60*H4); // the 95 candles open 80 h after `start`, the signal is at about 76 h
 const u=backtestScalp({...base,h4:later}).trades[0];
 assert.equal(u.atZone4h,false,'a zone formed after the signal must not count');assert.ok(u.zoneDistPct4h>10);
 // zoneBook cut-off: the profile only sees candles closed before it.
 const book=zoneBook(later,{symbol:'SOLUSDT',tickSize:.0001,interval:'4h'});
 assert.equal(zoneTouch(book(signalAt),95.2).atZone,false);
 assert.equal(zoneTouch(book(start+60*H4+1),95.2).atZone,true,'after those candles close the zone exists');
 assert.equal(zoneTouch(book(start-1000*H4),95.2),null,'too few candles: no profile, no tag');
 assert.equal(zoneTouch([{low:100,high:101,price:100.5,sharePct:5,rank:2}],99.75).atZone,true,'within 0.3 % below the band');
 assert.equal(zoneTouch([{low:100,high:101,price:100.5,sharePct:5,rank:2}],99.5).atZone,false);
});

test('scalp candidate B: a 2.5 %+ reversal at a 4H zone trades in the ZONE book, never twice',()=>{
 const {start,rows,m15}=crashScalp(),filters={tickSize:.0001,stepSize:.01,minQty:.01,minNotional:1};
 const base={symbol:'SOLUSDT',m5:rows,m15,filters,startAt:start+864*M5,books:['FIXED'],trendFilter:false,settings:{minMovePct:5}};
 const atZone=h4Blocks([[150,109.5,110.5,1],[120,94.9,95.6,10]],start),noZone=h4Blocks([[150,109.5,110.5,1],[120,120,121,10]],start);
 // The move (about 4.9 %) is below the 5 % rule: no trade without candidate B.
 assert.equal(backtestScalp({...base,h4:atZone}).trades.length,0);
 const b=backtestScalp({...base,h4:atZone,zoneSignals:true});
 const z=b.trades.find(t=>t.book==='ZONE');assert.ok(z,JSON.stringify(b.funnel));
 assert.equal(z.zoneSignal,true);assert.equal(z.atZone4h,true);assert.ok(z.movePct>=2.5&&z.movePct<5);assert.ok(z.entryAt>z.signalAt);
 assert.equal(b.trades.filter(t=>t.book==='FIXED').length,0);assert.ok(b.funnel.zone.atZone>=1);assert.equal(b.funnel.signals,0,'zone signals are counted apart');
 // Not at a zone: detected but not traded.
 const n=backtestScalp({...base,h4:noZone,zoneSignals:true});assert.equal(n.trades.length,0);assert.ok(n.funnel.zone.signals>=1);assert.equal(n.funnel.zone.atZone,0);
 // A signal that already qualifies under the main rule is never a zone signal too.
 const q=backtestScalp({...base,settings:{minMovePct:4},h4:atZone,zoneSignals:true});
 assert.ok(q.trades.some(t=>t.book==='FIXED'));assert.equal(q.trades.filter(t=>t.book==='ZONE').length,0);assert.equal(q.funnel.zone.signals,0);
 // With the 4H trend filter the zone signal is blocked like the main rule (here: falling 4H candles = downtrend, no rebound LONG).
 const H4=14400000,down=[];let px=200;for(let i=0;i<330;i++){const o=px;px*=.997;const t=start-330*H4+i*H4;down.push([t,String(o),String(o*1.001),String(px*.999),String(px),'1',t+H4-1])}
 const f=backtestScalp({...base,h4:down,zoneSignals:true,trendFilter:true});assert.equal(f.trades.length,0);assert.ok(f.funnel.zone.trendBlocked>=1||f.funnel.zone.signals===0||f.funnel.zone.atZone===0);
 // Report rows.
 const args=parseArgs(['--exec','--scalp-zone-signals']);assert.equal(args.scalpZoneSignals,true);
 const fixed=backtestScalp({...base,settings:{minMovePct:4},h4:atZone}).trades;
 const hf={bars:0,patterns:0,validated:0,scoreOk:0,planned:0,chaseSkipped:0,planReasons:{}};
 const report=buildReport({args,startAt:start,endAt:start+4*86400000,results:[{symbol:'SOLUSDT',trades:[...fixed,...b.trades]}],
  hourlyFunnel:hf,scalpFunnel:{bars:0,signals:0,qualityRejected:0,entrySkipped:0,dcaRejected:{},zone:b.funnel.zone},finalBalances:{}});
 for(const part of ['4H 매물대 닿음','매물대 반전 (급변 2.5%+)','기존 5% + 매물대 반전','매물대 반전 흐름'])assert.ok(report.includes(part),part);
 assert.ok(!buildReport({args:parseArgs(['--exec']),startAt:start,endAt:start+86400000,results:[{symbol:'SOLUSDT',trades:fixed}],
  hourlyFunnel:hf,scalpFunnel:{bars:0,signals:0,qualityRejected:0,entrySkipped:0,dcaRejected:{}},finalBalances:{}}).includes('매물대 반전 (급변'),'no candidate B rows without the flag');
});
