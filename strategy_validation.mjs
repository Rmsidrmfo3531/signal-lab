// Offline research only. This module neither submits orders nor creates fills
// from candle highs/lows. The bundled baseline never imports current scoring.
import {analyze as analyzeCurrent} from './engine.mjs';
import {analyze as analyzeLegacy} from './research/legacy_v58/engine.mjs';
import {SCORE_VERSION,STRICT_MIN_SCORE,SCORE_WEIGHTS} from './quality.mjs';
import {buildVolumeProfile,quantizeVolumeStep} from './volume_profile.mjs';
import {planVolumeTargets} from './volume_targets.mjs';

const HOUR=3600000,FOUR_HOURS=4*HOUR;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const stamp=x=>Number.isSafeInteger(x)&&x>=1e12&&x<8640000000000000;
const STRATEGIES=Object.freeze(['LEGACY_V58','ISSUE6_VOLUME']);
const SOURCES=new Set(['SYNTHETIC_TEST','HISTORICAL_REPLAY']);
const COST_FIELDS=['feesUSD','slippageUSD','spreadUSD','fundingUSD'];
const unknownMetrics=reason=>({status:'UNVERIFIED',reason,trades:null,wins:null,losses:null,winRate:null,
 netPnLUSD:null,grossReferencePnLUSD:null,profitFactor:null,maxDrawdownUSD:null,maxDrawdownPercent:null,
 feesUSD:null,slippageUSD:null,spreadUSD:null,fundingUSD:null,averageRealizedR:null,expectancyUSD:null});
const closeAt=(row,interval)=>Array.isArray(row)?Number(row[6]):plain(row)?Number(row.closeTime??Number(row.time)+interval-1):NaN;
function prefix(rows,cutoff,interval,limit){
 return rows.filter(row=>stamp(closeAt(row,interval))&&closeAt(row,interval)<cutoff&&(!plain(row)||row.closed!==false))
  .sort((a,b)=>closeAt(a,interval)-closeAt(b,interval)).slice(-limit);
}
const closePrice=row=>Array.isArray(row)?Number(row[4]):Number(row?.close);
const quoteVolume=row=>Array.isArray(row)?Number(row[7]):Number(row?.quoteVolume);
const compact=row=>({score:finite(row?.score)?row.score:null,scoreVersion:row?.scoreVersion??'LEGACY_V58_90_PLUS_10',
 pattern:row?.patternConfirmed===true?row.pattern:null,direction:row?.direction??null,
 patternConfirmedAt:stamp(row?.patternConfirmedAt)?row.patternConfirmedAt:null,
 technicalQualified:row?.technicalQualified===true,validationPassed:row?.technicalValidation?.passed??row?.quality?.passed??false,
 entry:finite(row?.entry)?row.entry:null,stop:finite(row?.stop)?row.stop:null,
 evaluationStatus:row?.status==='insufficient'?'UNAVAILABLE':row?.evaluationStatus??'EVALUATED',
 reasons:row?.status==='insufficient'?[row.reason??'INSUFFICIENT_HISTORY']:(row?.quality?.failed??[]),
 executableSignalApproved:false});

/** The ledger uses reference-price gross PNL and independent cost components.
 * Existing fill-price gross ledgers need an explicit conversion first; charging
 * their slippage twice is forbidden. Missing costs never become zero. */
export function summarizeStrategyTrades(trades,{strategy,dataSource,startAt,endAt,initialCapitalUSD}={}){
 if(!STRATEGIES.includes(strategy)||!SOURCES.has(dataSource)||!stamp(startAt)||!stamp(endAt)||endAt<startAt)
  throw Error('INVALID_STRATEGY_METRIC_CONTEXT');
 if(trades===undefined||trades===null)return unknownMetrics('EXECUTION_LEDGER_NOT_SUPPLIED');
 if(!Array.isArray(trades)||trades.length>100000)return unknownMetrics('EXECUTION_LEDGER_INVALID_OR_TOO_LARGE');
 const sameStrategy=trades.filter(row=>row?.strategy===strategy),ids=new Set();
 for(const row of sameStrategy){
  if(!plain(row)||typeof row.id!=='string'||!row.id||row.id.length>160||ids.has(row.id)||row.dataSource!==dataSource||
   row.pnlBasis!=='REFERENCE_GROSS_MINUS_INDEPENDENT_COSTS'||!stamp(row.openedAt)||!stamp(row.closedAt)||row.closedAt<row.openedAt||
   !finite(row.grossReferencePnLUSD)||COST_FIELDS.some(key=>!finite(row[key]))||
   ['feesUSD','slippageUSD','spreadUSD'].some(key=>row[key]<0))return unknownMetrics('LEDGER_SOURCE_ID_TIMES_OR_COST_BASIS_UNVERIFIED');
  const computed=row.grossReferencePnLUSD-COST_FIELDS.reduce((total,key)=>total+row[key],0);
  if(!finite(computed)||row.netPnLUSD!==undefined&&(!finite(row.netPnLUSD)||Math.abs(row.netPnLUSD-computed)>1e-8))
   return unknownMetrics('LEDGER_NET_PNL_CONTRADICTS_INDEPENDENT_COSTS');
  ids.add(row.id);
 }
 const selected=sameStrategy.filter(row=>row.openedAt>=startAt&&row.closedAt<=endAt)
  .sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id));
 if(!selected.length)return {...unknownMetrics('NO_COMPLETED_TRADES_IN_EVALUATION_PARTITION'),excludedTrades:sameStrategy.length};
 let cumulative=0,peak=0,maxDrawdownUSD=0,wins=0,losses=0,profits=0,lossAmount=0;
 const totals={grossReferencePnLUSD:0,feesUSD:0,slippageUSD:0,spreadUSD:0,fundingUSD:0},rValues=[];
 for(const row of selected){
  for(const key of Object.keys(totals))totals[key]+=row[key];
  const net=row.grossReferencePnLUSD-COST_FIELDS.reduce((sum,key)=>sum+row[key],0);
  cumulative+=net;peak=Math.max(peak,cumulative);maxDrawdownUSD=Math.max(maxDrawdownUSD,peak-cumulative);
  if(net>0){wins++;profits+=net}else if(net<0){losses++;lossAmount-=net}
  if(!Object.values(totals).every(finite)||![cumulative,peak,maxDrawdownUSD,profits,lossAmount].every(finite))return unknownMetrics('LEDGER_TOTAL_OVERFLOW');
  if(finite(row.plannedRiskUSD)&&row.plannedRiskUSD>0&&finite(net/row.plannedRiskUSD))rValues.push(net/row.plannedRiskUSD);
 }
 const capitalKnown=finite(initialCapitalUSD)&&initialCapitalUSD>0;
 // Percentage drawdown requires the equity peak at each event, not final PNL.
 let equity=capitalKnown?initialCapitalUSD:null,equityPeak=equity,maxDrawdownPercent=capitalKnown?0:null;
 if(capitalKnown)for(const row of selected){equity+=row.grossReferencePnLUSD-COST_FIELDS.reduce((sum,key)=>sum+row[key],0);
  equityPeak=Math.max(equityPeak,equity);maxDrawdownPercent=Math.max(maxDrawdownPercent,(equityPeak-equity)/equityPeak*100);
  if(![equity,equityPeak,maxDrawdownPercent].every(finite))return unknownMetrics('LEDGER_EQUITY_OVERFLOW')}
 return {status:'CALCULATED_FROM_SUPPLIED_SIMULATED_LEDGER',sourceAuthenticated:false,
  ledgerGeneratedByThisHarness:false,actualExchangePerformanceVerified:false,trades:selected.length,wins,losses,
  winRate:wins/selected.length,netPnLUSD:cumulative,...totals,profitFactor:lossAmount>0?profits/lossAmount:null,
  profitFactorStatus:lossAmount>0?'DEFINED':'UNDEFINED_NO_LOSS',maxDrawdownUSD,maxDrawdownPercent,
  averageRealizedR:rValues.length===selected.length?rValues.reduce((a,b)=>a+b,0)/rValues.length:null,
  expectancyUSD:cumulative/selected.length,sampleStatus:selected.length<30?'INSUFFICIENT_SAMPLE':'DESCRIPTIVE_ONLY_NOT_VALIDATED',
  drawdownBasis:'CLOSED_TRADE_EQUITY_NOT_INTRATRADE_MARK_TO_MARKET',
  excludedTrades:sameStrategy.length-selected.length,fillAccuracy:'UNVERIFIED_UNLESS_SEPARATELY_SUPPORTED_BY_HISTORICAL_BOOKS'};
}

function counts(decisions,key){
 const valid=decisions.filter(row=>row[key].evaluationStatus!=='UNAVAILABLE'),patterns=new Set(),qualified=new Set();
 for(const row of valid){const s=row[key],id=[s.direction,s.pattern,s.patternConfirmedAt].join('|');
  if(s.pattern)patterns.add(id);if(s.technicalQualified)qualified.add(id)}
 return {evaluations:decisions.length,evaluable:valid.length,unavailable:decisions.length-valid.length,
  patternCount:valid.length?patterns.size:null,technicalSignalCount:valid.length?qualified.size:null,
  finalOrderEligibleSignalCount:null,scope:'TECHNICAL_CANDIDATES_NOT_FINAL_EXECUTION_APPROVAL'};
}

function managementAt(input,row,cutoff){
 if(!row.technicalQualified)return {status:'NOT_EVALUATED',reason:'TECHNICAL_SETUP_NOT_QUALIFIED',plan:null};
 const snapshots=Array.isArray(input.profileSnapshots)?input.profileSnapshots:[],snapshot=snapshots
  .filter(item=>plain(item)&&item.symbol===input.symbol&&stamp(item.receivedAt)&&item.receivedAt<=cutoff&&stamp(item.windowEnd)&&item.windowEnd<=cutoff)
  .sort((a,b)=>b.receivedAt-a.receivedAt)[0];
 if(!snapshot)return {status:'UNVERIFIED',reason:'AS_OF_PROFILE_COVERAGE_AND_RECEIPT_EVIDENCE_NOT_SUPPLIED',plan:null};
 const trades=Array.isArray(snapshot.trades)?snapshot.trades:(input.aggTrades??[]).filter(trade=>stamp(trade?.T)&&trade.T>=snapshot.windowStart&&trade.T<=snapshot.windowEnd),
  dataSource=input.dataSource==='SYNTHETIC_TEST'?'SYNTHETIC_TEST':'REAL_BINANCE_AGG_TRADES',
  wrongSymbol=trades.some(trade=>plain(trade)&&['symbol','s'].some(key=>Object.hasOwn(trade,key)&&trade[key]!==input.symbol));
 if(wrongSymbol)return {status:'UNVERIFIED',reason:'PROFILE_TRADE_INSTRUMENT_MISMATCH',plan:null};
 const profile=buildVolumeProfile({...snapshot,symbol:input.symbol,trades,dataSource},{now:cutoff});
 if(!profile.ok)return {status:'UNVERIFIED',reason:profile.code,profileReasons:profile.reasons,plan:null};
 const parameters=input.planningParameters;
 if(!plain(parameters))return {status:'UNVERIFIED',reason:'PROFILE_AVAILABLE_BUT_CONTRACT_SIZE_COSTS_AND_QUANTITY_NOT_SUPPLIED',
  profile:{poc:profile.profile.poc,hvnCount:profile.profile.hvn.length,evidence:profile.evidence},plan:null};
 let entry,stop;
 try{entry=quantizeVolumeStep(row.entry,parameters.tickSize,row.direction==='LONG'?'UP':'DOWN');
  stop=quantizeVolumeStep(row.stop,parameters.tickSize,row.direction==='LONG'?'DOWN':'UP')}catch{return {status:'UNVERIFIED',reason:'PLANNING_PRICE_GRID_UNVERIFIED',plan:null}}
 const plan=planVolumeTargets({...parameters,profileResult:profile,direction:row.direction,entry,stop},{now:cutoff});
 if(plan.ok&&(!finite(parameters.maxRiskUSD)||parameters.maxRiskUSD<=0||plan.initialRisk>parameters.maxRiskUSD+1e-8))
  return {status:'UNVERIFIED',reason:'PROFILE_PLAN_MAXIMUM_RISK_UNVERIFIED_OR_EXCEEDED',plan:null};
 return {status:plan.ok?'MODEL_PLAN_CALCULATED':'UNVERIFIED',reason:plan.code,
  plan:plan.ok?{targets:plan.targets,parts:plan.parts,estimatedNetRR:plan.estimatedNetRR,initialRisk:plan.initialRisk,
   profileEvidence:plan.profileEvidence,executionApproved:false}:null,profileReasons:plan.reasons};
}

/** Same completed input prefix for both fixed strategies. No model fitting,
 * transport, storage writes or conversion of historical snapshots into live
 * PAPER. Missing book/ledger evidence leaves outcome metrics unverified. */
export function compareIssue6Strategies(input={}, {maxCutoffs=500}={}){
 if(!plain(input)||!SOURCES.has(input.dataSource)||typeof input.symbol!=='string'||input.symbol.length>32||!/^[A-Z0-9]+USDT$/.test(input.symbol)||
  !Array.isArray(input.h1)||!Array.isArray(input.h4)||input.h1.length>20000||input.h4.length>10000||
  input.btcH4!==undefined&&(!Array.isArray(input.btcH4)||input.btcH4.length>10000)||
  !Number.isSafeInteger(maxCutoffs)||maxCutoffs<1||maxCutoffs>2000||
  input.aggTrades!==undefined&&(!Array.isArray(input.aggTrades)||input.aggTrades.length>100000)||
  input.profileSnapshots!==undefined&&(!Array.isArray(input.profileSnapshots)||input.profileSnapshots.length>2000))throw Error('INVALID_STRATEGY_COMPARISON_INPUT');
 const synthetic=value=>plain(value)&&(value.syntheticTest===true||value.executionMode==='SYNTHETIC_TEST'||
  ['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE'].includes(value.dataSource));
 if(input.dataSource==='HISTORICAL_REPLAY'&&(synthetic(input)||[...input.h1,...input.h4,...(input.btcH4??[]),...(input.aggTrades??[])].some(synthetic)||
  (input.profileSnapshots??[]).some(snapshot=>synthetic(snapshot)||(Array.isArray(snapshot?.trades)&&snapshot.trades.some(synthetic)))))
  throw Error('SYNTHETIC_INPUT_CANNOT_BE_RELABELED_HISTORICAL');
 const requested=input.cutoffs??input.h1.map(row=>closeAt(row,HOUR)+1).filter(at=>stamp(at)&&
  prefix(input.h1,at,HOUR,500).length>=65&&prefix(input.h4,at,FOUR_HOURS,300).length>=250);
 if(!Array.isArray(requested)||requested.some(at=>!stamp(at)))throw Error('INVALID_STRATEGY_CUTOFF');
 const cutoffs=[...new Set(requested)].sort((a,b)=>a-b);
 if(cutoffs.length>maxCutoffs)throw Error('TOO_MANY_CUTOFFS_PROVIDE_EXPLICIT_WINDOW');
 const split=input.split??{},fraction=split.trainFraction??.6,foldCount=split.walkForwardFolds??3;
 if(!plain(split)||!finite(fraction)||fraction<=0||fraction>=1||!Number.isSafeInteger(foldCount)||foldCount<1||foldCount>20||
  split.inSampleEndAt!==undefined&&!stamp(split.inSampleEndAt))throw Error('INVALID_STRATEGY_PARTITIONS');
 const decisions=cutoffs.map(cutoff=>{
  const h1=prefix(input.h1,cutoff,HOUR,500),h4=prefix(input.h4,cutoff,FOUR_HOURS,300),btcH4=prefix(input.btcH4??[],cutoff,FOUR_HOURS,300),
   price=closePrice(h1.at(-1)),last24=h1.slice(-24),volumes=last24.map(quoteVolume),
   meta={now:cutoff,btcH4Rows:btcH4,quoteVolume:last24.length===24&&volumes.every(v=>finite(v)&&v>=0)?volumes.reduce((a,b)=>a+b,0):null},
   legacy=compact(analyzeLegacy(input.symbol,h1,h4,[],price,meta)),current=compact(analyzeCurrent(input.symbol,h1,h4,[],price,meta));
  return {cutoff,lastClosed1hAt:stamp(closeAt(h1.at(-1),HOUR))?closeAt(h1.at(-1),HOUR):null,
   lastClosed4hAt:stamp(closeAt(h4.at(-1),FOUR_HOURS))?closeAt(h4.at(-1),FOUR_HOURS):null,
   inputCounts:{h1:h1.length,h4:h4.length,btcH4:btcH4.length},legacy,current,
   earliestModelEntryAt:cutoff+1,decisionPriceBasis:'LAST_COMPLETED_1H_CLOSE_REFERENCE_NOT_EXECUTABLE',
   management:managementAt(input,current,cutoff)};
 });
 const trainCount=split.inSampleEndAt===undefined?Math.floor(decisions.length*fraction):decisions.filter(row=>row.cutoff<=split.inSampleEndAt).length,
  train=decisions.slice(0,trainCount),holdout=decisions.slice(trainCount),startAt=cutoffs[0]??null,endAt=cutoffs.at(-1)??null,
  summarize=rows=>{
   const first=rows[0]?.cutoff,last=rows.at(-1)?.cutoff;
   return {startAt:first??null,endAt:last??null,decisionCount:rows.length,baseline:counts(rows,'legacy'),issue6:counts(rows,'current'),
    newManagementPlans:rows.filter(row=>row.management.status==='MODEL_PLAN_CALCULATED').length,
    metrics:Object.fromEntries(STRATEGIES.map(strategy=>[strategy,rows.length?summarizeStrategyTrades(input.closedTrades,
     {strategy,dataSource:input.dataSource,startAt:first,endAt:last,initialCapitalUSD:input.initialCapitalUSD}):unknownMetrics('NO_DECISIONS_IN_PARTITION')]))};
  },foldSize=Math.max(1,Math.ceil(holdout.length/foldCount)),folds=[];
 for(let offset=0;offset<holdout.length;offset+=foldSize){const boundary=trainCount+offset,test=decisions.slice(boundary,boundary+foldSize);
  folds.push({fold:folds.length+1,training:summarize(decisions.slice(0,boundary)),test:summarize(test),
   parametersChangedUsingTestData:false,trainingPerformed:false,scope:'EXPANDING_TIME_SPLIT_FIXED_RULES_NO_MODEL_FITTING'})}
 return {kind:'ISSUE6_OFFLINE_STRATEGY_COMPARISON',mode:'READ_ONLY',dataSource:input.dataSource,symbol:input.symbol,
  sourceAuthenticated:false,status:decisions.length?'ANALYSIS_ONLY':'UNVERIFIED',period:{startAt,endAt},decisions,
  full:summarize(decisions),inSample:summarize(train),outOfSample:summarize(holdout),walkForward:folds,
  policy:{baselineCommit:'d5356ddd4cc7b6a2bbeb2d229762e1b9370b1471',baselineVersion:'LEGACY_V58_90_PLUS_10',
   currentVersion:SCORE_VERSION,currentThreshold:STRICT_MIN_SCORE,currentWeights:{...SCORE_WEIGHTS},
   weightsFrozen:true,trainingPerformed:false,thresholdCalibratedFromFuture:false,windowClosed4h:300,windowClosed1h:500,
   legacyDailyQuoteVolumeBasis:'SUM_OF_LAST24_COMPLETED_1H_QUOTE_VOLUMES',fixedRRReplacementForNewStrategy:false},
  executionLedgerGenerated:false,actualHistoricalBooksProvided:false,fillAccuracy:'UNVERIFIED',
  performanceImprovement:'UNVERIFIED',reason:'TECHNICAL_COUNT_OR_SUPPLIED_LEDGER_DIFFERENCE_DOES_NOT_PROVE_OUT_OF_SAMPLE_EXCHANGE_PERFORMANCE',
  realDataAutoEntryEnabled:false,liveOrdersEnabled:false,ordersSubmitted:false,
  limitations:['NO_CANDLE_HIGH_LOW_EXECUTION_INFERENCE','NO_FUTURE_CANDLES_TRADES_OR_PROFILE_RECEIPTS',
   'SUPPLIED_LEDGER_NOT_INDEPENDENTLY_AUTHENTICATED','UNVERIFIED_COSTS_ARE_NOT_ZERO','NO_LIVE_OR_PAPER_ACTIVATION',
   ...(input.dataSource==='SYNTHETIC_TEST'?['SYNTHETIC_RESULTS_ARE_NOT_REAL_EXCHANGE_RETURNS']:[])]};
}
