import {STRICT_MIN_SCORE,SCORE_VERSION} from './quality.mjs';
import {signalKey} from './paper.mjs';
import {createHash} from 'node:crypto';
import {TP_R_MULTIPLES} from './public/trade_plan.js';

// This bridge consumes the existing scanner's final approval, not an arbitrary
// chart label or quality score. It contains no exchange or persistence transport.
const SOURCES=new Set(['SYNTHETIC_FIXTURE','SIGNAL_LAB_SCANNER','REAL_PUBLIC_READ_ONLY','WINDOWS_DIAGNOSTIC_REPLAY']);
const REQUIRED=['4hAligned','volume','candle','liquidity','hourlyLiquidity','stop','unobstructed','fresh'];
const NAME=/^([A-Z0-9]{2,20})-([A-Z0-9]{2,12})-PERPETUAL$/;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Normalize a final Signal Lab 1H/4H decision for the isolated PAPER engine.
 * instrumentName is an explicit mapping candidate supplied by the caller; it
 * does not establish OrangeX listing, unit, cost or execution verification.
 * Native analyze() proves the closed 4H trend via its required 4hAligned/fresh
 * checks and dataValidation. It does not expose the exact 4H close timestamp,
 * so that missing timestamp is never reconstructed from validUntil or 1H time.
 */
export function normalizeOrangeXPaperSignal(row,{now=Date.now(),source='UNOBSERVED',instrumentName,
 confirmationEvidence,maxSignalAgeMs=2*3600000,maxAnalysisAgeMs=20*60000}={}){
 const reasons=[];
 if(!positive(now)||!positive(maxSignalAgeMs)||!positive(maxAnalysisAgeMs))return {ok:false,reasons:['INVALID_CLOCK_OR_LIMIT']};
 if(!plain(row))return {ok:false,reasons:['SIGNAL_UNOBSERVED']};
 if(!SOURCES.has(source))reasons.push('SIGNAL_SOURCE_UNVERIFIED');
 const name=instrumentName??row.instrumentName,match=typeof name==='string'?NAME.exec(name):null;
 if(!match||typeof row.symbol!=='string'||row.symbol!==match[1]+match[2])reasons.push('CONTRACT_MAPPING_UNVERIFIED');
 if(!['LONG','SHORT'].includes(row.direction))reasons.push('SIGNAL_DIRECTION_INVALID');
 if(typeof row.pattern!=='string'||!row.pattern.trim()||row.pattern.length>200)reasons.push('PATTERN_UNOBSERVED');
 if(row.patternConfirmed!==true||row.patternInvalidated===true)reasons.push('PATTERN_NOT_CONFIRMED');
 if(row.patternTimeframe!=='1h'||row.timeframe!==undefined&&row.timeframe!=='1h')reasons.push('PATTERN_TIMEFRAME_NOT_1H');
 if(row.trendTimeframe!==undefined&&row.trendTimeframe!=='4h')reasons.push('TREND_TIMEFRAME_NOT_4H');
 if(row.dataValidation?.valid!==true)reasons.push('CANDLE_SERIES_UNVERIFIED');
 if(!positive(row.patternConfirmedAt)||row.patternConfirmedAt>now||now-row.patternConfirmedAt>maxSignalAgeMs)
  reasons.push('PATTERN_CLOCK_INVALID_OR_STALE');
 if(!positive(row.scannedAt)||row.scannedAt>now||now-row.scannedAt>maxAnalysisAgeMs)
  reasons.push('ANALYSIS_STALE');
 const quality=row.quality,checks=Array.isArray(quality?.checks)?quality.checks:[];
 if(row.technicalQualified!==true||quality?.passed!==true||!Number.isFinite(row.score)||row.score<STRICT_MIN_SCORE||
  !Array.isArray(quality?.failed)||quality.failed.length>0)reasons.push('TECHNICAL_CHECK_FAILED');
 if(!positive(quality?.validUntil)||now>quality.validUntil||!positive(quality?.checkedAt)||quality.checkedAt>now)
  reasons.push('CONFIRMED_CANDLES_STALE');
 const modern=row.scoreVersion===SCORE_VERSION;
 const required=modern?['scoreData','confirmedPattern','fresh1h','fresh4h','stopValid','chase','atrRisk','confirmedActivity','btc4h']:REQUIRED;
 const proofChecks=modern?row.technicalValidation?.checks:checks;
 for(const key of required){
  const proof=(Array.isArray(proofChecks)?proofChecks:[]).filter(check=>plain(check)&&check.key===key);
  if(proof.length!==1||!modern&&proof[0].required!==true||proof[0].passed!==true)reasons.push('REQUIRED_'+key.toUpperCase()+'_UNVERIFIED');
 }
 const aligned=row.direction==='LONG'?row.trend==='up':row.direction==='SHORT'?row.trend==='down':false;
 if(!aligned&&!modern)reasons.push('CLOSED_4H_TREND_UNALIGNED');
 if(row.qualified!==true||row.decision?.ready!==true||row.decision?.pattern!==true||row.decision?.technical!==true||
  row.decision?.venue!==true||row.decision?.execution?.eligible!==true)reasons.push('FINAL_SIGNAL_NOT_APPROVED');
 const sign=row.direction==='LONG'?1:-1;
 if(!positive(row.entry)||!positive(row.stop)||sign*(row.entry-row.stop)<=0)reasons.push('PROTECTIVE_STOP_INVALID');
 const explicitTargets=Object.hasOwn(row,'targets');
 if(explicitTargets&&!Array.isArray(row.targets))reasons.push('TARGET_STRUCTURE_INVALID');
 const suppliedTargets=Array.isArray(row.targets)?row.targets:[row.target1,row.target2,row.target3];
 // Native scanner targets are reused exactly. For a genuine missing target set,
 // the PAPER engine derives R2/R3/R4 after entry-grid validation.
 const hasAnyTarget=explicitTargets||suppliedTargets.some(value=>value!==undefined&&value!==null);
 const targets=hasAnyTarget?suppliedTargets:undefined;
 if(modern&&(row.managementVersion!=='VOLUME_PROFILE_V1'||row.targetPlan?.ok!==true||!targets))reasons.push('TP_PROFILE_UNAVAILABLE');
 if(targets&&(targets.length!==3||targets.some((value,index)=>!positive(value)||sign*(value-row.entry)<=0||
  index>0&&sign*(value-targets[index-1])<=0)))reasons.push('TARGET_STRUCTURE_INVALID');
 if(confirmationEvidence!==undefined){
  const proof=confirmationEvidence;
  if(!plain(proof)||proof.patternTimeframe!=='1h'||proof.trendTimeframe!=='4h')reasons.push('EXPLICIT_CANDLE_TIMEFRAMES_INVALID');
  if(!positive(proof?.patternClosedAt)||proof.patternClosedAt!==row.patternConfirmedAt||proof.patternClosedAt>now||
   !positive(proof?.trendClosedAt)||proof.trendClosedAt>now||now-proof.trendClosedAt>255*60000)
   reasons.push('EXPLICIT_CLOSED_CANDLE_CLOCKS_INVALID');
 }
 if(reasons.length)return {ok:false,reasons:[...new Set(reasons)]};
 const evidence={basis:'SIGNAL_LAB_REQUIRED_CLOSED_CANDLE_CHECKS',patternTimeframe:'1h',trendTimeframe:'4h',
  patternClosedAt:row.patternConfirmedAt,trendClosedAt:confirmationEvidence?.trendClosedAt??null,
  qualityCheckedAt:quality.checkedAt,qualityValidUntil:quality.validUntil};
 const sourceSignalKey=signalKey({market:'CRYPTO',symbol:row.symbol,direction:row.direction,pattern:row.pattern,barAt:row.patternConfirmedAt});
 return {ok:true,reasons:[],signal:{
  // Native patterns include Korean text. Hash the complete existing identity;
  // never discard a pattern component to fit the PAPER engine's ASCII keys.
  key:'ORANGEX_PAPER:'+createHash('sha256').update(sourceSignalKey).digest('hex'),sourceSignalKey,
  symbol:row.symbol,instrumentName:name,direction:row.direction,entry:row.entry,stop:row.stop,
  ...(targets?{targets:[...targets]}:{}),pattern:row.pattern,patternConfirmedAt:row.patternConfirmedAt,
  ...(modern?{managementVersion:'VOLUME_PROFILE_V1',targetPlan:structuredClone(row.targetPlan),
   moveStopToBreakeven:row.moveStopToBreakeven!==false,breakevenMode:row.breakevenMode==='COST_COVERED'?'COST_COVERED':'ENTRY'}:{}),
  timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,signalSource:source,dataSource:source,
  confirmationEvidence:evidence,score:row.score,scoreMeaning:'RULE_COMPLETENESS_NOT_WIN_PROBABILITY',
  realDataAutoEntryEnabled:false,liveOrdersEnabled:false}};
}

/** Final synthetic plan grid alignment. The raw scanner prices are retained,
 * and the engine sizes risk again using the wider protective stop and observed
 * entry depth. Alignment alone verifies neither listing nor missing costs.
 */
export function alignOrangeXPaperSignal(signal,contract){
 const reasons=[];
 if(!plain(signal))return {ok:false,reasons:['SIGNAL_UNOBSERVED']};
 if(signal.dataSource!=='SYNTHETIC_FIXTURE'||contract?.source!=='SYNTHETIC_FIXTURE')reasons.push('REAL_DATA_AUTO_ENTRY_DISABLED');
 if(contract?.unitsVerifiedForSimulation!==true||!positive(contract?.priceTick))reasons.push('PRICE_TICK_UNVERIFIED');
 if(contract?.instrumentName!==signal.instrumentName||contract?.symbol!==signal.symbol)reasons.push('CONTRACT_MAPPING_UNVERIFIED');
 if(!['LONG','SHORT'].includes(signal.direction)||!positive(signal.entry)||!positive(signal.stop))reasons.push('PLAN_STRUCTURE_INVALID');
 if(reasons.length)return {ok:false,reasons};
 const dir=signal.direction==='LONG'?1:-1;
 if(dir*(signal.entry-signal.stop)<=0)return {ok:false,reasons:['PROTECTIVE_STOP_INVALID']};
 if(signal.managementVersion==='VOLUME_PROFILE_V1'&&(signal.targetPlan?.ok!==true||!Array.isArray(signal.targets)))return {ok:false,reasons:['TP_PROFILE_UNAVAILABLE']};
 const rawTargets=signal.targets===undefined?TP_R_MULTIPLES.map(r=>signal.entry+dir*Math.abs(signal.entry-signal.stop)*r):signal.targets;
 if(!Array.isArray(rawTargets)||rawTargets.length!==3||rawTargets.some((price,index)=>!positive(price)||
  dir*(price-signal.entry)<=0||index>0&&dir*(price-rawTargets[index-1])<=0))return {ok:false,reasons:['TARGET_STRUCTURE_INVALID']};
 const tick=contract.priceTick;
 const align=(price,up)=>{
  const units=price/tick,nearest=Math.round(units);
  if(!Number.isSafeInteger(nearest))return null;
  const count=Math.abs(units-nearest)<=Math.max(1,Math.abs(units))*Number.EPSILON*16?nearest:up?Math.ceil(units):Math.floor(units);
  if(!Number.isSafeInteger(count))return null;
  const value=count*tick;return positive(value)?value:null;
 };
 const entry=align(signal.entry,dir===1),stop=align(signal.stop,dir!==1),targets=rawTargets.map(price=>align(price,dir===1));
 if(!positive(entry)||!positive(stop)||dir*(entry-stop)<=0||targets.some((price,index)=>!positive(price)||
  dir*(price-entry)<=0||index>0&&dir*(price-targets[index-1])<=0))return {ok:false,reasons:['PRICE_GRID_PLAN_INVALID']};
 const sourcePrices={entry:signal.entry,stop:signal.stop,targets:[...rawTargets]};
 return {ok:true,reasons:[],sourcePrices,signal:{...structuredClone(signal),entry,stop,targets,
  sourcePrices:structuredClone(sourcePrices),priceAlignment:{priceTick:tick,source:'SYNTHETIC_FIXTURE',
   policy:dir===1?'ENTRY_CEIL_STOP_FLOOR_TARGETS_CEIL':'ENTRY_FLOOR_STOP_CEIL_TARGETS_FLOOR',riskMustBeRecalculated:true}}};
}
