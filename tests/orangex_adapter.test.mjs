import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXClient,ORANGEX_API,orangeXInstrument,verifiedOrangeXInstrument,examineOrangeXBook,makeOrangeXOrderPlan,orangeXSignature} from '../orangex_adapter.mjs';
const now=1793750400000;
// These units and capabilities are synthetic protocol fixtures, not OrangeX specifications.
const instruments=[{instrument_name:'SOL-USDT-PERPETUAL',kind:'perpetual',is_active:true,contract_size:'0.1',min_qty:'0.1',min_trade_amount:'0.1',tick_size:'0.001',min_notional:'1'}];
const book={instrument_name:'SOL-USDT-PERPETUAL',timestamp:now-1000,bids:[['149.95','100']],asks:[['150.05','100']]};
const signal={symbol:'SOLUSDT',direction:'LONG',pattern:'retest',time:now-3600000,patternConfirmedAt:now-20000,
 patternConfirmed:true,patternTimeframe:'1h',
 score:95,scoreVersion:'ISSUE6-100-V1',technicalQualified:true,technicalValidation:{passed:true},qualified:true,status:'signal',stop:148,
 managementVersion:'VOLUME_PROFILE_V1',targetPlan:{ok:true,targets:[160,170,180]}};
const mock={status:'MOCK_VALIDATED',dataSource:'SYNTHETIC_TEST'};
const options=()=>({signal,binancePrice:150,binancePriceAt:now-1000,orangexBook:book,instruments,now,
 contractVerification:{...mock,instrumentName:'SOL-USDT-PERPETUAL',binanceSymbol:'SOLUSDT',quantityUnit:'CONTRACT',bookQuantityUnit:'CONTRACT',amountMode:'DEFAULT_QUANTITY',
  minNotionalCurrency:'USDT',priceCurrency:'USDT',settlementCurrency:'USDT',contractType:'LINEAR_PERPETUAL',contractSizeBase:.1},
 tradeApproval:{...mock,approved:true},executionCapabilities:{protectiveStop:mock,safeStopReplace:mock,reduceOnly:mock},
 costAssumptions:{source:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,fundingReserveFraction:.0003}});
test('matches only active exact OrangeX USDT perpetuals',()=>{
 assert.equal(orangeXInstrument('SOLUSDT'),'SOL-USDT-PERPETUAL');assert.equal(verifiedOrangeXInstrument('SOLUSDT',instruments),'SOL-USDT-PERPETUAL');
 assert.throws(()=>verifiedOrangeXInstrument('ETHUSDT',instruments));assert.throws(()=>orangeXInstrument('SOLBTC'));
 assert.throws(()=>verifiedOrangeXInstrument('SOLUSDT',[...instruments,...instruments]));
});
test('rejects stale, crossed, duplicate, unsorted and wide order books',()=>{
 assert.equal(examineOrangeXBook(book,{now}).ask,150.05);
 for(const patch of [{timestamp:now-20000},{timestamp:now+1},{asks:[['149','100']]},{asks:[['151','100']]},
  {asks:[['150.05','100'],['150.05','100']]},{bids:[['149.8','1'],['149.95','1']]}])assert.throws(()=>examineOrangeXBook({...book,...patch},{now}));
});
test('preflight supports qualified canonical scores while independent approval, contract units and protection remain mandatory',()=>{
 const opts=options(),plan=makeOrangeXOrderPlan(opts);
 assert.equal(plan.previewOnly,true);assert.equal(plan.intent.side,'BUY');assert.equal(plan.intent.type,'LIMIT');assert.equal(plan.intent.quantityUnit,'CONTRACT');
 assert.equal(plan.transportAllowed,false);assert.equal(plan.activationAllowed,false);assert.equal(plan.liveOrdersEnabled,false);assert.ok(plan.plannedRiskUSDT<=2);
 assert.equal(plan.intent.targets.length,3);assert.equal(plan.actualAccountRateVerified,false);assert.equal(Object.hasOwn(plan,'params'),false,'unverified private API fields are not invented');
 for(const patch of [{signal:{...signal,score:85}},{signal:{...signal,score:null}},{signal:{...signal,qualified:false}},
  {signal:{...signal,targetPlan:null}},{contractVerification:null},{tradeApproval:null},{executionCapabilities:{}},
  {binancePriceAt:now-20000},{instruments:[]},{binancePrice:140},{costAssumptions:null},
  {contractVerification:{...opts.contractVerification,contractSizeBase:1}},{contractVerification:{...opts.contractVerification,minNotionalCurrency:'UNKNOWN'}}])
  assert.throws(()=>makeOrangeXOrderPlan({...opts,...patch}));
});
test('HMAC helper is only a protocol fixture and credentials never appear in serialized client state',()=>{
 const args={clientId:'unit-id-never-output',clientSecret:'unit-secret-never-output',timestamp:'12',nonce:'nonce'};
 assert.equal(orangeXSignature(args).length,64);assert.notEqual(orangeXSignature(args),orangeXSignature({...args,nonce:'different'}));
 const client=new OrangeXClient({...args});assert.doesNotMatch(JSON.stringify(client),/unit-secret-never-output|unit-id-never-output/);
});
test('write methods and unverified authentication are refused before any network call',async()=>{
 let calls=0;const client=new OrangeXClient({clientId:'fixture',clientSecret:'fixture',transport:()=>{calls++;throw Error('unexpected network')}});
 for(const method of ['/private/buy','/private/sell','/private/withdraw','/private/cancel','/private/change_leverage']){
  await assert.rejects(()=>client.rpc(method,{},'token'),/disabled/);await assert.rejects(()=>client.read(method),/disabled/);
 }
 await assert.rejects(()=>client.positions(),/specification is unverified/);assert.equal(calls,0);
});
test('public book uses the fixed read-only protocol URL and no authorization header',async()=>{
 let calls=0;const client=new OrangeXClient({contractVerification:{jsonRpcSpecificationVerified:true},transport:async(url,init)=>{
  calls++;assert.equal(url,ORANGEX_API);assert.equal(JSON.parse(init.body).method,'/public/get_order_book');assert.equal('Authorization' in init.headers,false);
  return {ok:true,json:async()=>({id:1,jsonrpc:'2.0',result:book})};
 }});
 assert.deepEqual(await client.orderBook('SOL-USDT-PERPETUAL'),book);assert.equal(calls,1);
});
test('unreviewed RPC support and write-scope authentication cannot send a network request',async()=>{
 let calls=0;const transport=async()=>{calls++;throw Error('unexpected transport')};
 await assert.rejects(()=>new OrangeXClient({transport}).orderBook('SOL-USDT-PERPETUAL'),/JSON-RPC specification is unverified/);
 const reviewed=new OrangeXClient({transport,contractVerification:{officialSpecVerified:true,readAuthVerified:true,jsonRpcSpecificationVerified:true}});
 await assert.rejects(()=>reviewed.rpc('/public/auth',{scope:'trade:write'}),/only read permission/);assert.equal(calls,0);
});
test('missing technical confirmation, invalid age limits and guessed fees never qualify a preview',()=>{
 const opts=options();
 for(const patch of [{signal:{...signal,technicalValidation:undefined}},{signal:{...signal,patternTimeframe:'4h'}},
  {signal:{...signal,patternConfirmed:false}},{maxPriceAgeMs:NaN},{maxPriceAgeMs:Infinity},{maxPriceAgeMs:90001},
  {costAssumptions:{source:'STANDARD_SCHEDULE_ASSUMPTION',makerRate:0,takerRate:0,fundingReserveFraction:0}},
  {costAssumptions:{source:'VERIFIED_ACCOUNT_RATE',makerRate:.0002,takerRate:.0006,fundingReserveFraction:.0003}}])
  assert.throws(()=>makeOrangeXOrderPlan({...opts,...patch}));
});
test('split exits preserve exact40/35/25 and rounded limit never exceeds the slippage budget',()=>{
 const opts=options(),plan=makeOrangeXOrderPlan(opts),parts=plan.intent.targets;
 for(const [index,fraction] of [.4,.35,.25].entries())assert.ok(Math.abs(parts[index].quantity-plan.intent.amount*fraction)<1e-10);
 assert.ok(plan.intent.limitPrice<=Number(book.asks[0][0])*(1+.001));
 assert.ok(plan.plannedRiskUSDT<=2&&plan.notionalUSDT<=100);
 assert.throws(()=>makeOrangeXOrderPlan({...opts,signal:{...signal,stop:148.0005}}),/grid/);
});
