// Offline engine stress. Generated inputs are not strategy discoveries or
// OrangeX observations. No server, .env, key, fetch or WebSocket is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {auditOrangeXPaperAccounting} from '../orangex_paper_performance.mjs';

const DAY=86400000,INTERVAL=28800000,START=Date.parse('2026-01-01T00:00:01.000Z');
const BTC='BTC-USDT-PERPETUAL',ETH='ETH-USDT-PERPETUAL';
const CONTEXT={executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER'};
const SETTINGS=Object.freeze({capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:50,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100,maxHoldingMs:7*DAY,killSwitch:false});
const contract=instrumentName=>({instrumentName,symbol:instrumentName.split('-').slice(0,2).join(''),source:'SYNTHETIC_FIXTURE',
 quantityUnit:'CONTRACT',contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,
 takerRate:.0006,feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:INTERVAL,unitsVerifiedForSimulation:true});
const signal=(key,at,instrumentName=BTC)=>({key,symbol:instrumentName.split('-').slice(0,2).join(''),instrumentName,
 direction:'LONG',entry:100,stop:98,patternConfirmedAt:at-1,timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true});
const book=(at,{instrumentName=BTC,bid=99.99,ask=100.01,sequence=0,...patch}={})=>({instrumentName,dataSource:'SYNTHETIC_FIXTURE',
 bids:[[bid,1000]],asks:[[ask,1000]],timestamp:at,markPrice:(bid+ask)/2,markPriceAt:at,sequence,...patch});
const ensure=(condition,code)=>{if(!condition)throw Error(code)};
const size=state=>Buffer.byteLength(JSON.stringify(state));

function measurement(){
 const memory=process.memoryUsage(),cpu=process.cpuUsage(),at=performance.now();
 let sampledPeakHeapUsedBytes=memory.heapUsed,sampledPeakRssBytes=memory.rss,samples=0;
 const sample=()=>{const current=process.memoryUsage();samples++;sampledPeakHeapUsedBytes=Math.max(sampledPeakHeapUsedBytes,current.heapUsed);
  sampledPeakRssBytes=Math.max(sampledPeakRssBytes,current.rss);return current};
 return {sample,finish(){const end=sample(),used=process.cpuUsage(cpu);return {
  durationMs:performance.now()-at,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,
  memory:{sampling:'AFTER_EACH_DELIVERED_ACTION_NOT_OS_PEAK',samples,startHeapUsedBytes:memory.heapUsed,
   endHeapUsedBytes:end.heapUsed,heapDeltaBytes:end.heapUsed-memory.heapUsed,sampledPeakHeapUsedBytes,
   startRssBytes:memory.rss,endRssBytes:end.rss,sampledPeakRssBytes}}}};
}

function highFrequency({directory,messages,saveEveryMessage}){
 let clock=START,engine,mutations=0,durableWrites=0,delivered=0;
 const store=new OrangeXPaperStore({directory,now:()=>clock}),measure=measurement(),faults={duplicate:0,equalTimeSequence:0,
  reordered:0,delayed:0,staleMark:0,duplicateSignal:0,disconnectedRegistration:0};
 const save=state=>{mutations++;if(saveEveryMessage){store.write(state);durableWrites++}};
 const make=seed=>new OrangeXPaperEngine(seed??{}, {now:()=>clock,onChange:save,...CONTEXT,
  ...(seed?{}:{settings:SETTINGS,contracts:[contract(BTC),contract(ETH)]})});
 const deliver=value=>{delivered++;const changed=engine.onMarket(value);measure.sample();return changed};
 const checkpoint=()=>{const state=engine.exportState();store.write(state);durableWrites++;
  const loaded=store.read();ensure(isDeepStrictEqual(loaded,state),'STRESS_CHECKPOINT_MISMATCH');return loaded};
 try{
  engine=make();ensure(engine.register(signal('frequency-position',clock),{dataSource:'SYNTHETIC_FIXTURE'}),'STRESS_ENTRY_REGISTRATION_FAILED');
  clock++;deliver(book(clock,{sequence:0}));
  const initial=engine.exportState().open[0];ensure(initial&&initial.quantityOriginal>0,'STRESS_POSITION_MISSING');
  for(let index=0;index<messages;index++){
   clock++;const current=book(clock,{sequence:index*2});deliver(current);
   if(index%17===0){ensure(deliver(current)===0,'STRESS_DUPLICATE_CHANGED_POSITION');faults.duplicate++}
   if(index%23===0){deliver({...current,sequence:index*2+1});
    ensure(engine.exportState().lastMarkets[BTC].sequence===index*2+1,'STRESS_EQUAL_TIME_SEQUENCE_DROPPED');faults.equalTimeSequence++}
   if(index%29===0){ensure(deliver(book(clock-1,{sequence:999999}))===0,'STRESS_REORDERED_CHANGED_POSITION');faults.reordered++}
   if(index%41===0){ensure(deliver(book(clock,{markPriceAt:clock-90001}))===0,'STRESS_OLD_MARK_CHANGED_POSITION');faults.staleMark++}
   if(index%53===0){ensure(deliver(book(clock,{timestamp:clock-90001}))===0,'STRESS_DELAYED_BOOK_CHANGED_POSITION');faults.delayed++}
   if(index%67===0){ensure(engine.register(signal('frequency-position',clock),{dataSource:'SYNTHETIC_FIXTURE'})===false,'STRESS_DUPLICATE_SIGNAL_ACCEPTED');faults.duplicateSignal++;measure.sample()}
   if(index===Math.floor(messages/2)){
    engine.setConnectionStatus({connected:false,at:clock});measure.sample();
    ensure(engine.register(signal('frequency-disconnected',clock,ETH),{dataSource:'SYNTHETIC_FIXTURE'})===false,'STRESS_DISCONNECTED_ENTRY_ACCEPTED');
    faults.disconnectedRegistration++;engine.setConnectionStatus({connected:true,at:clock});measure.sample();
    const state=checkpoint();engine=make(state);
    ensure(deliver(current)===0,'STRESS_RESTART_REPLAY_CHANGED_POSITION');
    ensure(engine.exportState().open[0].quantityOriginal===initial.quantityOriginal,'STRESS_RESTART_QUANTITY_CHANGED');
   }
  }
  const beforeClose=engine.exportState();ensure(beforeClose.open.length===1&&beforeClose.closed.length===0,'STRESS_UNEXPECTED_EXIT');
  ensure(beforeClose.open[0].quantityOriginal===initial.quantityOriginal&&beforeClose.open[0].entryParts.length===1,'STRESS_DUPLICATE_FILL');
  clock++;deliver(book(clock,{bid:101,ask:101.01}));engine.closePosition(initial.key);measure.sample();
  const state=checkpoint(),restored=make(state),audit=auditOrangeXPaperAccounting(state,{now:clock});
  ensure(audit.valid&&audit.complete,'STRESS_HIGH_FREQUENCY_ACCOUNTING_FAILED');
  ensure(restored.exportState().closed.length===1&&restored.exportState().open.length===0,'STRESS_FINAL_RECOVERY_FAILED');
  engine=restored;ensure(engine.register(signal('frequency-position',clock),{dataSource:'SYNTHETIC_FIXTURE'})===false,'STRESS_SEEN_ID_NOT_PERSISTED');
  const finalState=checkpoint();
  const result=measure.finish();
  return {inputMessages:messages,deliveredMarketMessages:delivered,committedMutations:mutations,durableWrites,
   durabilityMode:saveEveryMessage?'EVERY_MUTATION':'MIDPOINT_AND_FINAL_CHECKPOINTS',faults,
   quantityOriginal:initial.quantityOriginal,entryFillCount:state.closed[0].entryParts.length,closedTrades:1,
   duplicateFill:false,seenSignalPersisted:true,ledgerBytes:size(finalState),audit:{valid:audit.valid,complete:audit.complete,issues:audit.issues},
   ...result,messagesPerSecond:delivered/(result.durationMs/1000)};
 }finally{store.close()}
}

function longHeld({directory,holdingDays}){
 let clock=START,engine,durableWrites=0;
 const store=new OrangeXPaperStore({directory,now:()=>clock}),measure=measurement();
 const make=seed=>new OrangeXPaperEngine(seed??{}, {now:()=>clock,onChange:state=>{store.write(state);durableWrites++},...CONTEXT,
  ...(seed?{}:{settings:SETTINGS,contracts:[contract(BTC),contract(ETH)]})});
 const checkpoint=()=>{const state=engine.exportState();store.write(state);durableWrites++;return store.read()};
 const deliver=market=>{const changed=engine.onMarket(market);measure.sample();return changed};
 const funding=(at)=>({id:`hold-${holdingDays}-funding-${at}`,instrumentName:BTC,dataSource:'SYNTHETIC_FIXTURE',at,rate:.0001,markPrice:100});
 let originalQuantity,missingFundingBlocked=false,staleMarkBlocked=false,stalePortfolioBlocked=false,fundingCount=0,restarts=0;
 try{
  engine=make();ensure(engine.register(signal(`held-${holdingDays}`,clock),{dataSource:'SYNTHETIC_FIXTURE'}),'STRESS_HOLD_SIGNAL_FAILED');
  clock++;deliver(book(clock));const opened=engine.exportState().open[0];originalQuantity=opened.quantityOriginal;
  const firstFunding=Math.floor(opened.openedAt/INTERVAL)*INTERVAL+INTERVAL,endAt=opened.openedAt+holdingDays*DAY+1;
  if(holdingDays===30){
   engine.setConnectionStatus({connected:false,at:clock});
   clock=endAt;
   const outage=engine.snapshot();ensure(outage.open.length===1&&outage.summary.unverifiedFunding&&outage.summary.valuationStale,'STRESS_OUTAGE_WAS_NOT_UNVERIFIED');
   ensure(engine.register(signal('outage-new-entry',clock,ETH),{dataSource:'SYNTHETIC_FIXTURE'})===false,'STRESS_OUTAGE_NEW_ENTRY_ACCEPTED');
   ensure(engine.snapshot().risk.entryBlockReason==='CONNECTION_DISCONNECTED','STRESS_OUTAGE_ENTRY_REASON_MISSING');
   ensure(deliver(book(clock,{markPriceAt:clock-90001}))===0,'STRESS_OUTAGE_STALE_MARK_FILLED');staleMarkBlocked=true;
   ensure(engine.snapshot().open.length===1,'STRESS_OUTAGE_INVENTED_EXIT');
   engine=make(checkpoint());restarts++;ensure(engine.snapshot().open[0].quantityOriginal===originalQuantity,'STRESS_OUTAGE_RECOVERY_QUANTITY_CHANGED');
  }
  for(let at=firstFunding;at<=endAt;at+=INTERVAL){
   if(holdingDays!==30)clock=at;
   const pending=engine.snapshot();
   ensure(pending.summary.unverifiedFunding,'STRESS_DUE_FUNDING_WAS_ASSUMED_ZERO');
   if(fundingCount===0){
    if(holdingDays!==30){ensure(engine.register(signal('missing-funding-entry',clock,ETH),{dataSource:'SYNTHETIC_FIXTURE'})===false,'STRESS_MISSING_FUNDING_ENTRY_ACCEPTED');
     ensure(engine.snapshot().risk.entryBlockReason==='FUNDING_EVENTS_MISSING','STRESS_MISSING_FUNDING_REASON_MISSING')}
    missingFundingBlocked=true;
   }
   const event=funding(at);ensure(engine.applyFunding(event)===true,'STRESS_FUNDING_EVENT_REJECTED');fundingCount++;measure.sample();
   const before=engine.exportState().open[0].fundingUSD;
   ensure(engine.applyFunding(event)===false,'STRESS_DUPLICATE_FUNDING_ACCEPTED');measure.sample();
   ensure(engine.exportState().open[0].fundingUSD===before,'STRESS_DUPLICATE_FUNDING_CHANGED_ACCOUNTING');
   if(holdingDays!==30){
    if(fundingCount===1){
     ensure(deliver(book(clock,{markPriceAt:clock-90001}))===0,'STRESS_STALE_MARK_NOT_BLOCKED');staleMarkBlocked=true;
     const ethKey='stale-portfolio-entry';ensure(engine.register(signal(ethKey,clock,ETH),{dataSource:'SYNTHETIC_FIXTURE'}),'STRESS_STALE_PORTFOLIO_SIGNAL_FAILED');
     clock++;deliver(book(clock,{instrumentName:ETH}));
     ensure(!engine.exportState().open.some(p=>p.instrumentName===ETH),'STRESS_STALE_PORTFOLIO_ENTRY_FILLED');
     ensure(engine.exportState().rejections.some(row=>row.key===ethKey&&row.reason==='PORTFOLIO_VALUATION_STALE'),'STRESS_STALE_PORTFOLIO_REASON_MISSING');stalePortfolioBlocked=true;
    }
    deliver(book(clock));
    if(fundingCount%3===0){engine=make(checkpoint());restarts++;measure.sample()}
   }
  }
  clock=endAt;
  ensure(engine.exportState().open.length===1,'STRESS_POSITION_DID_NOT_REMAIN_OPEN');
  ensure(engine.snapshot().summary.unverifiedFunding===false,'STRESS_FUNDING_CATCHUP_INCOMPLETE');
  if(holdingDays===30){engine.setConnectionStatus({connected:true,at:clock});deliver(book(clock,{bid:90,ask:90.01}))}
  else deliver(book(clock));
  const state=checkpoint(),closed=state.closed[0],audit=auditOrangeXPaperAccounting(state,{now:clock});
  ensure(state.open.length===0&&state.pending.length===0&&state.closed.length===1,'STRESS_LONG_HOLD_NOT_CLOSED');
  ensure(closed.quantityOriginal===originalQuantity,'STRESS_LONG_HOLD_QUANTITY_CHANGED');
  ensure(closed.fundingParts.length===fundingCount&&Object.keys(state.fundingSeen).length===fundingCount,'STRESS_FUNDING_PERSISTENCE_MISMATCH');
  ensure(audit.valid&&audit.complete,'STRESS_LONG_HOLD_ACCOUNTING_FAILED');
  engine=make(state);restarts++;
  const before=engine.exportState().closed[0].fundingUSD;
  ensure(engine.applyFunding(funding(firstFunding))===false,'STRESS_RESTART_FUNDING_REPLAY_ACCEPTED');
  ensure(engine.exportState().closed[0].fundingUSD===before,'STRESS_RESTART_FUNDING_CHANGED_ACCOUNTING');
  ensure(deliver(book(clock,holdingDays===30?{bid:90,ask:90.01}:{}))===0,'STRESS_RECOVERY_QUOTE_REPLAY_CHANGED_POSITION');
  const finalState=checkpoint();
  const result=measure.finish();
  return {holdingDays,virtualOpenedAt:opened.openedAt,virtualClosedAt:closed.closedAt,configuredMaxHoldingMs:SETTINGS.maxHoldingMs,
   model:holdingDays===30?'THIRTY_DAY_MARKET_DATA_OUTAGE_THEN_FIRST_FRESH_GAP_STOP':'SEVEN_DAY_CONTINUOUS_HOLD_THEN_TIME_LIMIT',
   note:holdingDays===30?'The seven-day limit was not relaxed. No executable book existed during the modeled outage.':'Position is carried across scheduled funding periods, not closed in a millisecond cycle.',
   quantityOriginal:originalQuantity,closeReason:closed.closeReason,fundingEvents:fundingCount,
   fundingUSD:closed.fundingUSD,expectedFundingUSD:originalQuantity*100*.0001*fundingCount,
   missingFundingBlocked,staleMarkBlocked,stalePortfolioBlocked:holdingDays===30?null:stalePortfolioBlocked,
   gapStopExceeded:closed.gapStopExceeded??null,durableWrites,durableRestarts:restarts,
   fundingIdsPersisted:true,duplicateFundingCharge:false,duplicateFill:false,ledgerBytes:size(finalState),
   audit:{valid:audit.valid,complete:audit.complete,issues:audit.issues},...result};
 }finally{store.close()}
}

export function runOrangeXOperationalStress({messages=10000,holdingDays=7,saveEveryMessage=false}={}){
 if(!Number.isSafeInteger(messages)||messages<1||messages>200000||![7,30].includes(holdingDays)||typeof saveEveryMessage!=='boolean')throw Error('INVALID_OPERATIONAL_STRESS_OPTIONS');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-operational-stress-'));
 try{return {kind:'ORANGEX_OPERATIONAL_STRESS',executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER',dataSource:'SYNTHETIC_FIXTURE',
  actualOrangeXRequestsRun:false,apiKeysUsed:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,
  signalSource:'GENERATED_ENGINE_STRESS_NOT_STRATEGY_BACKTEST',highFrequency:highFrequency({directory:path.join(directory,'frequency'),messages,saveEveryMessage}),
  longHeld:longHeld({directory:path.join(directory,'held'),holdingDays}),limitations:['VIRTUAL_TIME_NOT_REAL_UPTIME','NOT_ACTUAL_EXCHANGE_PERFORMANCE',
   'SAMPLED_MEMORY_NOT_OS_PEAK','SYNTHETIC_QUOTES_AND_DECLARED_COSTS','HISTORY_PRESERVED_NOT_BOUNDED_MEMORY_GUARANTEE',
   ...(saveEveryMessage?[]:['HIGH_FREQUENCY_DURABILITY_USES_MIDPOINT_AND_FINAL_CHECKPOINTS'])]}}
 finally{fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

export function operationalStressOptions(args=[]){
 if(!Array.isArray(args))throw Error('INVALID_OPERATIONAL_STRESS_OPTIONS');
 let messages=10000,holdingDays=[7,30],seenMessages=false,seenDays=false,saveEveryMessage=false;
 for(let index=0;index<args.length;index++){
  if(args[index]==='--messages'&&!seenMessages&&/^\d+$/.test(args[index+1]??'')){
   messages=Number(args[++index]);seenMessages=true;if(!Number.isSafeInteger(messages)||messages<1||messages>200000)throw Error('INVALID_OPERATIONAL_STRESS_OPTIONS');continue;
  }
  if(args[index]==='--holding-days'&&!seenDays&&['7','30'].includes(args[index+1])){holdingDays=[Number(args[++index])];seenDays=true;continue}
  if(args[index]==='--save-every-message'&&!saveEveryMessage){saveEveryMessage=true;continue}
  throw Error('INVALID_OPERATIONAL_STRESS_OPTIONS');
 }
 return {messages,holdingDays,saveEveryMessage};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const options=operationalStressOptions(process.argv.slice(2));console.log(JSON.stringify({kind:'ORANGEX_OPERATIONAL_STRESS_SUITE',
  actualOrangeXRequestsRun:false,results:options.holdingDays.map(holdingDays=>runOrangeXOperationalStress({...options,holdingDays}))},null,2))}
 catch{console.error('오프라인 운영 부하 검사 실패. 합성 입력·위험 제한·원장 검증 결과를 확인하세요. 실제 API는 호출하지 않습니다.');
  console.error('사용법: node scripts/check-orangex-operational-stress.mjs [--messages N] [--holding-days 7|30] [--save-every-message]');process.exitCode=1}
}
