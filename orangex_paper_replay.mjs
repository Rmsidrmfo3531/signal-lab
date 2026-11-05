// Chronological 1H/4H analysis. No transport, key, user store or live activation.
import {analyze} from './engine.mjs';
import {analyze as analyzeLegacyV58} from './research/legacy_v58/engine.mjs';
import {SCORE_VERSION} from './quality.mjs';
import {evaluateSignal} from './signal_pipeline.mjs';
import {evaluateLegacySyntheticSignal} from './research/legacy_v58/decision.mjs';
import {normalizeOrangeXPaperSignal,alignOrangeXPaperSignal} from './orangex_paper_signal.mjs';
import {OrangeXPaperEngine} from './orangex_paper.mjs';

const HOUR=3600000,MAX_ROWS=100000,MAX_EVENTS=200000;
const MODES=new Set(['SYNTHETIC_TEST','HISTORICAL_REPLAY']);
const HISTORICAL_SOURCES=new Set(['SYNTHETIC_FIXTURE','USER_SUPPLIED_HISTORICAL','USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN']);
const NAME=/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8e15;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const clone=value=>structuredClone(value);

function candles(input,interval){
 if(!Array.isArray(input)||!input.length||input.length>MAX_ROWS)throw Error('INVALID_REPLAY_CANDLES');
 const prepared=input.map(value=>{
  const row=Array.isArray(value)?value:value?.row;
  if(!Array.isArray(row)||row.length<8||!stamp(Number(row[0]))||!stamp(Number(row[6]))||
   Number(row[6])!==Number(row[0])+interval-1)throw Error('INVALID_REPLAY_CANDLE_CLOCK');
  const availableAt=Array.isArray(value)?Number(row[6])+1:value.availableAt;
  if(!stamp(availableAt)||availableAt<=Number(row[6]))throw Error('REPLAY_CANDLE_AVAILABLE_BEFORE_CLOSE');
  return {row:clone(row),closeAt:Number(row[6]),availableAt};
 });
 const keys=new Set();
 for(const item of prepared){
  const openAt=Number(item.row[0]);
  if(keys.has(openAt))throw Error('DUPLICATE_REPLAY_CANDLE');
  keys.add(openAt);
 }
 return prepared.sort((a,b)=>a.availableAt-b.availableAt||a.closeAt-b.closeAt);
}
function timelineRows(rows,key,kind){
 if(rows===undefined)return [];
 if(!Array.isArray(rows)||rows.length>MAX_EVENTS)throw Error('INVALID_REPLAY_'+kind);
 let prior=0;
 return rows.map(value=>{
  if(!plain(value)||!stamp(value[key])||value[key]<prior)throw Error('INVALID_REPLAY_'+kind+'_CLOCK');
  prior=value[key];return clone(value);
 });
}
function executionOptions(input){
 const entry=plain(input.entry)?input.entry:{},latencyMs=entry.latencyMs??0;
 if(!Number.isSafeInteger(latencyMs)||latencyMs<0||latencyMs>7*24*HOUR||
  entry.orderType!==undefined&&!['MARKET','LIMIT'].includes(entry.orderType)||
  entry.orderType==='LIMIT'&&!positive(entry.limitPrice))throw Error('INVALID_REPLAY_ENTRY_OPTIONS');
 return {latencyMs,orderType:entry.orderType??'MARKET',limitPrice:entry.limitPrice??null};
}

/**
 * input: {kind:'ORANGEX_PAPER_REPLAY',executionMode,symbol,instrumentName,
 * h1,h4,markets:[{receivedAt,...book}],metadata:[{at,quoteVolume}],
 * venueSnapshots:[{at,dataSource,verified,venueConnected,market,book,price,priceAt}],
 * events?:[{at,type:'FUNDING'|'CONNECTION'|'CANCEL'|'CLOSE',...}],settings,contracts,
 * entry?:{orderType,limitPrice,latencyMs},startAt?,endAt?}.
 * The entire OHLC bar becomes visible only at availableAt, strictly after its
 * source close. No OHLC high/low can stand in for an executable order book.
 */
export function runOrangeXPaperReplay(input,{onProgress=()=>{},progressEvery=100}={}){
 if(!plain(input)||input.kind!=='ORANGEX_PAPER_REPLAY'||!MODES.has(input.executionMode)||
  typeof input.symbol!=='string'||!/^[A-Z0-9]{2,32}$/.test(input.symbol)||!NAME.test(input.instrumentName)||
  input.instrumentName.split('-').slice(0,2).join('')!==input.symbol||typeof onProgress!=='function'||
  !Number.isSafeInteger(progressEvery)||progressEvery<1)throw Error('INVALID_REPLAY_INPUT');
 if(input.executionMode==='SYNTHETIC_TEST'&&input.dataSource!=='SYNTHETIC_FIXTURE')throw Error('REPLAY_SYNTHETIC_SOURCE_REQUIRED');
 if(input.executionMode==='HISTORICAL_REPLAY'&&!HISTORICAL_SOURCES.has(input.dataSource))throw Error('REPLAY_HISTORICAL_SOURCE_REQUIRED');
 if(input.runKind!==undefined&&input.runKind!=='BACKTEST')throw Error('INVALID_REPLAY_CONTEXT');
 const strategyVersion=input.strategyVersion??SCORE_VERSION;
 if(!['LEGACY_V58',SCORE_VERSION].includes(strategyVersion))throw Error('INVALID_REPLAY_STRATEGY');
 const legacy=strategyVersion==='LEGACY_V58',analyzeAt=legacy?analyzeLegacyV58:analyze,
  maximumFourHourBars=legacy?110:301,maximumHourlyBars=legacy?150:200;
 const one=candles(input.h1,HOUR),four=candles(input.h4,4*HOUR),markets=timelineRows(input.markets,'receivedAt','MARKETS'),
  metadata=timelineRows(input.metadata,'at','METADATA'),venues=timelineRows(input.venueSnapshots,'at','VENUES'),
  controls=timelineRows(input.events,'at','EVENTS'),entry=executionOptions(input);
 for(const market of markets){
  if(market.instrumentName!==input.instrumentName||!stamp(market.timestamp)||market.timestamp>market.receivedAt||
   !stamp(market.markPriceAt)||market.markPriceAt>market.receivedAt)throw Error('REPLAY_QUOTE_SOURCE_CLOCK_INVALID');
  if(input.executionMode==='SYNTHETIC_TEST'&&market.dataSource!=='SYNTHETIC_FIXTURE')throw Error('REPLAY_REAL_DATA_FILL_DISABLED');
 }
 for(const item of metadata)if(typeof item.quoteVolume!=='number'||!Number.isFinite(item.quoteVolume)||item.quoteVolume<0)
  throw Error('INVALID_REPLAY_METADATA');
 for(const venue of venues){
  for(const field of ['priceAt'])if(venue[field]!==undefined&&(!stamp(venue[field])||venue[field]>venue.at))
   throw Error('REPLAY_VENUE_SOURCE_CLOCK_INVALID');
  if(venue.book?.T!==undefined&&(!stamp(venue.book.T)||venue.book.T>venue.at))
   throw Error('REPLAY_VENUE_SOURCE_CLOCK_INVALID');
 }
 for(const item of controls)if(!['FUNDING','CONNECTION','CANCEL','CLOSE'].includes(item.type))throw Error('INVALID_REPLAY_EVENT');
 // Avoid argument-spread limits on a legitimately large historical input.
 let earliest=Infinity,latest=-Infinity;
 for(const [values,key]of [[one,'availableAt'],[four,'availableAt'],[markets,'receivedAt'],[metadata,'at'],[venues,'at'],[controls,'at']])
  for(const value of values){earliest=Math.min(earliest,value[key]);latest=Math.max(latest,value[key])}
 const startAt=input.startAt??earliest,endAt=input.endAt??latest;
 if(!stamp(startAt)||!stamp(endAt)||endAt<startAt)throw Error('INVALID_REPLAY_RANGE');
 let now=startAt,latestMetadata=null,latestVenue=null,latestMarket=null,processed=0,analysesCount=0,patterns=0,technical=0,approved=0,entriesAccepted=0;
 const synthetic=input.executionMode==='SYNTHETIC_TEST';
 const engine=synthetic?new OrangeXPaperEngine({}, {now:()=>now,settings:input.settings,contracts:input.contracts,
  executionMode:'SYNTHETIC_TEST',runKind:'BACKTEST'}):null;
 const timeline=[],analyses=[],signals=[],oneKnown=[],fourKnown=[],scheduled=[];
 for(const value of one)timeline.push({at:value.availableAt,priority:3,type:'CANDLE_1H',value});
 for(const value of four)timeline.push({at:value.availableAt,priority:0,type:'CANDLE_4H',value});
 for(const value of metadata)timeline.push({at:value.at,priority:0,type:'METADATA',value});
 for(const value of venues)timeline.push({at:value.at,priority:0,type:'VENUE',value});
 // With only millisecond receipt clocks, simultaneous arrival order is not
 // proven. Apply risk controls/cancellations before an equal-time book rather
 // than allowing a fill to win an arbitrary array ordering tie.
 for(const value of markets)timeline.push({at:value.receivedAt,priority:2,type:'MARKET',value});
 for(const value of controls)timeline.push({at:value.at,priority:1,type:'CONTROL',value});
 if(timeline.length>MAX_EVENTS)throw Error('REPLAY_EVENT_LIMIT_EXCEEDED');
 timeline.sort((a,b)=>a.at-b.at||a.priority-b.priority);
 function release(upTo){
  while(scheduled.length&&scheduled[0].at<=upTo){
   const order=scheduled.shift();now=order.at;
   if(now>order.validUntil){order.observation.reasons.push('REPLAY_SIGNAL_EXPIRED_BEFORE_ENTRY');continue}
   if(engine){order.observation.entryAccepted=engine.register(order.signal,{dataSource:'SYNTHETIC_FIXTURE',
    orderType:entry.orderType,limitPrice:entry.limitPrice});
    if(order.observation.entryAccepted){entriesAccepted++;order.observation.entryAcceptedAt=now}}
  }
 }
 for(const event of timeline){
  if(event.at>endAt)break;
  // Release decisions before a later book arrives. Engine requires the source
  // book itself to be strictly later than createdAt, not just a late receipt.
  release(event.at);now=event.at;
  processed++;
  if(event.type==='CANDLE_4H'){
   fourKnown.push(event.value);fourKnown.sort((a,b)=>a.closeAt-b.closeAt);
   if(fourKnown.length>maximumFourHourBars)fourKnown.shift();
  }
  if(event.type==='METADATA')latestMetadata=event.value;
  if(event.type==='VENUE')latestVenue=event.value;
  if(event.type==='MARKET'){
   latestMarket=event.value;
   if(engine&&event.at>=startAt)engine.onMarket(event.value);
  }
  if(event.type==='CONTROL'&&engine&&event.at>=startAt){
   const value=event.value;
   if(value.type==='FUNDING')engine.applyFunding(value.funding);
   if(value.type==='CONNECTION')engine.setConnectionStatus({connected:value.connected,at:value.at});
   if(value.type==='CANCEL')engine.cancelOrder(value.key);
   if(value.type==='CLOSE'){engine.cancelOrder(value.key);engine.closePosition(value.key)}
  }
  if(event.type==='CANDLE_1H'){
   oneKnown.push(event.value);oneKnown.sort((a,b)=>a.closeAt-b.closeAt);if(oneKnown.length>maximumHourlyBars)oneKnown.shift();
   if(event.at<startAt)continue;
   const hourly=oneKnown.slice(-maximumHourlyBars).map(item=>item.row),fourHourly=fourKnown.slice(-maximumFourHourBars).map(item=>item.row),
    venue=latestVenue,venueSourceUsable=synthetic&&venue?.dataSource==='SYNTHETIC_FIXTURE';
   // Keep a price inseparable from its own source clock. A newly received
   // venue snapshot must never lend freshness to a different, older Mark.
   // Candle close is valid for analysis only, never execution-price evidence.
   let price=Number(event.value.row[4]),priceAt=null,priceSource='CANDLE_CLOSE_ANALYSIS_ONLY',priceSourceFresh=false;
   const maxPriceAgeMs=input.settings?.maxQuoteAgeMs??90000;
   if(latestMarket&&latestMarket.receivedAt<=now&&latestMarket.timestamp<=now){
    if(positive(latestMarket.markPrice))price=latestMarket.markPrice;
    priceAt=latestMarket.markPriceAt;priceSource='MARKET_MARK_PRICE';
    priceSourceFresh=positive(latestMarket.markPrice)&&stamp(priceAt)&&priceAt<=now&&now-priceAt<=maxPriceAgeMs;
   }else if(venueSourceUsable&&positive(venue.price)){
    price=venue.price;priceAt=venue.priceAt;priceSource='EXPLICIT_VENUE_PRICE';
    priceSourceFresh=stamp(priceAt)&&priceAt<=now&&now-priceAt<=maxPriceAgeMs;
   }
   const row=analyzeAt(input.symbol,hourly,fourHourly,[],price,{now,quoteVolume:latestMetadata?.quoteVolume??0});
   if(legacy){row.strategyVersion='LEGACY_V58';row.managementVersion='LEGACY_R_MULTIPLES'}
   const venueUsable=venueSourceUsable&&priceSourceFresh;
   const decision=(legacy?evaluateLegacySyntheticSignal:evaluateSignal)(row,{dataSource:venueUsable?venue.dataSource:undefined,
    verified:venueUsable&&venue.verified===true,venueConnected:venueUsable&&venue.venueConnected===true,
    market:venueUsable?venue.market:undefined,book:venueUsable?venue.book:undefined,price,priceAt,now});
   analysesCount++;if(row.patternConfirmed)patterns++;if(decision.technical)technical++;if(decision.ready)approved++;
   const observation={at:now,signalDetectedAt:row.patternConfirmed?now:null,entryEligibleAt:row.patternConfirmed?now+entry.latencyMs:null,
    patternConfirmedAt:row.patternConfirmedAt??null,last1hCloseAt:oneKnown.at(-1).closeAt,last4hCloseAt:fourKnown.at(-1)?.closeAt??null,
    h1Count:hourly.length,h4Count:fourHourly.length,patternObserved:row.patternConfirmed===true,
    analysisPrice:price,analysisPriceAt:priceAt,priceSource,priceSourceFresh,
    direction:row.direction??null,pattern:row.pattern??null,technicalQualified:decision.technical,
    finalApproved:decision.ready,entryAccepted:false,executionMode:input.executionMode,
    stage:decision.stage,reasons:[...decision.reasons],entry:row.entry??null,stop:row.stop??null,
    targets:row.patternConfirmed?[row.target1,row.target2,row.target3]:null,score:row.score??null};
   if(analyses.length<10000)analyses.push(clone(observation));
   if(row.patternConfirmed){
    // Decision history stays immutable. Later executions are attached only to
    // this separate signal outcome, with explicit registration/fill clocks.
    const outcome=clone(observation);
    if(signals.length<10000)signals.push(outcome);
    if(engine&&decision.ready){
     const normalized=normalizeOrangeXPaperSignal({...row,decision,qualified:decision.ready},{now,source:'SYNTHETIC_FIXTURE',instrumentName:input.instrumentName});
     const contract=engine.exportState().contracts[input.instrumentName],plan=normalized.ok?alignOrangeXPaperSignal(normalized.signal,contract):null;
     if(plan?.ok){
      outcome.signalKey=plan.signal.key;
      scheduled.push({at:now+entry.latencyMs,signal:plan.signal,observation:outcome,
       validUntil:Math.min(row.quality.validUntil,now+20*60000)});scheduled.sort((a,b)=>a.at-b.at);
     }else outcome.reasons.push(...(normalized.reasons??[]),...(plan?.reasons??[]));
    }
   }
  }
  if(processed%progressEvery===0)onProgress({at:now,processedEvents:processed,analysisCount:analysesCount,patternCount:patterns});
 }
 release(endAt);now=endAt;
 const snapshot=engine?.snapshot()??null;
 for(const signal of signals){
  const position=[...(snapshot?.open??[]),...(snapshot?.closed??[])].find(row=>row.key===signal.signalKey);
  signal.firstFillAt=position?.entryParts?.[0]?.at??null;
  signal.lastFillAt=position?.entryParts?.at(-1)?.at??null;
  signal.filledQuantity=position?.quantityOriginal??0;
 }
 return {kind:'ORANGEX_PAPER_REPLAY_RESULT',executionMode:input.executionMode,runKind:'BACKTEST',strategyVersion,
  dataSource:input.dataSource==='SYNTHETIC_FIXTURE'?'SYNTHETIC_FIXTURE':'USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN',
  originalDataSource:input.dataSource,sourceOriginVerified:false,
  provenance:input.dataSource==='SYNTHETIC_FIXTURE'?'SYNTHETIC_DATA': 'USER_DECLARED_HISTORICAL_UNVERIFIED_ORIGIN',
  realDataAutoEntryEnabled:false,liveOrdersEnabled:false,startAt,endAt,
  equalTimePolicy:'CONTROLS_BEFORE_MARKETS_BEFORE_CANDLE_ANALYSIS',
  fillAccuracy:!markets.length?'UNVERIFIED_NO_HISTORICAL_DEPTH':synthetic?'SYNTHETIC_MODEL_ONLY':'UNVERIFIED_HISTORICAL_DEPTH_NOT_EXECUTED',
  candleOnly:markets.length===0,snapshot,analyses,signals,
  summary:{processedEvents:processed,analysisCount:analysesCount,patterns,technicalPassed:technical,finalApproved:approved,
   marketSamples:markets.filter(item=>item.receivedAt>=startAt&&item.receivedAt<=endAt).length,
   trades:snapshot?.summary.closedCount??0,entries:entriesAccepted,
   analysesOmitted:Math.max(0,analysesCount-analyses.length),signalsOmitted:Math.max(0,patterns-signals.length),pendingSignalDecisions:scheduled.length},
  assumptions:['CLOSED_CANDLES_ONLY','NO_FUTURE_OHLC_ACCESS','SIGNAL_AND_ENTRY_AVAILABILITY_SEPARATE',
   'CANDLE_HIGH_LOW_DO_NOT_PROVE_EXECUTION','NO_BOOK_DEPTH_SYNTHESIS','BACKTEST_SEPARATE_FROM_FORWARD_PAPER','EQUAL_TIME_RISK_CONTROLS_FIRST',
   ...(synthetic?['EXPLICIT_SYNTHETIC_VENUE_AND_EXECUTION_ASSUMPTIONS']:['HISTORICAL_ANALYSIS_ONLY_NO_FILLS'])]};
}
