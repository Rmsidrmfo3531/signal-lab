import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {bingxSign,gateSign,BingXTradeClient,GateTradeClient,LIVE_HOSTS} from '../live_clients.mjs';
import {liveConfig,liveQuantity,preflight,bingxOrders,gateOrders,liveClientId} from '../live_orders.mjs';
import {LiveExecutor} from '../live_executor.mjs';

const NOW=Date.parse('2026-11-10T12:00:00Z');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'live-exec-'));
const BINGX_SECRET='bingx-test-secret-value-0123456789',GATE_SECRET='gate-test-secret-value-0123456789';

test('signatures reproduce the official examples (BingX openssl example, Gate.io SDK formula)',()=>{
 // echo -n 'recvWindow=0&symbol=BTC-USDT&timestamp=1696751141337' | openssl dgst -sha256 -hmac 'SECRET_KEY'
 assert.equal(bingxSign({symbol:'BTC-USDT',recvWindow:0,timestamp:1696751141337},'SECRET_KEY'),'fe041f159118c90ac13eab4d32f9e2d75b80ca6fe17ca8acd290aba864753ce2');
 // gate_api.ApiClient.gen_sign with a fixed timestamp
 assert.equal(gateSign({method:'POST',path:'/api/v4/futures/usdt/orders',query:'',body:'{"contract":"BTC_USDT","size":10}',timestamp:'1700000000'},'gate-secret'),
  'a4e446d4f4649e11100dcb56f9bc4496440d6abcdc2d5f07d1fb2962208e27f7eb908628b3acfc9a04c90eba366ddc83aa45f329f311d55f957dcf8a20559fc8');
});

// ---- Mock venues that verify every signature exactly as documented ---------------
function mockBingX({hedge=false,entry='ok',stopAttached=true,positionAmt=()=>'0.20',stopPlacement='ok'}={}){
 const calls=[],orders=[];let id=1000;
 const fetcher=async(url,options)=>{
  const u=new URL(url),q=Object.fromEntries([...u.searchParams].filter(([k])=>k!=='signature'));
  assert.equal(u.origin,LIVE_HOSTS.BINGX.TESTNET);assert.equal(options.headers['X-BX-APIKEY'],'bingx-key');
  assert.equal(u.searchParams.get('signature'),createHmac('sha256',BINGX_SECRET).update(Object.keys(q).sort().map(k=>`${k}=${q[k]}`).join('&')).digest('hex'),'BingX signature');
  assert.ok(!url.includes(BINGX_SECRET));
  const call={method:options.method,path:u.pathname,params:q};calls.push(call);
  if(u.pathname==='/openApi/swap/v1/positionSide/dual')return json({code:0,data:{dualSidePosition:hedge}});
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='POST'){
   if(q.type==='MARKET'&&!q.reduceOnly){
    if(entry==='timeout')throw TypeError('fetch failed');
    if(entry==='reject')return json({code:101204,msg:'Insufficient margin'});
    const o={orderID:String(++id),type:'MARKET',clientOrderId:q.clientOrderId};orders.push(o);
    if(stopAttached)orders.push({orderID:String(++id),type:'STOP_MARKET'});
    return json({code:0,data:{order:o}});
   }
   if(q.type==='STOP_MARKET'&&stopPlacement==='fail')return json({code:109400,msg:'stop rejected'});
   const o={orderID:String(++id),type:q.type};orders.push(o);return json({code:0,data:{order:o}});
  }
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='GET'){
   const o=orders.find(x=>x.clientOrderId===q.clientOrderId);return o?json({code:0,data:{order:o}}):json({code:80016,msg:'order not exist'});
  }
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='DELETE')return json({code:0,data:{order:{orderID:q.orderId}}});
  if(u.pathname==='/openApi/swap/v2/trade/openOrders')return json({code:0,data:{orders:orders.filter(o=>o.type!=='MARKET')}});
  if(u.pathname==='/openApi/swap/v2/user/positions')return json({code:0,data:[{symbol:'ETH-USDT',positionAmt:positionAmt(),avgPrice:'100.02',positionSide:'LONG'}]});
  throw Error('unexpected '+u.pathname);
 };
 return {calls,orders,client:new BingXTradeClient({apiKey:'bingx-key',secret:BINGX_SECRET,mode:'TESTNET',fetcher,now:()=>NOW})};
}
function mockGate({dual=false,fill=20,stop='ok',size=()=>20}={}){
 const calls=[];let id=50;
 const fetcher=async(url,options)=>{
  const u=new URL(url),body=options.body??'';
  assert.equal(u.origin,LIVE_HOSTS.GATEIO.TESTNET);assert.equal(options.headers.KEY,'gate-key');
  assert.equal(options.headers.SIGN,gateSign({method:options.method,path:u.pathname,query:decodeURIComponent(u.search.slice(1)),body,timestamp:options.headers.Timestamp},GATE_SECRET),'Gate.io signature');
  const call={method:options.method,path:u.pathname,body:body?JSON.parse(body):null};calls.push(call);
  if(u.pathname==='/api/v4/futures/usdt/accounts')return json({in_dual_mode:dual,available:'100'});
  if(u.pathname==='/api/v4/futures/usdt/orders'&&options.method==='POST'){
   if(call.body.close)return json({id:++id,size:0,left:0,finish_as:'filled'});
   return json({id:++id,size:call.body.size,left:call.body.size-Math.sign(call.body.size)*fill,fill_price:'100.01',finish_as:fill?'filled':'ioc'});
  }
  if(u.pathname==='/api/v4/futures/usdt/price_orders'&&options.method==='POST'){
   if(stop==='fail'&&call.body.order_type.startsWith('close-'))return json({label:'INVALID_PARAM_VALUE'},400);
   return json({id:++id});
  }
  if(u.pathname.startsWith('/api/v4/futures/usdt/price_orders/')&&options.method==='DELETE')return json({id:1});
  if(u.pathname.startsWith('/api/v4/futures/usdt/positions/'))return json({contract:'ETH_USDT',size:size(),entry_price:'100.01'});
  throw Error('unexpected '+u.pathname);
 };
 return {calls,client:new GateTradeClient({apiKey:'gate-key',secret:GATE_SECRET,mode:'TESTNET',fetcher,now:()=>NOW})};
}
const config=(extra={})=>({mode:'TESTNET',liveConfirmed:false,venues:['BINGX','GATEIO'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:1,...extra});
function row(venue='BINGX',extra={}){
 const gate=venue==='GATEIO';
 return {symbol:'ETHUSDT',executionVenue:venue,venueSymbol:gate?'ETH_USDT':'ETH-USDT',direction:'LONG',stop:98,targets:[105,108,112],
  venueContract:gate?{quantityUnit:'CONTRACT',contractSizeBase:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',tickSize:'0.01'}:{quantityUnit:'BASE_ASSET',contractSizeBase:'1',quantityStep:'0.01',minQuantityBase:'0.01',tickSize:'0.01'},
  targetPlan:{quantity:0.6},execution:{estimatedStopLossUSD:6},decision:{ready:true},...extra};
}

test('live quantity scales the paper plan to the live risk cap on the 20-lot grid',()=>{
 const base=liveQuantity({quantity:0.6,estimatedStopLossUSD:6,maxRiskUSD:2,contract:row().venueContract});
 assert.deepEqual({total:base.total,parts:base.parts,unit:base.unit},{total:0.2,parts:[0.08,0.07,0.05],unit:'BASE_ASSET'});assert.ok(Math.abs(base.riskUSD-2)<1e-9);
 const gate=liveQuantity({quantity:0.6,estimatedStopLossUSD:6,maxRiskUSD:2,contract:row('GATEIO').venueContract});
 assert.deepEqual({total:gate.total,parts:gate.parts,unit:gate.unit},{total:20,parts:[8,7,5],unit:'CONTRACT'});
 assert.equal(liveQuantity({quantity:0.6,estimatedStopLossUSD:6,maxRiskUSD:0.1,contract:row().venueContract}),null,'below the 20-lot minimum');
 assert.equal(liveQuantity({quantity:0.6,estimatedStopLossUSD:1,maxRiskUSD:2,contract:row().venueContract}).total,0.6,'never scaled up');
});

test('configuration defaults are OFF and conservative; LIVE needs the confirmation phrase',()=>{
 assert.deepEqual(liveConfig({}),{mode:'OFF',liveConfirmed:false,venues:['BINGX','GATEIO'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:1});
 assert.equal(liveConfig({LIVE_TRADING_MODE:'live',LIVE_TRADING_CONFIRM:'REAL_MONEY'}).liveConfirmed,true);
 assert.equal(liveConfig({LIVE_TRADING_MODE:'yolo'}).mode,'OFF');assert.equal(liveConfig({LIVE_MAX_RISK_USD:'1000'}).maxRiskUSD,2,'out-of-range values fall back');
});

test('preflight blocks every unsafe condition with a named reason',()=>{
 const qty=liveQuantity({quantity:0.6,estimatedStopLossUSD:6,maxRiskUSD:2,contract:row().venueContract});
 const base={config:config(),armed:true,killSwitch:false,credentials:{BINGX:true,GATEIO:true},row:row(),records:[],now:NOW,qty};
 assert.equal(preflight(base).ok,true);
 const cases=[[{config:config({mode:'OFF'})},'LIVE_MODE_OFF'],[{config:config({mode:'LIVE'})},'LIVE_CONFIRM_MISSING'],[{armed:false},'NOT_ARMED'],
  [{killSwitch:true},'KILL_SWITCH_ON'],[{credentials:{}},'CREDENTIALS_MISSING'],[{config:config({venues:['GATEIO']})},'VENUE_NOT_ENABLED_FOR_LIVE'],
  [{row:row('BINGX',{decision:{ready:false}})},'SIGNAL_NOT_READY'],[{qty:null},'QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK'],
  [{records:[{status:'OPEN',symbol:'BTCUSDT'}]},'MAX_OPEN_POSITIONS'],[{config:config({maxOpen:3}),records:[{status:'OPEN',symbol:'ETHUSDT'}]},'SYMBOL_ALREADY_ACTIVE'],
  [{records:[{status:'UNKNOWN',symbol:'X'}],config:config({maxOpen:3})},'UNRESOLVED_ORDER_STATE'],
  [{records:[{status:'CLOSED',day:'2026-11-10',plannedRiskUSD:5}]},'DAILY_RISK_LIMIT'],
  [{row:row('GATEIO',{venueContract:{...row('GATEIO').venueContract,decimalSizes:true}})},'GATEIO_DECIMAL_SIZE_UNVERIFIED']];
 for(const [patch,reason] of cases)assert.ok(preflight({...base,...patch}).reasons.includes(reason),reason);
});

test('BingX: entry carries the stop, three reduce-only targets follow, a repeated signal is never resent',async()=>{
 const m=mockBingX(),dir=tmp(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},directory:dir,now:()=>NOW});
 assert.equal((await ex.onSignal(row(),{signalKey:'k1'})).reasons[0],'NOT_ARMED');assert.equal(m.calls.length,0,'nothing is sent before arming');
 ex.arm();const result=await ex.onSignal(row(),{signalKey:'k1'});assert.equal(result.status,'OPEN');
 const posts=m.calls.filter(c=>c.method==='POST').map(c=>c.params);
 assert.equal(posts[0].type,'MARKET');assert.equal(posts[0].side,'BUY');assert.equal(posts[0].positionSide,'BOTH');assert.equal(posts[0].quantity,'0.2');
 assert.deepEqual(JSON.parse(posts[0].stopLoss),{type:'STOP_MARKET',stopPrice:98,workingType:'MARK_PRICE'});assert.equal(posts[0].clientOrderId,liveClientId('k1'));
 assert.deepEqual(posts.slice(1).map(p=>[p.type,p.side,p.quantity,p.stopPrice,p.reduceOnly]),[['TAKE_PROFIT_MARKET','SELL','0.08','105','true'],['TAKE_PROFIT_MARKET','SELL','0.07','108','true'],['TAKE_PROFIT_MARKET','SELL','0.05','112','true']]);
 const record=ex.store.records[0];assert.ok(record.stopOrderId);assert.equal(record.targetOrderIds.length,3);
 assert.equal((await ex.onSignal(row(),{signalKey:'k1'})).reasons[0],'DUPLICATE_SIGNAL');
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'live-orders.json'),'utf8'));assert.equal(saved.records[0].status,'OPEN');
 assert.ok(!fs.readFileSync(path.join(dir,'live-orders.json'),'utf8').includes(BINGX_SECRET),'no secret in the ledger');
});

test('BingX: hedge mode and rejected margin never leave a position; a timed-out entry is looked up, not resent',async()=>{
 const hedge=mockBingX({hedge:true}),a=new LiveExecutor({config:config(),clients:{BINGX:hedge.client},now:()=>NOW});a.arm();
 await a.onSignal(row(),{signalKey:'h'});assert.equal(a.store.records[0].status,'FAILED');assert.ok(!hedge.calls.some(c=>c.method==='POST'));
 const reject=mockBingX({entry:'reject'}),b=new LiveExecutor({config:config(),clients:{BINGX:reject.client},now:()=>NOW});b.arm();
 await b.onSignal(row(),{signalKey:'r'});assert.equal(b.store.records[0].status,'FAILED');assert.equal(b.store.killSwitch,false);
 const timeout=mockBingX({entry:'timeout'}),c=new LiveExecutor({config:config(),clients:{BINGX:timeout.client},now:()=>NOW});c.arm();
 await c.onSignal(row(),{signalKey:'t'});
 assert.equal(c.store.records[0].status,'UNKNOWN');assert.equal(c.store.killSwitch,true,'unknown outcome stops trading');
 assert.equal(timeout.calls.filter(x=>x.method==='POST').length,1,'the entry is sent once');
 assert.ok(timeout.calls.some(x=>x.method==='GET'&&x.params.clientOrderId===liveClientId('t')),'looked up by client id');
 assert.equal((await c.onSignal(row('BINGX',{symbol:'BTCUSDT'}),{signalKey:'t2'})).reasons.includes('KILL_SWITCH_ON'),true);
});

test('BingX: a missing stop is placed explicitly; if that fails the position is closed and trading stops',async()=>{
 const placed=mockBingX({stopAttached:false}),a=new LiveExecutor({config:config(),clients:{BINGX:placed.client},now:()=>NOW});a.arm();
 await a.onSignal(row(),{signalKey:'s1'});assert.equal(a.store.records[0].status,'OPEN');
 assert.ok(placed.calls.some(c=>c.params.type==='STOP_MARKET'&&c.params.reduceOnly==='true'&&c.params.stopPrice==='98'));
 const broken=mockBingX({stopAttached:false,stopPlacement:'fail'}),b=new LiveExecutor({config:config(),clients:{BINGX:broken.client},now:()=>NOW});b.arm();
 await b.onSignal(row(),{signalKey:'s2'});
 assert.equal(b.store.records[0].closeReason,'EMERGENCY_NO_STOP');assert.equal(b.store.killSwitch,true);
 const close=broken.calls.filter(c=>c.method==='POST').at(-1).params;assert.deepEqual([close.type,close.side,close.reduceOnly,close.quantity],['MARKET','SELL','true','0.2']);
 assert.ok(!broken.calls.some(c=>c.params.type==='TAKE_PROFIT_MARKET'),'no targets on an unprotected position');
});

test('Gate.io: IOC entry, then mark-price stop and three partial reduce-only targets in contracts',async()=>{
 const m=mockGate(),ex=new LiveExecutor({config:config(),clients:{GATEIO:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row('GATEIO'),{signalKey:'g1'});assert.equal(ex.store.records[0].status,'OPEN');
 const posts=m.calls.filter(c=>c.method==='POST').map(c=>c.body);
 assert.deepEqual(posts[0],{contract:'ETH_USDT',size:20,price:'0',tif:'ioc',text:'t-'+liveClientId('g1')});
 assert.ok(posts[0].text.length-2<=28,'Gate text limit');
 assert.deepEqual(posts[1],{initial:{contract:'ETH_USDT',size:0,price:'0',tif:'ioc',close:true},trigger:{strategy_type:0,price_type:1,price:'98',rule:2},order_type:'close-long-position'});
 assert.deepEqual(posts.slice(2).map(p=>[p.initial.size,p.trigger.price,p.trigger.rule,p.order_type,p.initial.reduce_only]),
  [[-8,'105',1,'plan-close-long-position',true],[-7,'108',1,'plan-close-long-position',true],[-5,'112',1,'plan-close-long-position',true]]);
});

test('Gate.io: a failed stop closes the position at market and engages the kill switch; partial fills resize targets',async()=>{
 const m=mockGate({stop:'fail'}),ex=new LiveExecutor({config:config(),clients:{GATEIO:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row('GATEIO'),{signalKey:'g2'});
 assert.equal(ex.store.records[0].closeReason,'EMERGENCY_NO_STOP');assert.equal(ex.store.killSwitch,true);
 assert.deepEqual(m.calls.filter(c=>c.method==='POST').at(-1).body,{contract:'ETH_USDT',size:0,price:'0',tif:'ioc',close:true});
 const partial=mockGate({fill:10}),p=new LiveExecutor({config:config(),clients:{GATEIO:partial.client},now:()=>NOW});p.arm();
 await p.onSignal(row('GATEIO'),{signalKey:'g3'});
 assert.deepEqual(partial.calls.filter(c=>c.body?.order_type?.startsWith('plan')).map(c=>c.body.initial.size),[-4,-3,-3]);
 const none=mockGate({fill:0}),n=new LiveExecutor({config:config(),clients:{GATEIO:none.client},now:()=>NOW});n.arm();
 await n.onSignal(row('GATEIO'),{signalKey:'g4'});assert.equal(n.store.records[0].status,'FAILED');assert.ok(!none.calls.some(c=>c.path.endsWith('price_orders')));
});

test('reconcile: after TP1 the new breakeven stop is placed before the old one is cancelled; a flat position closes the record',async()=>{
 let amt='0.20';const m=mockBingX({positionAmt:()=>amt}),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row(),{signalKey:'b1'});const oldStop=ex.store.records[0].stopOrderId;
 await ex.reconcile();assert.equal(ex.store.records[0].breakevenMoved,false,'nothing filled yet');
 amt='0.12';const before=m.calls.length;await ex.reconcile();
 const after=m.calls.slice(before),placeAt=after.findIndex(c=>c.method==='POST'&&c.params.type==='STOP_MARKET'),cancelAt=after.findIndex(c=>c.method==='DELETE');
 assert.ok(placeAt>=0&&cancelAt>placeAt,'place new stop, then cancel old');assert.equal(after[placeAt].params.stopPrice,'100.02');assert.equal(after[placeAt].params.quantity,'0.12');
 assert.equal(after[cancelAt].params.orderId,oldStop);assert.equal(ex.store.records[0].breakevenMoved,true);
 amt='0';await ex.reconcile();assert.equal(ex.store.records[0].status,'CLOSED');
 assert.ok(m.calls.filter(c=>c.method==='DELETE').length>=3,'remaining protective/target orders cancelled');
 const g=mockGate({size:()=>0}),gx=new LiveExecutor({config:config(),clients:{GATEIO:g.client},now:()=>NOW});gx.arm();
 await gx.onSignal(row('GATEIO'),{signalKey:'b2'});await gx.reconcile();assert.equal(gx.store.records[0].status,'CLOSED');
 assert.ok(g.calls.some(c=>c.method==='DELETE'&&c.path.includes('/price_orders/')));
});

test('kill switch and records survive a restart; arming is never remembered',async()=>{
 const dir=tmp(),m=mockBingX();const a=new LiveExecutor({config:config(),clients:{BINGX:m.client},directory:dir,now:()=>NOW});
 a.arm();await a.onSignal(row(),{signalKey:'p1'});a.kill('TEST');
 const b=new LiveExecutor({config:config(),clients:{BINGX:m.client},directory:dir,now:()=>NOW});
 assert.equal(b.armed,false);assert.equal(b.store.killSwitch,true);assert.equal(b.store.records.length,1);
 assert.throws(()=>b.arm(),/KILL_SWITCH_ON/);b.resetKill();b.arm();assert.equal(b.armed,true);
 assert.throws(()=>new LiveExecutor({config:config({mode:'OFF'})}).arm(),/LIVE_MODE_OFF/);
 assert.throws(()=>new LiveExecutor({config:config({mode:'LIVE'})}).arm(),/LIVE_CONFIRM_MISSING/);
});

test('order builders: SHORT sides and trigger rules are mirrored',()=>{
 const qty={total:20,parts:[8,7,5]};
 const g=gateOrders({contract:'ETH_USDT',direction:'SHORT',stop:102,targets:[95,92,88],qty,clientOrderId:'x'});
 assert.equal(g.entry.size,-20);assert.equal(g.stop().trigger.rule,1);assert.equal(g.stop().order_type,'close-short-position');
 assert.deepEqual(g.targets.map(t=>[t.initial.size,t.trigger.rule]),[[8,2],[7,2],[5,2]]);
 const b=bingxOrders({symbol:'ETH-USDT',direction:'SHORT',stop:102,targets:[95,92,88],qty:{total:0.2,parts:[0.08,0.07,0.05]},clientOrderId:'x'});
 assert.equal(b.entry.side,'SELL');assert.ok(b.targets.every(t=>t.side==='BUY'));
});
