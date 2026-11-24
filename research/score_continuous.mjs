// Re-score recorded scalp candidates: old 5-point steps (main before 2026-11-25) vs the 1-point curves.
// Read-only. Usage: node research/score_continuous.mjs <signal-lab-reports/scalp folder>
// Input: signals-*.jsonl (records with score.breakdown and plan.netRR) and trades.jsonl (joined to its signal by
// symbol|direction|barAt for netRR). Total = base + recorded OI/CVD bonus (0 when orderflow was not fetched).
import fs from 'node:fs';import path from 'node:path';
import {scoreScalpSetup,trendAllows} from '../scalp_reversal.mjs';

const DIR=process.argv[2];if(!DIR){console.error('usage: node research/score_continuous.mjs <scalp report folder>');process.exit(2)}
/** The step rules as they were on main (8d51347) — kept here only for this comparison. */
export function oldStepScore({direction='LONG',evidence={},trend4h=null,btcTrend4h=null,netRR=null}){
 const dir=direction==='SHORT'?'SHORT':'LONG',rel=t=>t!=='up'&&t!=='down'?'range':trendAllows(dir,t)?'aligned':'against';
 const m=Number(evidence?.movePct),a=Number(evidence?.moveAtr),r=Number(evidence?.retracedPct),v=Number(evidence?.climaxVolumeRatio),s=Number(evidence?.rsiPeak),rr=Number(netRR);
 const rej=evidence?.rejection==='WICK'||evidence?.rejection==='CLOSE_BEYOND_PREVIOUS',c=rel(trend4h),b=rel(btcTrend4h);
 const bd={movePct:Number.isFinite(m)?(m>=5?25:m>=3.5?15:m>=2.5?5:0):0,trend4h:c==='aligned'?20:c==='range'?10:0,btcTrend4h:b==='aligned'?15:b==='range'?10:0,
  moveAtr:Number.isFinite(a)?(a>=3&&a<4.5?15:a>=4.5&&a<6?10:a>=6?5:0):0,
  retracedPct:Number.isFinite(r)?(r>=15&&r<=30?10:((r>10&&r<15)||(r>30&&r<=35)||rej)?5:0):(rej?5:0),
  climaxVolume:Number.isFinite(v)&&v>=5?5:0,netRR:Number.isFinite(rr)&&rr>=1.2?5:0,rsiExtreme:Number.isFinite(s)&&(dir==='LONG'?s<=22:s>=78)?5:0};
 return {score:Object.values(bd).reduce((x,y)=>x+y,0),breakdown:bd};
}
const tier=s=>s>=80?{t:'S',m:1.4}:s>=75?{t:'A+',m:1.2}:s>=70?{t:'A',m:1}:{t:'B',m:.75}; // scalpScoreTierMultiplier
const read=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
const signals=fs.readdirSync(DIR).filter(f=>/^signals-.*\.jsonl$/.test(f)).sort().flatMap(f=>read(path.join(DIR,f)));
const trades=fs.existsSync(path.join(DIR,'trades.jsonl'))?read(path.join(DIR,'trades.jsonl')):[];
const key=x=>`${x.symbol}|${x.direction}|${x.barAt}`;
function rescore(x,netRR){
 const sc=x.score;if(!sc?.breakdown)return null;
 const input={direction:x.direction,evidence:x.evidence,trend4h:x.trend4h??null,btcTrend4h:x.btcTrend4h??null,netRR};
 const o=oldStepScore(input),n=scoreScalpSetup(input),bonus=(Number(sc.oiBonus)||0)+(Number(sc.cvdBonus)||0);
 return {min:Number(sc.minScore)||65,bonus,bonusKnown:sc.orderflow!=null||sc.oiBonus!=null,oldTotal:Math.min(100,o.score+bonus),newBase:n.score,newTotal:Math.min(100,n.score+bonus)};
}
const scored=signals.filter(x=>x.score?.breakdown).map(x=>({x,r:rescore(x,x.plan?.netRR??null)}));
const pass=(r,k)=>r[k]>=r.min;
const skipped=scored.filter(s=>s.x.reason==='SCORE_BELOW_MINIMUM');
const nowEnter=skipped.filter(s=>pass(s.r,'newTotal'));
const sigByKey=new Map(signals.filter(x=>x.entered&&x.plan?.netRR!=null).map(x=>[key(x),x]));
const tr=trades.map(t=>({t,r:rescore(t,sigByKey.get(key(t))?.plan?.netRR??t.plan?.tp1NetR??null)})).filter(z=>z.r);
const blocked=tr.filter(z=>!pass(z.r,'newTotal'));
const out={
 period:[Math.min(...signals.map(x=>x.at)),Math.max(...signals.map(x=>x.at))].map(t=>new Date(t).toISOString()),
 scoredCandidates:scored.length,
 passOld:scored.filter(s=>pass(s.r,'oldTotal')).length,passNew:scored.filter(s=>pass(s.r,'newTotal')).length,
 passRecordedAtTheTime:scored.filter(s=>s.x.score.score>=(Number(s.x.score.minScore)||65)).length,
 change:{up:scored.filter(s=>s.r.newTotal>s.r.oldTotal).length,down:scored.filter(s=>s.r.newTotal<s.r.oldTotal).length,
  mean:+(scored.reduce((a,s)=>a+s.r.newTotal-s.r.oldTotal,0)/Math.max(1,scored.length)).toFixed(2)},
 scoreGateSkips:skipped.length,
 nowEnter:nowEnter.map(s=>`${key(s.x)} ${s.r.oldTotal}->${s.r.newTotal}`),
 nowEnterVsOldRules:nowEnter.filter(s=>!pass(s.r,'oldTotal')).length,
 nowEnterUniqueSymbolSide:new Set(nowEnter.map(s=>`${s.x.symbol}|${s.x.direction}`)).size,
 maybeWithUnfetchedBonus:skipped.filter(s=>!s.r.bonusKnown&&s.r.newBase>=s.r.min-10&&s.r.newTotal<s.r.min).length,
 trades:trades.length,tradesScored:tr.length,
 tradesBlockedByNew:blocked.map(z=>({key:key(z.t),old:z.r.oldTotal,new:z.r.newTotal,netUSD:z.t.pnl?.netUSD??null})),
 tradesBlockedNetUSD:+blocked.reduce((a,z)=>a+(Number(z.t.pnl?.netUSD)||0),0).toFixed(2),
 tierUp:tr.filter(z=>tier(z.r.newTotal).m>tier(z.r.oldTotal).m).length,tierDown:tr.filter(z=>tier(z.r.newTotal).m<tier(z.r.oldTotal).m).length,
 tierUpNetUSD:+tr.filter(z=>tier(z.r.newTotal).m>tier(z.r.oldTotal).m).reduce((a,z)=>a+(Number(z.t.pnl?.netUSD)||0),0).toFixed(2),
};
console.log(JSON.stringify(out,null,1));
