// Scalp reversal mode (paper only): a sharp 5-minute move that shows exhaustion is
// traded back toward its origin.
//  - LONG  "급락 후 반등": fast drop + volume climax + rejection candle (long lower wick
//    or close above the previous high).
//  - SHORT "급등 후 되돌림": the mirror image.
// Stop beyond the extreme; targets at 50 / 61.8 / 78.6 % retracements of the move
// (38.2 % rarely pays 1R once the entry waits for a closed rejection candle).
// Pure functions plus a tiny price tracker: no network, no orders.
import {roundDecimalToStep} from './decimal_grid.mjs';
import {seededEMA} from './indicators.mjs';

export const SCALP_INTERVAL_MS=300000;
export const SCALP_PATTERNS=Object.freeze({LONG:'급락 후 반등 롱 (5분)',SHORT:'급등 후 되돌림 숏 (5분)'});
// Timeframes the scalp check runs on. The rules count candles, so each timeframe has its own
// move size, entry wait and time stop (24 candles). minMovePct for 1m/15m is set from the
// 5m value by the square root of time (1m: 6 minutes of move, 15m: 90 minutes).
export const SCALP_TIMEFRAMES=Object.freeze({
 '1m':Object.freeze({intervalMs:60000,label:'1분',minMovePct:1.2,entryTimeoutMs:2*60000,maxHoldMs:24*60000}),
 '5m':Object.freeze({intervalMs:300000,label:'5분',minMovePct:2.5,entryTimeoutMs:5*60000,maxHoldMs:2*3600000}),
 '15m':Object.freeze({intervalMs:900000,label:'15분',minMovePct:4.3,entryTimeoutMs:15*60000,maxHoldMs:6*3600000})});
export const scalpStrategy=interval=>'SCALP_REVERSAL_'+String(interval).toUpperCase();
export const isScalpStrategy=s=>typeof s==='string'&&/^SCALP_REVERSAL_(1M|5M|15M)$/.test(s);
export const scalpPatterns=interval=>{const l=SCALP_TIMEFRAMES[interval]?.label??'5분';return {LONG:`급락 후 반등 롱 (${l})`,SHORT:`급등 후 되돌림 숏 (${l})`}};
export const SCALP_DEFAULTS=Object.freeze({
 moveWindow:6,          // the move must happen within the last 6 closed candles (30 min)
 extremeWithin:3,       // the extreme is one of the last 3 closed candles
 minMovePct:2.5,        // move size from origin to extreme, in %
 minMoveAtr:4,          // ... and at least 4 x ATR(14) of the candles before the move
 climaxVolume:3,        // largest move-candle volume >= 3 x median volume before the move
 rsiExtreme:25,         // RSI(14) reached <= 25 (LONG) / >= 75 (SHORT) during the move
 maxRetracedBeforeEntry:.3, // no entry once 30 % of the move has already come back
 wickShare:.5,          // rejection wick >= 50 % of the candle range
 stopAtr:.25,           // stop = extreme -/+ 0.25 ATR
 retracements:[.5,.618,.786],
 minNetRR:1,            // TP1 net of round-trip costs must pay at least 1R
 entryTimeoutMs:5*60000,maxHoldMs:2*3600000
});
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:NaN};

function parse(rows,now,intervalMs=SCALP_INTERVAL_MS){
 const out=[];
 for(const k of Array.isArray(rows)?rows:[]){
  if(!Array.isArray(k))return null;
  const [open,high,low,close,volume]=[k[1],k[2],k[3],k[4],k[5]].map(Number),openTime=Number(k[0]);
  if(!Number.isSafeInteger(openTime)||![open,high,low,close].every(positive)||!(volume>=0)||high<Math.max(open,close)||low>Math.min(open,close))return null;
  if(out.length&&openTime-out.at(-1).openTime!==intervalMs)return null;
  out.push({openTime,closeTime:openTime+intervalMs,open,high,low,close,volume});
 }
 // Closed candles only: the in-progress candle is dropped.
 while(out.length&&out.at(-1).closeTime>now)out.pop();
 return out;
}
function atr(candles){
 let sum=0;for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1].close;sum+=Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p))}
 return candles.length>1?sum/(candles.length-1):NaN;
}
function rsiSeries(closes,period=14){
 const out=new Array(closes.length).fill(null);if(closes.length<=period)return out;
 let gain=0,loss=0;for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)gain+=d;else loss-=d}
 gain/=period;loss/=period;out[period]=loss===0?(gain===0?50:100):100-100/(1+gain/loss);
 for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];gain=(gain*(period-1)+Math.max(d,0))/period;loss=(loss*(period-1)+Math.max(-d,0))/period;out[i]=loss===0?(gain===0?50:100):100-100/(1+gain/loss)}
 return out;
}

/** Evaluate the latest closed candles (1m / 5m / 15m) for a reversal entry. */
export function detectScalpReversal(rows,{symbol,now=Date.now(),settings={},interval='5m'}={}){
 const tf=SCALP_TIMEFRAMES[interval];if(!tf)return {ok:false,reasons:['SCALP_INTERVAL_UNSUPPORTED']};
 const s={...SCALP_DEFAULTS,minMovePct:tf.minMovePct,entryTimeoutMs:tf.entryTimeoutMs,maxHoldMs:tf.maxHoldMs,...settings},candles=parse(rows,now,tf.intervalMs);
 if(!candles)return {ok:false,reasons:['KLINE_SCHEMA_OR_SEQUENCE_INVALID']};
 const need=s.moveWindow+30;
 if(candles.length<need)return {ok:false,reasons:['NOT_ENOUGH_CANDLES']};
 const last=candles.at(-1);
 if(now-last.closeTime>tf.intervalMs+90000)return {ok:false,reasons:['CANDLES_STALE']};
 const window=candles.slice(-s.moveWindow-1),before=candles.slice(-s.moveWindow-25,-s.moveWindow-1);
 const baseAtr=atr(candles.slice(-s.moveWindow-17,-s.moveWindow-1)),baseVolume=median(before.map(c=>c.volume));
 const rsi=rsiSeries(candles.map(c=>c.close)).slice(-s.moveWindow-1);
 if(!positive(baseAtr))return {ok:false,reasons:['ATR_UNAVAILABLE']};
 const results=[];
 for(const direction of ['LONG','SHORT']){
  const dir=direction==='LONG'?1:-1,reasons=[];
  // Extreme = lowest low (LONG) / highest high (SHORT) of the window, in the last few candles.
  let ex=0;window.forEach((c,i)=>{if(dir===1?c.low<window[ex].low:c.high>window[ex].high)ex=i});
  const extreme=dir===1?window[ex].low:window[ex].high;
  if(ex<window.length-s.extremeWithin)reasons.push('EXTREME_NOT_RECENT');
  const prior=window.slice(0,ex+1),origin=dir===1?Math.max(...prior.map(c=>c.high)):Math.min(...prior.map(c=>c.low));
  const move=dir*(origin-extreme),movePct=move/origin*100;
  if(!(movePct>=s.minMovePct))reasons.push('MOVE_TOO_SMALL');
  if(!(move>=s.minMoveAtr*baseAtr))reasons.push('MOVE_NOT_UNUSUAL_FOR_ATR');
  const climax=Math.max(...window.map(c=>c.volume));
  if(!(positive(baseVolume)&&climax>=s.climaxVolume*baseVolume))reasons.push('NO_VOLUME_CLIMAX');
  const rsiPeak=dir===1?Math.min(...rsi.filter(Number.isFinite)):Math.max(...rsi.filter(Number.isFinite));
  if(!(dir===1?rsiPeak<=s.rsiExtreme:rsiPeak>=100-s.rsiExtreme))reasons.push('RSI_NOT_EXTREME');
  // Rejection on the last closed candle.
  const range=last.high-last.low,wick=dir===1?Math.min(last.open,last.close)-last.low:last.high-Math.max(last.open,last.close);
  const previous=candles.at(-2),recovered=dir===1?last.close>previous.high:last.close<previous.low;
  const rejected=range>0&&wick/range>=s.wickShare&&dir*(last.close-(last.high+last.low)/2)>=0;
  if(!(recovered||rejected))reasons.push('NO_REJECTION_CANDLE');
  if(dir*(last.close-last.open)<0&&!rejected)reasons.push('LAST_CANDLE_AGAINST');
  const retraced=dir*(last.close-extreme)/move;
  if(!(retraced<=s.maxRetracedBeforeEntry))reasons.push('MOVE_ALREADY_RETRACED');
  const entry=last.close,stop=extreme-dir*s.stopAtr*baseAtr;
  let levels=s.retracements.map(f=>extreme+dir*f*move);
  // Entry already beyond the first level: shift to the next ones.
  if(dir*(levels[0]-entry)<=0)levels=[.618,.786,1].map(f=>extreme+dir*f*move);
  if(levels.some(p=>dir*(p-entry)<=0))reasons.push('TARGETS_BEHIND_ENTRY');
  results.push({direction,ok:reasons.length===0,reasons,entry,stop,targets:levels,atr:baseAtr,
   pattern:scalpPatterns(interval)[direction],barAt:last.closeTime,interval,entryTimeoutMs:s.entryTimeoutMs,maxHoldMs:s.maxHoldMs,
   evidence:{symbol,origin,extreme,movePct:Number(movePct.toFixed(3)),moveAtr:Number((move/baseAtr).toFixed(2)),
    climaxVolumeRatio:positive(baseVolume)?Number((climax/baseVolume).toFixed(2)):null,rsiPeak:Number.isFinite(rsiPeak)?Number(rsiPeak.toFixed(1)):null,
    retracedPct:Number((retraced*100).toFixed(1)),rejection:recovered?'CLOSE_BEYOND_PREVIOUS':rejected?'WICK':'NONE',
    candleCloseAt:last.closeTime,interval}});
 }
 const hit=results.find(r=>r.ok);
 if(hit)return {ok:true,...hit,strategy:scalpStrategy(interval)};
 // Report the side that came closest (fewest failed rules).
 const best=results.reduce((a,b)=>b.reasons.length<a.reasons.length?b:a);
 return {ok:false,direction:best.direction,reasons:best.reasons,evidence:best.evidence};
}

/** Paper plan in the shape PaperEngine expects (40/35/25 parts on the lot grid). */
export function buildScalpPlan({signal,estimate,costs,minNetRR=SCALP_DEFAULTS.minNetRR}){
 const reasons=[],dir=signal.direction==='LONG'?1:-1;
 if(!estimate?.eligible)return {ok:false,reasons:['EXECUTION_ESTIMATE_NOT_ELIGIBLE']};
 const tick=estimate.tickSize,step=estimate.quantityStep,entry=estimate.entryBasis,quantity=estimate.quantity;
 let targets;
 try{targets=signal.targets.map(p=>Number(roundDecimalToStep(p,tick,dir===1?'DOWN':'UP')))}catch{return {ok:false,reasons:['TARGET_GRID_INVALID']}}
 if(targets.some((p,i)=>dir*(p-entry)<=0||i>0&&dir*(p-targets[i-1])<=0))reasons.push('TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY');
 let parts;
 // 40 % and 35 % round down to the lot step; the last part takes the remainder.
 try{parts=[.4,.35].map(f=>Number(roundDecimalToStep(quantity*f*(1+1e-9),step,'DOWN')));parts.push(Number(roundDecimalToStep(quantity-parts[0]-parts[1]+step*1e-6,step,'DOWN')))}catch{return {ok:false,reasons:['QUANTITY_GRID_INVALID']}}
 if(Math.abs(parts.reduce((a,b)=>a+b,0)-quantity)>step/2)reasons.push('QUANTITY_SPLIT_INVALID');
 if(parts.some(p=>!(p>0)||p<(estimate.minQuantity||0)))reasons.push('QUANTITY_SPLIT_BELOW_MINIMUM');
 const roundTrip=entry*(2*costs.takerRate+(2*costs.slippageBps+Math.max(0,costs.spreadBps||0))/10000+Math.abs(costs.fundingRate||0)),risk=Math.abs(entry-signal.stop);
 const netRR=(dir*(targets[0]-entry)-roundTrip)/(risk+roundTrip);
 if(!(netRR>=minNetRR))reasons.push('TP1_NET_RR_BELOW_MINIMUM');
 if(reasons.length)return {ok:false,reasons,estimatedNetRR:Number.isFinite(netRR)?netRR:null};
 return {ok:true,code:'SCALP_PLAN_READY',targets,quantity,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
  parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:parts[i],source:'RETRACEMENT'})),
  minNotional:estimate.minNotional,minQuantity:estimate.minQuantity,quantityStep:step,tickSize:tick,costAssumptions:costs,
  estimatedNetRR:netRR,profileEvidence:{dataSource:'BINANCE_KLINES_'+String(signal.interval||'5m').toUpperCase(),methodology:'MOVE_RETRACEMENT_50_62_79',...signal.evidence},
  strategy:signal.strategy||scalpStrategy(signal.interval||'5m'),calculationOnly:true,executionApproved:false};
}

/** Per-minute high/low of every streamed price, kept for 40 minutes, to find the few
 * symbols worth a 5m candle request. */
export class MoveTracker{
 constructor({keepMs=110*60000}={}){this.keepMs=keepMs;this.series=new Map()}
 record(symbol,price,at){
  if(!positive(price)||!Number.isFinite(at))return;
  const minute=Math.floor(at/60000);let list=this.series.get(symbol);if(!list)this.series.set(symbol,list=[]);
  const lastBucket=list.at(-1);
  if(lastBucket?.minute===minute){lastBucket.high=Math.max(lastBucket.high,price);lastBucket.low=Math.min(lastBucket.low,price);lastBucket.last=price}
  else{list.push({minute,high:price,low:price,last:price});const cutoff=minute-this.keepMs/60000;while(list.length&&list[0].minute<cutoff)list.shift()}
 }
 /** Symbols whose price moved at least minMovePct inside windowMs, largest first. */
 candidates({now=Date.now(),windowMs=35*60000,minMovePct=SCALP_DEFAULTS.minMovePct,limit=6}={}){
  const from=Math.floor((now-windowMs)/60000),out=[];
  for(const [symbol,list] of this.series){
   const recent=list.filter(b=>b.minute>=from);if(recent.length<3)continue;
   const high=Math.max(...recent.map(b=>b.high)),low=Math.min(...recent.map(b=>b.low));
   const movePct=(high-low)/low*100;if(movePct>=minMovePct)out.push({symbol,movePct});
  }
  return out.sort((a,b)=>b.movePct-a.movePct).slice(0,limit);
 }
}

/** 4H trend from closed candles (EMA100/EMA200, as the 1H strategy uses): 'up' | 'down' | 'range' | null. */
export function fourHourTrend(rows,now=Date.now()){
 const closed=(Array.isArray(rows)?rows:[]).filter(r=>Number(r?.[6])<now),closes=closed.map(r=>Number(r[4]));
 if(closes.length<200||!closes.every(positive))return null;
 const e100=seededEMA(closes,100).at(-1),e200=seededEMA(closes,200).at(-1),c=closes.at(-1);
 return e100>e200&&c>e200?'up':e100<e200&&c<e200?'down':'range';
}
/** 180-day backtest: fading the 4H trend lost most; no rebound LONG in a downtrend, no fade SHORT in an uptrend. */
export function trendAllows(direction,trend){return trend!==null&&!(direction==='LONG'&&trend==='down')&&!(direction==='SHORT'&&trend==='up')}

/**
 * Data-calibrated 100-point scalp setup scoring (40-coin BingX 5m empirical Train/OOS backtest, pure 5-point increments).
 * Weights sum strictly to 100:
 *   movePct (25) + trend4h (20) + btcTrend4h (15) + moveAtr (15) + retracedPct (10)
 *   + climaxVolume (5) + netRR (5) + rsiExtreme (5) = 100.
 */
export const SCALP_SCORE_DEFAULTS=Object.freeze({
 minScore:65,      // B-grade entry floor (<65 blocked as negative EV in Train & OOS)
 highScore:70,     // A/S-grade size boost threshold
 topScore:80,      // S-grade display threshold
 highSizeMult:1.25 // Risk sizing multiplier for A/S-grade setups
});
export const SCALP_SCORE_WEIGHTS=Object.freeze({
 movePct:25,
 trend4h:20,
 btcTrend4h:15,
 moveAtr:15,
 retracedPct:10,
 climaxVolume:5,
 netRR:5,
 rsiExtreme:5
});

function trendRelation(direction,trend){
 if(trend!=='up'&&trend!=='down')return 'range';
 return trendAllows(direction,trend)?'aligned':'against';
}

export function scoreScalpSetup({direction='LONG',evidence={},trend4h=null,btcTrend4h=null,netRR=null,config={}}={}){
 const dir=direction==='SHORT'?'SHORT':'LONG';
 const minScore=Number.isFinite(Number(config.minScore))?Number(config.minScore):SCALP_SCORE_DEFAULTS.minScore;
 const highScore=Number.isFinite(Number(config.highScore))?Number(config.highScore):SCALP_SCORE_DEFAULTS.highScore;
 const topScore=Number.isFinite(Number(config.topScore))?Number(config.topScore):SCALP_SCORE_DEFAULTS.topScore;
 const highSizeMult=Number.isFinite(Number(config.highScoreSizeMult??config.highSizeMult))&&Number(config.highScoreSizeMult??config.highSizeMult)>=1
  ?Number(config.highScoreSizeMult??config.highSizeMult):SCALP_SCORE_DEFAULTS.highSizeMult;

 const movePctVal=Number(evidence?.movePct);
 const moveAtrVal=Number(evidence?.moveAtr);
 const retracedVal=Number(evidence?.retracedPct);
 const volVal=Number(evidence?.climaxVolumeRatio);
 const rsiVal=Number(evidence?.rsiPeak);
 const rrVal=Number(netRR);

 // 1. Move % Size (25 pts) — strongest monotonic predictor across Train & OOS
 const movePct=Number.isFinite(movePctVal)?(movePctVal>=5.0?25:movePctVal>=3.5?15:movePctVal>=2.5?5:0):0;
 // 2. Coin 4H Trend (20 pts)
 const coinRel=trendRelation(dir,trend4h);
 const trend4hPts=coinRel==='aligned'?20:coinRel==='range'?10:0;
 // 3. BTC 4H Trend (15 pts)
 const btcRel=trendRelation(dir,btcTrend4h);
 const btcTrend4hPts=btcRel==='aligned'?15:btcRel==='range'?10:0;
 // 4. Move ATR Sweet Spot (15 pts) — 3.0~4.5x healthy mean reversion; >=6.0x news/liquidation blowoffs score 0
 const moveAtr=Number.isFinite(moveAtrVal)?(moveAtrVal>=3.0&&moveAtrVal<4.5?15:moveAtrVal>=4.5&&moveAtrVal<6.0?10:0):0;
 // 5. Retraced Before Entry (10 pts) — confirmed bounce 15~30% beats catching falling knives (<=10%)
 const retracedPct=Number.isFinite(retracedVal)?(retracedVal>=15&&retracedVal<=30?10:retracedVal>10&&retracedVal<15?5:0):0;
 // 6. Climax Volume (5 pts)
 const climaxVolume=Number.isFinite(volVal)&&volVal>=5.0?5:0;
 // 7. TP1 Net RR (5 pts)
 const netRRPts=Number.isFinite(rrVal)&&rrVal>=1.2?5:0;
 // 8. RSI Extreme (5 pts)
 const rsiExtreme=Number.isFinite(rsiVal)&&(dir==='LONG'?rsiVal<=22:rsiVal>=78)?5:0;

 const breakdown={movePct,trend4h:trend4hPts,btcTrend4h:btcTrend4hPts,moveAtr,retracedPct,climaxVolume,netRR:netRRPts,rsiExtreme};
 const score=movePct+trend4hPts+btcTrend4hPts+moveAtr+retracedPct+climaxVolume+netRRPts+rsiExtreme;
 const grade=score>=topScore?'S':score>=highScore?'A':score>=Math.max(1,minScore)?'B':score>=50?'C':'D';
 const pass=minScore<=0||score>=minScore;
 const sizeMult=pass?(score>=highScore?highSizeMult:1):0;
 const shortBreakdown=`급변${movePct}·4H${trend4hPts}·BTC${btcTrend4hPts}·ATR${moveAtr}·반등${retracedPct}·거래량${climaxVolume}·RR${netRRPts}·RSI${rsiExtreme}`;
 const summary=`${score}점(${grade}급) · ${shortBreakdown}`;
 return {score,maxScore:100,grade,pass,minScore,highScore,sizeMult,breakdown,shortBreakdown,summary};
}

