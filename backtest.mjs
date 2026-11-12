// Offline candle backtest. Replays the same decision functions the server uses
// (1H/4H pattern analysis + 100-point score, 15m volume-profile targets, 5m scalp
// reversal, zone scale-in plan) over historical Binance candles, and simulates exits
// on 5-minute candles. Research only: no network, no keys, no orders.
//
// Fill rules (conservative):
//  - Entry at the open of the first 5m candle after the signal candle closes.
//  - A 5m candle that touches both the stop and a target counts as the stop first.
//  - A candle that opens beyond the stop fills at its open (gap), not at the stop.
//  - Zone adds fill at the zone price (or the open if it gapped through).
//  - After TP1 the stop moves to the average entry from the next candle on.
//  - Taker fee and slippage on every fill.
import {analyze} from './engine.mjs';
import {buildKlineVolumeProfile} from './volume_profile.mjs';
import {planVolumeTargets} from './volume_targets.mjs';
import {detectScalpReversal,buildScalpPlan,SCALP_DEFAULTS,SCALP_TIMEFRAMES,trendAllows} from './scalp_reversal.mjs';
import {planZoneDca,DCA_DEFAULTS,DCA_DEEP_PROFILE,dcaZoneDaysFor} from './dca_plan.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {seededEMA} from './indicators.mjs';
import {leverageForScore} from './paper.mjs';
import {DETECTORS,prepare} from './pattern_detectors.mjs';
import {fourHourTrend} from './scalp_reversal.mjs';

export const HOUR=3600000,M5=300000,M15=900000;
// Same default as the server (SIGNAL_PATTERNS): only the range breakout trades. null = every pattern.
import {TREND_GATE_PATTERNS,scoreGatePassed,DEFAULT_TRADE_PATTERNS} from './signal_policy.mjs';
export const LIVE_PATTERNS=DEFAULT_TRADE_PATTERNS;
export const BACKTEST_COSTS=Object.freeze({takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'});
const FRACTIONS=[.4,.35,.25];
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;

export const toCandle=r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[5]),ct:Number(r[6])});
/** First index whose open time is >= t. */
export function lowerBound(candles,t){let lo=0,hi=candles.length;while(lo<hi){const mid=(lo+hi)>>1;if(candles[mid].t<t)lo=mid+1;else hi=mid}return lo}
/** Index after the last candle closed at or before `now` (raw Binance rows: [6] = close time). */
export function closedUntil(rows,now){let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>1;if(Number(rows[mid][6])<now)lo=mid+1;else hi=mid}return lo}

/** Simulate one trade on 5m candles from startIdx. Quantities in base asset. */
export function simulateTrade({direction,m5,startIdx,entryRef,stop,targets,quantity,adds=[],maxHoldMs=null,costs=BACKTEST_COSTS,breakeven=true,endIdx=m5.length}){
 const dir=direction==='LONG'?1:-1,slip=costs.slippageBps/10000,fee=costs.takerRate;
 const buy=p=>p*(1+dir*slip),sell=p=>p*(1-dir*slip); // entry worse, exit worse
 const open=m5[startIdx];if(!open)return null;
 const entryFill=buy(entryRef);
 let qty=quantity,avg=entryFill,fees=qty*entryFill*fee,realized=0,curStop=stop,tpDone=[false,false,false],tpQty=FRACTIONS.map(f=>quantity*f);
 const initialRisk=quantity*Math.abs(entryFill-stop),pending=adds.map(a=>({...a,filled:false}));
 let addsFilled=0,exitReason='OPEN_AT_END',exitAt=null,i=startIdx,beArmed=false,worst=0;
 const exit=(price,q)=>{const fill=sell(price);realized+=dir*(fill-avg)*q;fees+=q*fill*fee;qty-=q};
 for(;i<endIdx;i++){
  const c=m5[i];
  if(beArmed&&breakeven){if(dir*(avg-curStop)>0)curStop=avg;beArmed=false}
  if(maxHoldMs&&c.t-open.t>=maxHoldMs){exit(c.o,qty);exitReason='TIME_STOP';exitAt=c.t;break}
  // Zone adds (only before TP1), nearest first.
  if(!tpDone[0])for(const a of pending){
   if(a.filled)continue;
   const touched=dir===1?c.l<=a.price:c.h>=a.price;if(!touched)break;
   if(dir*(a.price-curStop)<=0)break;
   const ref=dir===1?Math.min(a.price,c.o):Math.max(a.price,c.o),fill=buy(ref);
   avg=(avg*qty+fill*a.quantity)/(qty+a.quantity);qty+=a.quantity;fees+=a.quantity*fill*fee;a.filled=true;addsFilled++;
   const total=quantity+pending.filter(x=>x.filled).reduce((s,x)=>s+x.quantity,0);tpQty=FRACTIONS.map(f=>total*f);
  }
  const adverse=dir*((dir===1?c.l:c.h)-avg)*qty;worst=Math.min(worst,adverse+realized-fees);
  const stopHit=dir===1?c.l<=curStop:c.h>=curStop;
  if(stopHit){const ref=dir===1?Math.min(curStop,c.o):Math.max(curStop,c.o);exit(ref,qty);exitReason=tpDone[0]?'BREAKEVEN_STOP':'STOP';exitAt=c.t;break}
  for(let k=0;k<3;k++){
   if(tpDone[k])continue;
   const hit=dir===1?c.h>=targets[k]:c.l<=targets[k];if(!hit)break;
   const q=k===2?qty:Math.min(tpQty[k],qty);exit(targets[k],q);tpDone[k]=true;if(k===0)beArmed=true;
  }
  if(tpDone[2]||qty<=1e-12){exitReason='ALL_TARGETS';exitAt=c.t;break}
 }
 if(exitReason==='OPEN_AT_END'){const last=m5[Math.min(i,endIdx)-1];exit(last.c,qty);exitAt=last.t}
 const net=realized-fees;
 return {entryAt:open.t,exitAt,holdMs:exitAt-open.t,entryFill,averageEntry:avg,exitReason,tp:tpDone.filter(Boolean).length,addsFilled,
  netUSD:net,feesUSD:fees,R:initialRisk>0?net/initialRisk:null,initialRiskUSD:initialRisk,worstOpenUSD:worst,endIdx:i};
}

export function onTick(price,tick,mode){
 if(mode==='NEAREST'){const down=Number(roundDecimalToStep(price,tick,'DOWN')),up=Number(roundDecimalToStep(price,tick,'UP'));return price-down<=up-price?down:up}
 return Number(roundDecimalToStep(price,tick,mode));
}
export function stepQuantity(raw,step){
 try{const grid=roundDecimalToStep(step*20.5,step,'DOWN');return Number(roundDecimalToStep(raw,grid,'DOWN'))}catch{return 0}
}
// Closed 15m candles only (no look-ahead). Between 15m closes the profile is dated at the
// last 15m close, which is when the server would last have seen a finished 15m candle.
export function profileAt(m15Raw,now,symbol,tick,{candles=288,...options}={}){
 const end=closedUntil(m15Raw,now),rows=m15Raw.slice(Math.max(0,end-candles),end);
 const at=rows.length?Math.min(now,Number(rows.at(-1)[6])+1000):now;
 return buildKlineVolumeProfile({symbol,klines:rows,receivedAt:at,tickSize:String(tick),dataSource:'SYNTHETIC_TEST'},{now:at,...options});
}

/** 1H/4H strategy replay: the live rule (score >= minScore) plus one book per score bucket. */
// Research knobs (defaults = the live server): minNetRR, obstacleFraction (STRONG_HVN_BEFORE_TP1),
// targetMode, breakeven after TP1, stopScale (>1 widens the stop away from the entry),
// patterns / directions (only trade these), endAt (exclusive signal cut-off).
export function backtestHourly({symbol,h1,h4,btcH4,m15,m5,filters,startAt,endAt=Infinity,riskUSD=6,minScore=90,costs=BACKTEST_COSTS,
 minNetRR=1.8,obstacleFraction=1,targetMode='HVN_THEN_R',breakeven=true,stopScale=1,patterns=LIVE_PATTERNS,directions=null,liveGate=null,split=null}){
 const m5c=m5.map(toCandle),funnel={bars:0,patterns:0,validated:0,scoreOk:0,planned:0,chaseSkipped:0,planReasons:{}},trades=[];
 // LIVE = the live rule (score >= minScore). Each score bucket is its own sequential book,
 // so a bucket's trades are never crowded out by trades of another bucket.
 const busy={};
 for(let j=0;j<h1.length;j++){
  const closeAt=Number(h1[j][6]);if(closeAt<startAt||closeAt>=endAt)continue;
  const now=closeAt+1000;funnel.bars++;
  const h1s=h1.slice(Math.max(0,j-199),j+1),i4=closedUntil(h4,now),h4s=h4.slice(Math.max(0,i4-301),i4);
  const ib=closedUntil(btcH4,now),btc=btcH4.slice(Math.max(0,ib-301),ib);
  const out=analyze(symbol,h1s,h4s,[],Number(h1[j][4]),{now,btcH4Rows:btc});
  if(!out.patternConfirmed)continue;funnel.patterns++;
  if(out.quality?.validationPassed!==true)continue;funnel.validated++;
  if(patterns&&!patterns.includes(out.pattern)||directions&&!directions.includes(out.direction))continue;
  // Research filters for the SPLIT book only (split.btcLongFilter / split.minBoxWidthAtr).
  const splitBlocked=split&&((split.btcLongFilter&&out.direction==='LONG'&&(()=>{const t=fourHourTrend(btc,now);return split.btcLongFilter==='up'?t!=='up':t==='down'})())||
   (split.minBoxWidthAtr>0&&out.pattern==='박스권 상단 돌파'&&(()=>{const w=h1s.slice(-21,-1);const hi=Math.max(...w.map(r=>Number(r[2]))),lo=Math.min(...w.map(r=>Number(r[3])));return (hi-lo)/out.atr<split.minBoxWidthAtr})()));
  // liveGate(ctx) replaces the score rule when given (research: alternative scores).
  const live=liveGate?liveGate({out,h1:h1s,h4:h4s,btcH4:btc,now,symbol}):minScore===90?scoreGatePassed(out.score,out.pattern):out.score>=minScore;if(live)funnel.scoreOk++;
  const k=lowerBound(m5c,closeAt+1);const next=m5c[k];if(!next)continue;
  const dir=out.direction==='LONG'?1:-1,entry=onTick(next.o,filters.tickSize,'NEAREST');
  // Stop on the tick grid, rounded away from the entry (as venueStop does on the server).
  const stop=onTick(out.entry-(out.entry-out.stop)*stopScale,filters.tickSize,dir===1?'DOWN':'UP');
  if(Math.abs(entry-out.entry)>Math.min(out.entry*.004,out.atr*.45)||dir*(entry-stop)<=0){funnel.chaseSkipped++;continue}
  const quantity=stepQuantity(riskUSD/Math.abs(entry-stop),filters.stepSize);
  if(!positive(quantity)||quantity<filters.minQty||quantity*entry<filters.minNotional){(funnel.planReasons.QUANTITY_BELOW_MINIMUM=(funnel.planReasons.QUANTITY_BELOW_MINIMUM||0)+1);continue}
  const profileResult=profileAt(m15,now,symbol,filters.tickSize);
  const plan=planVolumeTargets({profileResult,direction:out.direction,entry,stop,quantity,tickSize:filters.tickSize,quantityStep:filters.stepSize,
   minQuantity:filters.minQty,minNotional:filters.minNotional,contractSizeBase:1,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',unitsVerified:true,
   costs,minNetRR,targetMode,obstacleFraction},{now});
  if(!plan.ok){for(const r of plan.reasons||['PLAN_FAILED'])funnel.planReasons[r]=(funnel.planReasons[r]||0)+1;continue}
  funnel.planned++;
  // SPLIT book: the live paper rule since v5.9 - one unit at the entry, adds of 1, 2, 4 ... units
  // at volume zones (15m 3d + deep, then 1h 30d, then 4h 90d), stop beyond the last add. Unit =
  // balance x unitPct x leverage (score + market cap). No zone fits: the fixed-risk trade above.
  if(live&&split&&!splitBlocked&&k>(busy.SPLIT??-1)){
   const leverage=leverageForScore(out.score,split.marketCap)??10,fb={minCandles:96,targetBins:240,hvnMinFractionOfPoc:.05};
   const deep=profileResult.ok&&(split.zoneDays??14)>3?profileAt(m15,now,symbol,filters.tickSize,DCA_DEEP_PROFILE(split.zoneDays??14)):null;
   const sets=[['15m',()=>profileResult.ok?[...profileResult.profile.hvn,...(deep?.ok?deep.profile.hvn:[])]:[]],
    ['1h',()=>{const r=profileAt(h1,now,symbol,filters.tickSize,{candles:720,intervalMs:HOUR,interval:'1h',...fb});return r.ok?r.profile.hvn:[]}],
    ['4h',()=>{const r=profileAt(h4,now,symbol,filters.tickSize,{candles:540,intervalMs:4*HOUR,interval:'4h',...fb});return r.ok?r.profile.hvn:[]}]];
   let dca=null,zoneSource=null;
   // Study-material patterns trade their pattern stop, without zone adds (as on the server).
   if(!TREND_GATE_PATTERNS.includes(out.pattern))for(const [label,zonesOf] of sets){
    const d=planZoneDca({direction:out.direction,entry,atr:out.atr,zones:zonesOf(),balanceUSD:split.balanceUSD,leverage,unitPct:split.unitPct??DCA_DEFAULTS.unitPct,
     tickSize:filters.tickSize,quantityStep:filters.stepSize,minQuantity:filters.minQty,minNotional:filters.minNotional,takerRate:costs.takerRate,
     settings:{maxLossPct:split.maxLossPct??DCA_DEFAULTS.maxLossPct,maxAdds:split.maxAdds??DCA_DEFAULTS.maxAdds}});
    if(d.ok&&d.adds.length){dca=d;zoneSource=label;break}
   }
   funnel.split??={planned:0,fallback:0,sources:{}};
   const t=dca?simulateTrade({direction:out.direction,m5:m5c,startIdx:k,entryRef:entry,stop:dca.stop,targets:plan.targets,quantity:dca.unitQty,
     adds:dca.adds.map(a=>({price:a.price,quantity:a.quantity})),costs,breakeven,maxHoldMs:split.maxHoldMs??null})
    :simulateTrade({direction:out.direction,m5:m5c,startIdx:k,entryRef:entry,stop,targets:plan.targets,quantity,costs,breakeven,maxHoldMs:split.maxHoldMs??null});
   if(t){busy.SPLIT=t.endIdx;if(dca){funnel.split.planned++;funnel.split.sources[zoneSource]=(funnel.split.sources[zoneSource]||0)+1}else funnel.split.fallback++;
    trades.push({strategy:'HOURLY',book:'SPLIT',symbol,direction:out.direction,pattern:out.pattern,score:out.score,signalAt:closeAt,stop:dca?dca.stop:stop,targets:plan.targets,
     leverage,zoneSource,plannedAdds:dca?dca.adds.length:0,plannedMaxLossPct:dca?dca.full.maxLossPct:null,stopDistancePct:Math.abs(entry-(dca?dca.stop:stop))/entry*100,
     pnlPctOfBalance:t.netUSD/split.balanceUSD*100,worstOpenPctOfBalance:t.worstOpenUSD/split.balanceUSD*100,...t})}
  }
  for(const book of [...(live?['LIVE']:[]),'BUCKET:'+scoreBucket(out.score)]){
   if(k<=(busy[book]??-1))continue;
   const t=simulateTrade({direction:out.direction,m5:m5c,startIdx:k,entryRef:entry,stop,targets:plan.targets,quantity,costs,breakeven});
   if(!t)continue;busy[book]=t.endIdx;
   trades.push({strategy:'HOURLY',book,symbol,direction:out.direction,pattern:out.pattern,score:out.score,signalAt:closeAt,stop,targets:plan.targets,
    hvnTargets:plan.hvnTargets,rMultipleTargets:plan.rMultipleTargets,...t});
  }
 }
 return {funnel,trades};
}

/** 5m reversal scalp replay, without and with the zone scale-in plan. */
// trendFilter: no rebound LONG while the 4H trend is down, no fade SHORT while it is up (needs h4).
// interval: the signal timeframe ('1m' | '5m' | '15m'); bars are its candles (default m5).
// Trades are replayed on m5 candles, or on the 1m bars themselves for the 1m timeframe.
export function backtestScalp({symbol,m5,m15,h4=null,trendFilter=Array.isArray(h4),filters,startAt,endAt=Infinity,riskUSD=6,balanceUSD=1000,dca={},costs=BACKTEST_COSTS,settings={},minNetRR=SCALP_DEFAULTS.minNetRR,
 interval='5m',bars=m5,maxHoldMs=SCALP_TIMEFRAMES[interval].maxHoldMs}){
 const m5c=(interval==='1m'?bars:m5).map(toCandle),funnel={bars:0,signals:0,qualityRejected:0,dcaRejected:{},entrySkipped:0},trades=[];
 const busy={FIXED:-1,DCA:-1};let balance=balanceUSD;
 // 4H trend after each closed 4H candle (EMA100/EMA200 as in the 1H strategy), for the optional filter.
 const trendAt=(()=>{if(!trendFilter||!Array.isArray(h4))return ()=>null;const closes=h4.map(r=>Number(r[4]));
  const e100=seededEMA(closes,100),e200=seededEMA(closes,200);
  const trend=h4.map((r,i)=>e100[i]==null||e200[i]==null?null:e100[i]>e200[i]&&closes[i]>e200[i]?'up':e100[i]<e200[i]&&closes[i]<e200[i]?'down':'range');
  return now=>{const i=closedUntil(h4,now)-1;return i>=0?trend[i]:null}})();
 funnel.trendBlocked=0;
 for(let i=60;i<bars.length-1;i++){
  const closeAt=Number(bars[i][6]);if(closeAt<startAt||closeAt>=endAt)continue;funnel.bars++;
  const now=closeAt+1000,det=detectScalpReversal(bars.slice(i-59,i+1),{symbol,now,settings,interval});
  if(!det.ok)continue;funnel.signals++;
  if(trendFilter&&!trendAllows(det.direction,trendAt(now))){funnel.trendBlocked++;continue}
  const k=lowerBound(m5c,closeAt+1),next=m5c[k];if(!next)continue;const dir=det.direction==='LONG'?1:-1,entry=onTick(next.o,filters.tickSize,'NEAREST');
  det.stop=onTick(det.stop,filters.tickSize,dir===1?'DOWN':'UP');
  if(dir*(entry-det.stop)<=0||dir*(det.targets[0]-entry)<=0){funnel.entrySkipped++;continue}
  const quantity=stepQuantity(riskUSD/Math.abs(entry-det.stop),filters.stepSize);
  const estimate={eligible:true,tickSize:filters.tickSize,quantityStep:filters.stepSize,entryBasis:entry,quantity,minNotional:filters.minNotional,minQuantity:filters.minQty};
  const quality=buildScalpPlan({signal:det,estimate,costs,minNetRR});
  if(!quality.ok||!positive(quantity)){funnel.qualityRejected++;continue}
  const base={strategy:'SCALP',interval,symbol,direction:det.direction,pattern:det.pattern,signalAt:closeAt,movePct:det.evidence.movePct};
  if(k>busy.FIXED){
   const t=simulateTrade({direction:det.direction,m5:m5c,startIdx:k,entryRef:entry,stop:det.stop,targets:quality.targets,quantity,maxHoldMs,costs});
   if(t){busy.FIXED=t.endIdx;trades.push({...base,book:'FIXED',stop:det.stop,targets:quality.targets,...t})}
  }
  if(k>busy.DCA){
   const profile=profileAt(m15,now,symbol,filters.tickSize);
   // Deeper adds: zones from a longer 15m window (dca.zoneDays > 3) join the 3-day zones.
   const zoneDays=dcaZoneDaysFor(interval,dca.zoneDays??DCA_DEFAULTS.zoneDays);
   const deep=profile.ok&&zoneDays>3?profileAt(m15,now,symbol,filters.tickSize,DCA_DEEP_PROFILE(zoneDays)):null;
   const zones=profile.ok?[...profile.profile.hvn,...(deep?.ok?deep.profile.hvn:[])]:[];
   const plan=profile.ok?planZoneDca({direction:det.direction,entry,atr:det.atr,zones,balanceUSD:balance,leverage:dca.leverage??DCA_DEFAULTS.leverage,
    unitPct:dca.unitPct??DCA_DEFAULTS.unitPct,tickSize:filters.tickSize,quantityStep:filters.stepSize,minQuantity:filters.minQty,minNotional:filters.minNotional,
    takerRate:costs.takerRate,settings:{maxLossPct:dca.maxLossPct??DCA_DEFAULTS.maxLossPct,maxAdds:dca.maxAdds??DCA_DEFAULTS.maxAdds}}):{ok:false,reasons:['PROFILE_'+(profile.reasons?.[0]||'UNAVAILABLE')]};
   if(!plan.ok){for(const r of plan.reasons)funnel.dcaRejected[r]=(funnel.dcaRejected[r]||0)+1}
   else{
    const t=simulateTrade({direction:det.direction,m5:m5c,startIdx:k,entryRef:entry,stop:plan.stop,targets:quality.targets,quantity:plan.unitQty,
     adds:plan.adds.map(a=>({price:a.price,quantity:a.quantity})),maxHoldMs,costs});
    if(t){busy.DCA=t.endIdx;const before=balance;balance+=t.netUSD;
     trades.push({...base,book:'DCA',stop:plan.stop,targets:quality.targets,plannedAdds:plan.adds.length,zonesFound:plan.adds.length+plan.addsDropped,plannedMaxLossPct:plan.full.maxLossPct,
      balanceBefore:before,balanceAfter:balance,pnlPctOfBalance:t.netUSD/before*100,worstOpenPctOfBalance:t.worstOpenUSD/before*100,...t})}
   }
  }
 }
 return {funnel,trades,finalBalance:balance};
}

/** Summary statistics for a list of trades (ordered by exit time for drawdown). */
export function summarize(trades){
 const list=[...trades].sort((a,b)=>a.exitAt-b.exitAt),n=list.length;
 if(!n)return {trades:0};
 const wins=list.filter(t=>t.netUSD>0),gross=wins.reduce((s,t)=>s+t.netUSD,0),loss=-list.filter(t=>t.netUSD<=0).reduce((s,t)=>s+t.netUSD,0);
 let equity=0,peak=0,dd=0;for(const t of list){equity+=t.netUSD;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity)}
 const rs=list.map(t=>t.R).filter(Number.isFinite),count=key=>list.filter(t=>t.exitReason===key).length;
 return {trades:n,wins:wins.length,winRatePct:wins.length/n*100,netUSD:equity,profitFactor:loss>0?gross/loss:null,maxDrawdownUSD:dd,
  avgR:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:null,tp1RatePct:list.filter(t=>t.tp>=1).length/n*100,
  stopPct:count('STOP')/n*100,breakevenStopPct:count('BREAKEVEN_STOP')/n*100,allTargetsPct:count('ALL_TARGETS')/n*100,timeStopPct:count('TIME_STOP')/n*100,
  avgHoldMin:list.reduce((s,t)=>s+t.holdMs,0)/n/60000,worstTradeUSD:Math.min(...list.map(t=>t.netUSD)),bestTradeUSD:Math.max(...list.map(t=>t.netUSD))};
}
export function scoreBucket(score){return score>=90?'90점 이상':score>=85?'85~89점':score>=80?'80~84점':'80점 미만'}

/** Research: textbook detectors (research/candidates.mjs) with the live exits (15m-profile
 * targets, break-even after TP1). Two books per detector: RAW and TREND (4H trend agrees). */
// bars: the signal timeframe (default 1H; 5m / 15m rows work too). fixedTargetPct: exit everything at
// that move (e.g. .005 = the blog's '20 % at 40x') instead of the 15m-profile targets.
export function backtestCandidates({symbol,h1,bars=h1,h4,m15,m5,filters,startAt,endAt=Infinity,riskUSD=6,costs=BACKTEST_COSTS,detectors=DETECTORS,fixedTargetPct=null,maxHoldMs=null}){
 const m5c=m5.map(toCandle),c=bars.map(toCandle),p=prepare(c),busy={},trades=[];
 const trendAt=now=>{const i=closedUntil(h4,now);return fourHourTrend(h4.slice(Math.max(0,i-301),i),now)};
 for(let j=210;j<c.length;j++){
  const closeAt=c[j].ct;if(closeAt<startAt||closeAt>=endAt)continue;const now=closeAt+1000;let trend;
  for(const [name,detect] of Object.entries(detectors)){
   const sig=detect(p,j);if(!sig)continue;
   const k=lowerBound(m5c,closeAt+1),next=m5c[k];if(!next)continue;
   const dir=sig.direction==='LONG'?1:-1,entry=onTick(next.o,filters.tickSize,'NEAREST'),stop=onTick(sig.stop,filters.tickSize,dir===1?'DOWN':'UP');
   if(Math.abs(entry-sig.entry)>Math.min(sig.entry*.004,p.atr[j]*.45)||dir*(entry-stop)<=0)continue;
   const quantity=stepQuantity(riskUSD/Math.abs(entry-stop),filters.stepSize);
   if(!positive(quantity)||quantity<filters.minQty||quantity*entry<filters.minNotional)continue;
   let plan;
   if(fixedTargetPct){const t=onTick(entry*(1+dir*fixedTargetPct),filters.tickSize,dir===1?'UP':'DOWN'),tk=filters.tickSize;plan={ok:true,targets:[t,t+dir*tk,t+2*dir*tk]}}
   else plan=planVolumeTargets({profileResult:profileAt(m15,now,symbol,filters.tickSize),direction:sig.direction,entry,stop,quantity,tickSize:filters.tickSize,
    quantityStep:filters.stepSize,minQuantity:filters.minQty,minNotional:filters.minNotional,contractSizeBase:1,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
    unitsVerified:true,costs,minNetRR:1.8,targetMode:'HVN_THEN_R',obstacleFraction:1},{now});
   if(!plan.ok)continue;
   if(trend===undefined)trend=trendAt(now);
   const agrees=trend!==null&&!(sig.direction==='LONG'&&trend==='down')&&!(sig.direction==='SHORT'&&trend==='up');
   for(const book of ['RAW',...(agrees?['TREND']:[])]){
    const key=name+'|'+book;if(k<=(busy[key]??-1))continue;
    const t=simulateTrade({direction:sig.direction,m5:m5c,startIdx:k,entryRef:entry,stop,targets:plan.targets,quantity,costs,maxHoldMs});
    if(!t)continue;busy[key]=t.endIdx;
    trades.push({strategy:'CANDIDATE',book:'CANDIDATE:'+book,symbol,direction:sig.direction,pattern:name,signalAt:closeAt,stop,targets:plan.targets,...t});
   }
  }
 }
 return {trades};
}
