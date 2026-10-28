// Compressed virtual time, generated synthetic inputs only. No server, .env,
// credentials, fetch, WebSocket, exchange transport or user-data directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {auditOrangeXPaperAccounting} from '../orangex_paper_performance.mjs';

const DAY=86400000,START=Date.parse('2026-01-01T00:00:01.000Z'),NAME='BTC-USDT-PERPETUAL';
const SETTINGS=Object.freeze({capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:50,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100,killSwitch:false});
const CONTRACT=Object.freeze({instrumentName:NAME,symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',quantityUnit:'CONTRACT',
 contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,takerRate:.0006,
 feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:28800000,unitsVerifiedForSimulation:true});
const book=(at,bid=99.99,ask=100.01)=>({instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',timestamp:at,
 markPrice:(bid+ask)/2,markPriceAt:at,bids:[[bid,1000]],asks:[[ask,1000]]});
const quantityTotal=state=>[...state.open,...state.closed].reduce((sum,p)=>sum+p.quantityOriginal,0);
function ensure(condition,code){if(!condition)throw Error(code)}

/** This measures the engine and persistence workload, not strategy profitability.
 * The generated normalized signals are stress inputs, not analyze() discoveries.
 * saveEveryEvent=false explicitly measures memory transactions with a durable
 * daily checkpoint; it does not claim each event survived a power loss.
 */
export function runOrangeXPaperEndurance({days=7,ticksPerDay=48,signalEveryTicks=12,saveEveryEvent=false}={}){
 if(!Number.isInteger(days)||days<1||days>30||!Number.isInteger(ticksPerDay)||ticksPerDay<4||ticksPerDay>288||
  DAY%ticksPerDay!==0||!Number.isInteger(signalEveryTicks)||signalEveryTicks<1||signalEveryTicks>ticksPerDay||
  typeof saveEveryEvent!=='boolean')throw Error('INVALID_ENDURANCE_OPTIONS');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-paper-endurance-'));
 let clock=START,engine,saves=0,durableWrites=0,events=0,restarts=0,markets=0,signals=0;
 const store=new OrangeXPaperStore({directory,now:()=>clock});
 const begin=performance.now(),baseline=process.memoryUsage(),samples=[],faults={duplicateBooks:0,reorderedBooks:0,
  delayedBooks:0,staleMarks:0,duplicateSignals:0,disconnectRecovery:0};
 let peakHeap=baseline.heapUsed,peakRss=baseline.rss,sampleCount=0;
 const sample=()=>{
  const memory=process.memoryUsage();sampleCount++;peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);
  return memory;
 };
 const onChange=state=>{saves++;if(saveEveryEvent){store.write(state);durableWrites++}};
 const onEvent=()=>{events++};
 const makeEngine=seed=>new OrangeXPaperEngine(seed??{}, {now:()=>clock,onChange,onEvent,
  executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER',...(seed?{}:{settings:SETTINGS,contracts:[CONTRACT]})});
 const tick=market=>{markets++;const result=engine.onMarket(market);sample();return result};
 try{
  engine=makeEngine();
  for(let index=0;index<days*ticksPerDay;index++){
   clock=START+index*(DAY/ticksPerDay);
   if(index%signalEveryTicks===0){
    const direction=signals%2===0?'LONG':'SHORT',key=`endurance-${days}-${index}-${direction}`;
    const signal={key,symbol:'BTCUSDT',instrumentName:NAME,direction,entry:100,stop:direction==='LONG'?98:102,
     timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,patternConfirmedAt:clock-1};
    ensure(engine.register(signal,{dataSource:'SYNTHETIC_FIXTURE'}),'ENDURANCE_SIGNAL_UNEXPECTEDLY_BLOCKED');signals++;sample();
    const pending=engine.exportState().pending.length;
    ensure(engine.register(signal,{dataSource:'SYNTHETIC_FIXTURE'})===false,'ENDURANCE_DUPLICATE_SIGNAL_ACCEPTED');
    ensure(engine.exportState().pending.length===pending,'ENDURANCE_DUPLICATE_PENDING');faults.duplicateSignals++;sample();
    clock++;tick(book(clock));
    ensure(engine.exportState().open.length===1,'ENDURANCE_ENTRY_MISSING');
    for(const target of direction==='LONG'?[104,106,108]:[96,94,92]){
     clock++;tick(direction==='LONG'?book(clock,target,Number((target+.01).toFixed(2))):book(clock,Number((target-.01).toFixed(2)),target));
    }
    ensure(engine.exportState().open.length===0&&engine.exportState().pending.length===0,'ENDURANCE_POSITION_NOT_CLOSED');
   }else{clock++;tick(book(clock))}
   if(index%97===0){
    const state=engine.exportState(),before=quantityTotal(state),last=state.lastMarkets[NAME];
    ensure(tick(book(last.timestamp))===0,'ENDURANCE_DUPLICATE_BOOK_FILLED');
    ensure(quantityTotal(engine.exportState())===before,'ENDURANCE_DUPLICATE_QUANTITY');faults.duplicateBooks++;
   }
   if(index%131===0){ensure(tick(book(clock-1))===0,'ENDURANCE_REORDERED_BOOK_FILLED');faults.reorderedBooks++}
   if(index%151===0){ensure(tick({...book(clock),timestamp:clock-90001})===0,'ENDURANCE_DELAYED_BOOK_FILLED');faults.delayedBooks++}
   if(index%167===0){ensure(tick({...book(clock),markPriceAt:clock-90001})===0,'ENDURANCE_STALE_MARK_FILLED');faults.staleMarks++}
   if((index+1)%ticksPerDay===0){
    ensure(typeof engine.setConnectionStatus==='function','ENDURANCE_CONNECTION_GUARD_UNAVAILABLE');
    engine.setConnectionStatus({connected:false,at:clock});sample();
    clock++;engine.setConnectionStatus({connected:true,at:clock});sample();faults.disconnectRecovery++;
    store.write(engine.exportState());durableWrites++;const restored=store.read();
    ensure(isDeepStrictEqual(restored,engine.exportState()),'ENDURANCE_DURABLE_STATE_MISMATCH');
    engine=makeEngine(restored);restarts++;
    const current=engine.exportState(),memory=sample();
    samples.push({virtualDay:(index+1)/ticksPerDay,heapUsedBytes:memory.heapUsed,rssBytes:memory.rss,
     ledgerBytes:Buffer.byteLength(JSON.stringify(current)),closedTrades:current.closed.length,openPositions:current.open.length,
     pendingOrders:current.pending.length,rememberedSignals:Object.keys(current.seen).length,retainedEvents:current.events.length});
   }
  }
  const state=engine.exportState(),snapshot=engine.snapshot(),audit=auditOrangeXPaperAccounting(state,{now:clock});
  const last=sample(),durationMs=performance.now()-begin;
  ensure(audit.valid===true&&audit.complete===true,'ENDURANCE_ACCOUNTING_AUDIT_FAILED');
  ensure(state.closed.length===signals,'ENDURANCE_CLOSED_COUNT_MISMATCH');
  ensure(new Set(state.closed.map(p=>p.key)).size===state.closed.length,'ENDURANCE_DUPLICATE_TRADE');
  ensure(state.open.length===0&&state.pending.length===0,'ENDURANCE_UNFINISHED_POSITIONS');
  ensure(state.closed.every(p=>Math.abs(p.quantityOriginal-p.exitParts.reduce((sum,part)=>sum+part.quantity,0))<1e-8),
   'ENDURANCE_QUANTITY_CONSERVATION_FAILED');
  return {kind:'ORANGEX_PAPER_ENDURANCE',executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER',
   dataSource:'SYNTHETIC_FIXTURE',strategySignalSource:'GENERATED_ENGINE_STRESS_NOT_TECHNICAL_ANALYSIS',
   actualMarketPerformance:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,
   virtual:{days,ticksPerDay,signalEveryTicks,startedAt:START,endedAt:clock},
   workload:{marketMessages:markets,signals,closedTrades:state.closed.length,committedMutations:saves,
    committedEvents:events,durableWrites,durableRestarts:restarts,durabilityMode:saveEveryEvent?'EVERY_EVENT':'DAILY_CHECKPOINT'},
   timing:{durationMs,marketMessagesPerSecond:markets/(durationMs/1000),mutationsPerSecond:saves/(durationMs/1000)},
   memory:{sampleCount,sampling:'AFTER_EACH_ACTION_AND_DAILY_CHECKPOINT',startHeapUsedBytes:baseline.heapUsed,
    endHeapUsedBytes:last.heapUsed,sampledPeakHeapUsedBytes:peakHeap,heapDeltaBytes:last.heapUsed-baseline.heapUsed,
    startRssBytes:baseline.rss,endRssBytes:last.rss,sampledPeakRssBytes:peakRss},
   ledger:{bytes:Buffer.byteLength(JSON.stringify(state)),retainedClosedTrades:state.closed.length,
    rememberedSignals:Object.keys(state.seen).length,retainedEvents:state.events.length,durableStateMatchesMemory:true,
    quantityConserved:true,duplicateTradeKeys:false},
   faults,audit:{valid:audit.valid,complete:audit.complete,issues:audit.issues},dailySamples:samples,
   syntheticSummary:snapshot.summary,
   limitations:['VIRTUAL_DAYS_NOT_REAL_WALL_CLOCK_UPTIME','GENERATED_SIGNALS_NOT_STRATEGY_BACKTEST',
    'SYNTHETIC_DEPTH_AND_COSTS_NOT_EXCHANGE_OBSERVATIONS','SAMPLED_MEMORY_NOT_AN_OS_PEAK_MEASUREMENT',
    'MEMORY_CAN_GROW_WITH_PRESERVED_TRADE_HISTORY','BENCHMARK_DEPENDS_ON_MACHINE_AND_GC',
    ...(saveEveryEvent?[]:['DURABLE_DAILY_CHECKPOINTS_NOT_EVERY_EVENT_DURABILITY'])]};
 }finally{store.close();fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

export function enduranceOptions(args=[]){
 if(!Array.isArray(args))throw Error('INVALID_ENDURANCE_OPTIONS');
 if(!args.length)return {days:[7,30],saveEveryEvent:false};
 let days,saveEveryEvent=false;
 for(let index=0;index<args.length;index++){
  if(args[index]==='--days'&&days===undefined&&['7','30'].includes(args[index+1])){days=Number(args[++index]);continue}
  if(args[index]==='--save-every-event'&&!saveEveryEvent){saveEveryEvent=true;continue}
  throw Error('INVALID_ENDURANCE_OPTIONS');
 }
 return {days:days===undefined?[7,30]:[days],saveEveryEvent};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const options=enduranceOptions(process.argv.slice(2));
  console.log(JSON.stringify({kind:'ORANGEX_PAPER_ENDURANCE_SUITE',executionMode:'SYNTHETIC_TEST',
   actualOrangeXRequestsRun:false,results:options.days.map(days=>runOrangeXPaperEndurance({days,saveEveryEvent:options.saveEveryEvent}))},null,2));
 }catch{
  console.error('오프라인 장기 검증 실패. 합성 시나리오의 위험·원장·저장 검증 결과를 확인하세요. 실제 API는 호출하지 않습니다.');
  console.error('사용법: node scripts/check-orangex-paper-endurance.mjs [--days 7|30] [--save-every-event]');
  process.exitCode=1;
 }
}
