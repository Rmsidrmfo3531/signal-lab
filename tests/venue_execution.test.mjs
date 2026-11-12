import test from 'node:test';
import assert from 'node:assert/strict';
import {selectExecutionVenue,venueSizingInputs,venueCosts,venueStop,venueOrderQuantity,parsePaperVenues} from '../venue_execution.mjs';
import {normalizeBingXContract,normalizeGateContract,normalizeBook} from '../venue_market_data.mjs';
import {PaperEngine,paperCSV,venueOf} from '../paper.mjs';

const NOW=Date.parse('2026-11-10T12:00:00Z');
const bingxContract=(extra={})=>normalizeBingXContract({symbol:'ETH-USDT',currency:'USDT',asset:'ETH',pricePrecision:2,quantityPrecision:2,tradeMinQuantity:'0.01',tradeMinUSDT:'5',status:1,apiStateOpen:'true',apiStateClose:'true',takerFeeRate:0.0005,...extra});
const gateContract=(extra={})=>normalizeGateContract({name:'ETH_USDT',type:'direct',quanto_multiplier:'0.01',order_price_round:'0.01',order_size_min:1,status:'trading',in_delisting:false,...extra});
const bingxBook=(bid,ask,T=NOW-200)=>normalizeBook('BINGX',{T,bids:[[String(bid),'500']],asks:[[String(ask),'500']]},{receivedAt:NOW,now:NOW});
const gateBook=(bid,ask,T=NOW-200)=>normalizeBook('GATEIO',{current:T/1000,bids:[{p:String(bid),s:50000}],asks:[{p:String(ask),s:50000}]},{receivedAt:NOW,now:NOW});
const signal=(direction='LONG')=>({symbol:'ETHUSDT',direction,entry:100,stop:direction==='LONG'?98.005:101.995,atr:2});

test('the venue with the better executable entry is chosen; untradable, unlisted and stale venues are excluded',()=>{
 const long=selectExecutionVenue({signal:signal('LONG'),now:NOW,venues:{BINGX:{contract:bingxContract(),book:bingxBook(99.99,100.03)},GATEIO:{contract:gateContract(),book:gateBook(99.98,100.01)}}});
 assert.equal(long.chosen.venue,'GATEIO','lower ask for a long');
 const short=selectExecutionVenue({signal:signal('SHORT'),now:NOW,venues:{BINGX:{contract:bingxContract(),book:bingxBook(99.99,100.03)},GATEIO:{contract:gateContract(),book:gateBook(99.98,100.01)}}});
 assert.equal(short.chosen.venue,'BINGX','higher bid for a short');
 const blocked=selectExecutionVenue({signal:signal(),now:NOW,venues:{BINGX:{contract:bingxContract({apiStateOpen:'false'}),book:bingxBook(99.99,100.01)},GATEIO:{contract:null,book:null}}});
 assert.equal(blocked.chosen,null);
 assert.deepEqual(blocked.candidates.map(c=>[c.venue,c.reasons[0]]),[['BINGX','VENUE_API_TRADING_DISABLED'],['GATEIO','VENUE_NOT_LISTED']]);
 const stale=selectExecutionVenue({signal:signal(),now:NOW,venues:{BINGX:{contract:bingxContract(),book:bingxBook(99.99,100.01,NOW-60000)}},allowed:['BINGX']});
 assert.equal(stale.chosen,null);assert.ok(stale.candidates[0].reasons.includes('BOOK_STALE'));
 assert.deepEqual(parsePaperVenues('gateio'),['GATEIO']);assert.deepEqual(parsePaperVenues(''),['BINGX']);assert.deepEqual(parsePaperVenues('OTHER'),['BINGX']);
});

test('Gate.io sizing uses whole contracts on the 20-lot split grid and its contract-count depth',()=>{
 const contract=gateContract(),inputs=venueSizingInputs(contract,gateBook(99.99,100.01));
 assert.equal(inputs.market.filters.LOT_SIZE.stepSize,'0.01');assert.equal(inputs.book.asks[0][1],'500','50000 contracts x 0.01 ETH');
 assert.ok(Math.abs(Number(inputs.market.filters.MIN_NOTIONAL.notional)-0.01*100.01)<1e-9,'derived from order_size_min contracts');
 const {chosen}=selectExecutionVenue({signal:signal(),now:NOW,venues:{GATEIO:{contract,book:gateBook(99.99,100.01)}},allowed:['GATEIO']});
 assert.equal(chosen.venue,'GATEIO');
 const contracts=Math.round(chosen.estimate.quantity/0.01);
 assert.ok(Math.abs(contracts*0.01-chosen.estimate.quantity)<1e-12,'whole contracts');assert.equal(contracts%20,0,'40/35/25 split stays on whole contracts');
 assert.ok(chosen.estimate.estimatedStopLossUSD<=6);
 assert.deepEqual(venueOrderQuantity(contract,chosen.estimate.quantity),{quantity:String(contracts),unit:'CONTRACT',baseQuantity:chosen.estimate.quantity});
 assert.deepEqual(venueOrderQuantity(bingxContract(),1.2),{quantity:'1.2',unit:'BASE_ASSET'});
});

test('venue stop is never tighter than the chart stop and costs never go below the paper default',()=>{
 assert.equal(venueStop(98.005,'LONG','0.01'),98);assert.equal(venueStop(101.995,'SHORT','0.01'),102);assert.equal(venueStop(98.005,'LONG','0.1'),98);
 assert.equal(venueCosts({takerFeeRate:0.0005},2).takerRate,0.0006);assert.equal(venueCosts({takerFeeRate:0.0008},2).takerRate,0.0008);
 assert.equal(venueCosts(null,2).assumption,'EXPLICIT_PAPER_ASSUMPTIONS');
});

function profileSignal(executionVenue){
 const quantity=2.6,prices=[105,108,112];
 return {symbol:'ETHUSDT',direction:'LONG',pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,stop:98,patternConfirmedAt:NOW-1000,managementVersion:'VOLUME_PROFILE_V1',
  ...(executionVenue?{executionVenue,venueSymbol:'ETH-USDT'}:{}),
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:quantity*[.4,.35,.25][i]})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST',startAt:NOW-3600000,endAt:NOW-1000,coverage:1,historicalOrderBookAvailable:false},
   costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},estimatedNetRR:2.1}};
}

test('paper records follow only their own venue; records from before the switch stay on Binance prices',()=>{
 let now=NOW;const engine=new PaperEngine({},{now:()=>now,settings:{requireExecutionVenue:true}});
 assert.equal(engine.register(profileSignal(null),{quoteEligible:true}),false);
 assert.equal(engine.store.skipped.at(-1).reason,'EXECUTION_VENUE_UNAVAILABLE');
 assert.equal(engine.register(profileSignal('BINGX'),{quoteEligible:true}),true);
 assert.equal(engine.store.pending[0].executionVenue,'BINGX');
 now+=1000;engine.onPrice('CRYPTO','ETHUSDT',100,now,{venue:'BINANCE'});
 now+=1000;engine.onPrice('CRYPTO','ETHUSDT',100,now,{venue:'GATEIO'});
 assert.equal(engine.store.open.length,0,'Binance and other-venue prices never fill a BingX record');
 now+=1000;engine.onPrice('CRYPTO','ETHUSDT',100,now,{venue:'BINGX',halfSpreadBps:1});
 assert.equal(engine.store.open.length,1);const position=engine.store.open[0];
 assert.equal(venueOf(position),'BINGX');assert.ok(Math.abs(position.entryFill-100*(1+3/10000))<1e-9,'venue half spread + slippage');
 now+=1000;engine.onPrice('CRYPTO','ETHUSDT',97,now,{venue:'BINANCE'});
 assert.equal(engine.store.open.length,1,'a Binance print below the stop does not stop out a venue position');
 now+=1000;engine.onPrice('CRYPTO','ETHUSDT',97.9,now,{venue:'BINGX',halfSpreadBps:1});
 assert.equal(engine.store.closed.length,1);assert.equal(engine.store.closed[0].closeReason,'STOP');
 assert.match(paperCSV(engine.store.closed).split('\r\n')[1],/^"CRYPTO","BINGX","ETHUSDT"/);

 // A record opened before the switch has no venue and keeps following the Binance feed.
 let later=NOW;const legacy=new PaperEngine({},{now:()=>later,settings:{}});
 assert.equal(legacy.register(profileSignal(null),{quoteEligible:true}),true);
 later+=1000;legacy.onPrice('CRYPTO','ETHUSDT',100,later,{venue:'BINGX'});assert.equal(legacy.store.open.length,0);
 later+=1000;legacy.onPrice('CRYPTO','ETHUSDT',100,later,{venue:'BINANCE'});assert.equal(legacy.store.open.length,1);
 assert.equal(venueOf(legacy.store.open[0]),'BINANCE');
});

test('live routing: a Gate.io paper signal goes to BingX when only BingX has live keys',async()=>{
 const {routeLiveSignal}=await import('../venue_execution.mjs');
 const bingx={tickSize:'0.01',quantityStep:'0.01',quantityUnit:'BASE_ASSET',contractSizeBase:'1',minQuantityBase:'0.01'};
 const T=Date.parse('2026-11-12T06:00:00Z'),costs={takerRate:.0005,makerRate:.0002,slippageBps:2,spreadBps:2,fundingRate:0};
 const row={symbol:'ETHUSDT',direction:'LONG',targetPlan:{quantity:.5,costAssumptions:costs},executionVenue:'GATEIO',venueSymbol:'ETH_USDT',venueContract:{tickSize:'0.05'},rawStop:97.987,stop:97.95,targets:[105.057,108.003,112.009],
  liveAlternatives:[{venue:'BINGX',venueSymbol:'ETH-USDT',entryBasis:100,quantity:0.5,estimatedStopLossUSD:1.1,spreadBps:3,quotedAt:T,venueContract:bingx}]};
 const r=routeLiveSignal(row,{enabled:['BINGX','GATEIO'],credentials:{BINGX:true,GATEIO:false},now:T+5000});
 assert.equal(r.executionVenue,'BINGX');assert.equal(r.venueSymbol,'ETH-USDT');assert.equal(r.liveRoutedFrom,'GATEIO');
 assert.equal(r.stop,97.98,'stop away from the entry on the BingX grid');assert.deepEqual(r.targets,[105.05,108,112],'targets toward the entry');
 assert.equal(r.entry,100);assert.equal(r.execution.estimatedStopLossUSD,1.1);
 const s=routeLiveSignal({...row,direction:'SHORT',rawStop:102.013,targets:[95.011,92.004,90.001]},{enabled:['BINGX'],credentials:{BINGX:true},now:T});
 assert.equal(s.stop,102.02);assert.deepEqual(s.targets,[95.02,92.01,90.01]);
 // A worse entry on BingX that breaks the TP1 net 1.8R: not routed.
 const worse={...row,liveAlternatives:[{...row.liveAlternatives[0],entryBasis:101.5}]};
 assert.equal(routeLiveSignal(worse,{enabled:['BINGX'],credentials:{BINGX:true},now:T}).executionVenue,'GATEIO');
 assert.equal(routeLiveSignal(row,{enabled:['BINGX'],credentials:{BINGX:true},now:T+16000}).executionVenue,'GATEIO','quote older than 15 s: not routed');
 assert.equal(routeLiveSignal({...row,targetPlan:{quantity:.5}},{enabled:['BINGX'],credentials:{BINGX:true},now:T}).executionVenue,'GATEIO','no cost assumptions: not routed');
 assert.equal(routeLiveSignal(row,{enabled:['BINGX','GATEIO'],credentials:{BINGX:true,GATEIO:true}}),row,'paper venue with keys: unchanged');
 assert.equal(routeLiveSignal({...row,liveAlternatives:[]},{enabled:['BINGX'],credentials:{BINGX:true}}).executionVenue,'GATEIO','no alternative: unchanged (preflight reports it)');
});
