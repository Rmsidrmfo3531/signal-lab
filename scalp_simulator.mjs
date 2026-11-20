// Testnet reversal-scalp parameter what-if simulator (#15):
// Re-evaluates logged signals (scalp-signals-YYYY-MM-DD.jsonl) and closed trades (scalp-journal.jsonl)
// under alternate parameter combinations without placing orders or mutating ledgers.
// Pure functions, zero network / I/O.

const DAY_MS=86400000;
const r2=v=>Math.round(Number(v)*100)/100;
const r4=v=>Math.round(Number(v)*1e4)/1e4;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};

const SOFT_SKIP_REASONS=new Set([
 'AGAINST_4H_TREND',
 'TP1_NET_RR_BELOW_MINIMUM',
 'SIDE_OFF',
 'SHORT_NOT_TRADED',
 'ZONE_NOT_TOUCHED',
]);

export const SCALP_SIM_PRESETS=Object.freeze([
 {key:'current',label:'현재 기준 (5% · 4H ON · 매물대 ON)',params:{minMovePct:5,trendMode:'on',zoneSignals:true,minNetRR:0}},
 {key:'move4',label:'급변 4% 완화',params:{minMovePct:4,trendMode:'on',zoneSignals:true,minNetRR:0}},
 {key:'trendOff',label:'4H 역추세 포함',params:{minMovePct:5,trendMode:'off',zoneSignals:true,minNetRR:0}},
 {key:'zoneOff',label:'매물대 OFF (급변만)',params:{minMovePct:5,trendMode:'on',zoneSignals:false,minNetRR:0}},
 {key:'rr1',label:'손익비 RR ≥ 1.0 엄격',params:{minMovePct:5,trendMode:'on',zoneSignals:true,minNetRR:1}},
]);

export function normalizeSimParams(raw={}){
 const clamp=(v,d,lo,hi)=>{const x=Number(v);return v!==undefined&&v!==''&&v!==null&&Number.isFinite(x)?Math.max(lo,Math.min(hi,x)):d};
 const days=Math.round(clamp(raw.days,7,1,30));
 const minMovePct=+clamp(raw.minMovePct,5,2.5,15).toFixed(2);
 const tm=String(raw.trendMode??'on').trim().toLowerCase();
 const trendMode=['off','false','0','no'].includes(tm)?'off':'on';
 const zs=raw.zoneSignals;
 const zoneSignals=zs===undefined||zs===null||zs===''?true:!['off','false','0','no'].includes(String(zs).trim().toLowerCase());
 const minNetRR=+clamp(raw.minNetRR,0,0,3).toFixed(2);
 const rawSides=Array.isArray(raw.sides)?raw.sides:typeof raw.sides==='string'&&raw.sides.trim()?raw.sides.split(/[\s,]+/):['LONG','SHORT'];
 const sides=['LONG','SHORT'].filter(s=>rawSides.map(x=>String(x).toUpperCase()).includes(s));
 return {days,minMovePct,trendMode,zoneSignals,minNetRR,sides:sides.length?sides:['LONG','SHORT']};
}

function tradeStats(rows){
 const n=rows.length;
 const vals=rows.map(x=>num(x?.pnl?.netUSD??x?.netUSD)).filter(v=>v!==null);
 const wins=vals.filter(v=>v>0),losses=vals.filter(v=>v<0);
 const gross=wins.reduce((a,b)=>a+b,0),loss=-losses.reduce((a,b)=>a+b,0);
 const net=vals.reduce((a,b)=>a+b,0);
 const rs=rows.map(x=>num(x?.pnl?.r??x?.rMultiple)).filter(v=>v!==null);
 return {
  trades:n,
  wins:wins.length,
  losses:losses.length,
  winRatePct:vals.length?+(wins.length/vals.length*100).toFixed(1):null,
  profitFactor:loss>0?+(gross/loss).toFixed(2):gross>0?null:null,
  netUSD:r2(net),
  avgR:rs.length?r4(rs.reduce((a,b)=>a+b,0)/rs.length):null,
 };
}

function sigKey(x){return `${String(x?.symbol||'').toUpperCase()}|${String(x?.direction||'LONG').toUpperCase()}|${Number(x?.barAt)||0}`}

function evaluateSignal(sig,params){
 const dir=String(sig.direction||'LONG').toUpperCase();
 if(!params.sides.includes(dir))return {pass:false,block:'SIM_SIDE_OFF'};
 const movePct=num(sig.evidence?.movePct);
 const kind=sig.kind||'MOVE_REVERSAL';
 const passMove=movePct!==null?movePct>=params.minMovePct:(kind==='MOVE_REVERSAL'&&params.minMovePct<=5);
 const zoneTouched=kind==='ZONE_REVERSAL'&&sig.reason!=='ZONE_NOT_TOUCHED'&&sig.reason!=='ZONE_DATA_UNAVAILABLE'&&sig.zone?.atZone!==false;
 const passZone=params.zoneSignals&&zoneTouched;
 if(!passMove&&!passZone)return {pass:false,block:kind==='ZONE_REVERSAL'&&!params.zoneSignals?'SIM_ZONE_OFF':'SIM_MOVE_BELOW_MIN'};
 if(params.trendMode==='on'&&(sig.withTrend===false||sig.reason==='AGAINST_4H_TREND'))return {pass:false,block:'SIM_AGAINST_4H_TREND'};
 const rr=num(sig.plan?.netRR??sig.plan?.tp1NetR);
 if(params.minNetRR>0){
  if(rr!==null&&rr<params.minNetRR)return {pass:false,block:'SIM_RR_BELOW_MIN'};
  if(rr===null&&sig.reason==='TP1_NET_RR_BELOW_MINIMUM')return {pass:false,block:'SIM_RR_BELOW_MIN'};
 }
 return {pass:true,block:null};
}

function runOne(dedupSignals,windowTrades,tradeByKey,params){
 const matchedTradeKeys=new Set(),filteredTradeKeys=new Set();
 const unlockedByReason={},skipBreakdown={};
 let originalEntered=0,matchedEntered=0,filteredOut=0,unlocked=0,stillBlocked=0;

 for(const sig of dedupSignals){
  const key=sigKey(sig);
  const ev=evaluateSignal(sig,params);
  if(sig.entered===true){
   originalEntered++;
   if(ev.pass){matchedEntered++;matchedTradeKeys.add(key)}
   else{filteredOut++;filteredTradeKeys.add(key);skipBreakdown[ev.block]=(skipBreakdown[ev.block]||0)+1}
  }else{
   const origReason=sig.reason||'UNKNOWN';
   if(ev.pass&&SOFT_SKIP_REASONS.has(origReason)){
    unlocked++;
    unlockedByReason[origReason]=(unlockedByReason[origReason]||0)+1;
   }else{
    stillBlocked++;
    const why=ev.pass?origReason:ev.block;
    skipBreakdown[why]=(skipBreakdown[why]||0)+1;
   }
  }
 }

 // Also evaluate closed trades in the window whose signal line was rotated out of signals files
 const matchedTrades=[],removedTrades=[];
 for(const tr of windowTrades){
  const key=sigKey(tr);
  if(matchedTradeKeys.has(key)){matchedTrades.push(tr);continue}
  if(filteredTradeKeys.has(key)){removedTrades.push(tr);continue}
  const ev=evaluateSignal({
   symbol:tr.symbol,direction:tr.direction,barAt:tr.barAt,kind:tr.kind||'MOVE_REVERSAL',
   evidence:tr.evidence,trend4h:tr.trend4h,withTrend:tr.withTrend,plan:tr.plan,zone:tr.zone,entered:true,reason:null,
  },params);
  if(ev.pass)matchedTrades.push(tr);else removedTrades.push(tr);
 }

 const simStats=tradeStats(matchedTrades);
 const removedNetUSD=r2(removedTrades.reduce((s,x)=>s+(num(x?.pnl?.netUSD??x?.netUSD)||0),0));
 return {
  simulated:{...simStats,removedTrades:removedTrades.length,removedNetUSD,unlockedSignals:unlocked,unlockedByReason},
  signalSummary:{totalSignals:dedupSignals.length,originalEntered,matchedEntered,filteredOut,unlocked,stillBlocked,skipBreakdown},
 };
}

export function simulateScalpSignals({signals=[],trades=[],params={},now=Date.now(),includePresets=true}={}){
 const p=normalizeSimParams(params);
 const since=now-p.days*DAY_MS;

 // Deduplicate signals by symbol|direction|barAt; prefer entered=true or the latest record
 const sigMap=new Map();
 for(const s of Array.isArray(signals)?signals:[]){
  if(!s||!s.symbol)continue;
  const at=num(s.at)??num(s.barAt)??0;
  if(at<since)continue;
  const k=sigKey(s),prev=sigMap.get(k);
  if(!prev||(!prev.entered&&s.entered)||(prev.entered===s.entered&&(num(s.at)||0)>=(num(prev.at)||0)))sigMap.set(k,s);
 }
 const dedupSignals=[...sigMap.values()].sort((a,b)=>(num(a.at)||0)-(num(b.at)||0));

 const windowTrades=(Array.isArray(trades)?trades:[]).filter(tr=>{
  if(!tr||!tr.symbol)return false;
  const at=num(tr.exit?.at)??num(tr.closedAt)??num(tr.barAt)??0;
  return at>=since;
 });
 const tradeByKey=new Map(windowTrades.map(tr=>[sigKey(tr),tr]));

 const baseline=tradeStats(windowTrades);
 const main=runOne(dedupSignals,windowTrades,tradeByKey,p);
 const presets=includePresets?SCALP_SIM_PRESETS.map(pr=>{
  const pp=normalizeSimParams({...p,...pr.params});
  const res=runOne(dedupSignals,windowTrades,tradeByKey,pp);
  return {key:pr.key,label:pr.label,params:pp,...res.simulated};
 }):[];

 return {
  params:p,
  window:{days:p.days,since,now},
  baseline,
  ...main,
  presets,
 };
}
