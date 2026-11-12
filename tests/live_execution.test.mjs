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
function mockBingX({margin='ISOLATED',maxLev=50,marginFail=false,hedge=false,entry='ok',stopAttached=true,positionAmt=()=>'0.20',stopPlacement='ok'}={}){
 const calls=[],orders=[];let id=1000;
 const fetcher=async(url,options)=>{
  const u=new URL(url),q=Object.fromEntries([...u.searchParams].filter(([k])=>k!=='signature'));
  assert.equal(u.origin,LIVE_HOSTS.BINGX.TESTNET);assert.equal(options.headers['X-BX-APIKEY'],'bingx-key');
  assert.equal(u.searchParams.get('signature'),createHmac('sha256',BINGX_SECRET).update(Object.keys(q).sort().map(k=>`${k}=${q[k]}`).join('&')).digest('hex'),'BingX signature');
  assert.ok(!url.includes(BINGX_SECRET));
  const call={method:options.method,path:u.pathname,params:q};calls.push(call);
  if(u.pathname==='/openApi/swap/v3/user/balance')return json({code:0,data:[{asset:'USDT',balance:'1000',equity:'1000',availableMargin:'1000'}]});
  if(u.pathname==='/openApi/swap/v2/trade/marginType'&&options.method==='GET')return json({code:0,data:{marginType:margin}});
  if(u.pathname==='/openApi/swap/v2/trade/marginType'&&options.method==='POST'){if(marginFail)return json({code:80001,msg:'position exists'});margin=q.marginType;return json({code:0,data:{}})}
  if(u.pathname==='/openApi/swap/v2/trade/leverage'&&options.method==='GET')return json({code:0,data:{longLeverage:5,shortLeverage:5,maxLongLeverage:maxLev,maxShortLeverage:maxLev}});
  if(u.pathname==='/openApi/swap/v2/trade/leverage'&&options.method==='POST')return json({code:0,data:{symbol:q.symbol,leverage:Number(q.leverage)}});
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
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='DELETE'&&globalThis.__bingxAutoCancel)return json({code:109400,msg:'order not exist'});
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='DELETE'){const i=orders.findIndex(o=>o.orderID===q.orderId);if(i>=0)orders.splice(i,1);return json({code:0,data:{order:{orderID:q.orderId}}})}
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
  if(u.pathname==='/api/v4/futures/usdt/accounts')return json({in_dual_mode:dual,available:'1000',total:'1000'});
  if(u.pathname.startsWith('/api/v4/futures/usdt/orders/')&&options.method==='DELETE')return json({id:u.pathname.split('/').pop(),status:'finished'});
  if(u.pathname==='/api/v4/futures/usdt/orders'&&options.method==='POST'){
   if(call.body.close)return json({id:++id,size:0,left:0,finish_as:'filled'});
   if(call.body.tif==='gtc')return json({id:++id,size:call.body.size,left:call.body.size,status:'open'});
   return json({id:++id,size:call.body.size,left:call.body.size-Math.sign(call.body.size)*fill,fill_price:'100.01',finish_as:fill?'filled':'ioc'});
  }
  if(u.pathname==='/api/v4/futures/usdt/price_orders'&&options.method==='POST'){
   if(stop==='fail'&&call.body.order_type.startsWith('close-'))return json({label:'INVALID_PARAM_VALUE'},400);
   return json({id:++id});
  }
  if(u.pathname.startsWith('/api/v4/futures/usdt/price_orders/')&&options.method==='DELETE')return json({id:1});
  if(u.pathname.endsWith('/leverage')&&options.method==='POST'){const lev=u.searchParams.get('leverage'),lim=Number(u.searchParams.get('cross_leverage_limit'));calls.at(-1).query={leverage:lev,cross_leverage_limit:lim};return json({contract:'ETH_USDT',leverage:lev,cross_leverage_limit:String(Math.min(lim,25))})}
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
 assert.deepEqual(liveConfig({}),{mode:'OFF',liveConfirmed:false,venues:['BINGX'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:4,maxPerDirection:2,sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:7,dailyMaxLossPct:60,balanceCapUSD:0});
 assert.equal(liveConfig({HOURLY_MAX_ADDS:'10'}).maxAdds,10);
 for(const bad of ['','abc'])assert.equal(liveConfig({HOURLY_MAX_ADDS:bad}).maxAdds,7,'garbage falls back to 7, not 10');
 assert.equal(liveConfig({LIVE_BALANCE_CAP_USD:'400'}).balanceCapUSD,400);
 assert.equal(liveConfig({LIVE_SIZING:'risk_usd'}).sizing,'RISK_USD');
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
  [{config:config({maxOpen:4,maxPerDirection:2}),records:[{status:'OPEN',symbol:'A',direction:'LONG'},{status:'OPEN',symbol:'B',direction:'LONG'}]},'MAX_SAME_DIRECTION_POSITIONS'],
  [{records:[{status:'CLOSED',day:'2026-11-10',plannedRiskUSD:5}]},'DAILY_RISK_LIMIT'],
  [{row:row('GATEIO',{venueContract:{...row('GATEIO').venueContract,decimalSizes:true}})},'GATEIO_DECIMAL_SIZE_UNVERIFIED'],
  [{config:config({mode:'LIVE',liveConfirmed:true}),row:row('BINGX',{venueOnly:true})},'VENUE_ONLY_TESTNET_ONLY']];
 assert.equal(preflight({...base,row:row('BINGX',{venueOnly:true})}).reasons.includes('VENUE_ONLY_TESTNET_ONLY'),false,'testnet may trade coins not on Binance');
 for(const [patch,reason] of cases)assert.ok(preflight({...base,...patch}).reasons.includes(reason),reason);
 const whole=preflight({...base,config:config({venues:['BINGX','GATEIO']}),row:row('GATEIO',{venueContract:{...row('GATEIO').venueContract,decimalSizes:true,decimalStepFallback:true,contractStep:'1'}})});
 assert.ok(!whole.reasons.includes('GATEIO_DECIMAL_SIZE_UNVERIFIED'),'whole contracts on a decimal contract are allowed');
});

test('BingX: entry carries the stop, three reduce-only targets follow, a repeated signal is never resent',async()=>{
 const m=mockBingX(),dir=tmp(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},directory:dir,now:()=>NOW});
 assert.equal((await ex.onSignal(row(),{signalKey:'k1'})).reasons[0],'NOT_ARMED');assert.equal(m.calls.length,0,'nothing is sent before arming');
 ex.arm();const result=await ex.onSignal(row(),{signalKey:'k1'});assert.equal(result.status,'OPEN');
 const posts=m.calls.filter(c=>c.method==='POST'&&c.path==='/openApi/swap/v2/trade/order').map(c=>c.params);
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
 assert.equal(timeout.calls.filter(x=>x.method==='POST'&&x.path==='/openApi/swap/v2/trade/order').length,1,'the entry is sent once');
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
 const posts=m.calls.filter(c=>c.method==='POST'&&!c.path.endsWith('/leverage')).map(c=>c.body);
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

test('manual levels: new stop before old cancel, wider stop capped by the risk limit, targets replaced after cancel',async()=>{
 const m=mockBingX(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row(),{signalKey:'m1'});const rec=ex.store.records[0],oldStop=rec.stopOrderId,oldTp2=rec.targetOrderIds[1];
 assert.deepEqual(await ex.setLevels('other',{stop:99}),{ok:true,live:false},'no live record: paper only');
 const wide=await ex.setLevels('m1',{stop:97,targets:rec.targets});assert.equal(wide.ok,false);assert.deepEqual(wide.reasons,['MANUAL_STOP_EXCEEDS_RISK_LIMIT']);
 assert.equal(rec.stopOrderId,oldStop,'refused change leaves the venue untouched');
 const before=m.calls.length;const r=await ex.setLevels('m1',{stop:99,targets:[105,109,112]});assert.equal(r.ok,true);assert.equal(r.stopMoved,true);assert.deepEqual(r.targetsMoved,[2]);
 const after=m.calls.slice(before),place=after.findIndex(c=>c.method==='POST'&&c.params.type==='STOP_MARKET'),cancel=after.findIndex(c=>c.method==='DELETE'&&c.params.orderId===oldStop);
 assert.ok(place>=0&&cancel>place,'new stop first');assert.equal(after[place].params.stopPrice,'99');assert.equal(after[place].params.quantity,'0.2');
 const tpCancel=after.findIndex(c=>c.method==='DELETE'&&c.params.orderId===oldTp2),tpPlace=after.findIndex(c=>c.method==='POST'&&c.params.type==='TAKE_PROFIT_MARKET');
 assert.ok(tpCancel>=0&&tpPlace>tpCancel,'old target cancelled before the new one');assert.equal(after[tpPlace].params.stopPrice,'109');assert.equal(after[tpPlace].params.quantity,'0.07');
 assert.equal(rec.stop,99);assert.deepEqual(rec.targets,[105,109,112]);
 // A stop already past the entry is not pulled back by the automatic break-even step.
 await ex.setLevels('m1',{stop:101,targets:rec.targets});
 const g=mockGate(),gx=new LiveExecutor({config:config(),clients:{GATEIO:g.client},now:()=>NOW});gx.arm();
 await gx.onSignal(row('GATEIO'),{signalKey:'m2'});const n=g.calls.length;
 const gr=await gx.setLevels('m2',{stop:99,targets:[106,108,112]});assert.equal(gr.ok,true);
 const ga=g.calls.slice(n),gStop=ga.findIndex(c=>c.method==='POST'&&c.body?.order_type==='close-long-position'),gDel=ga.findIndex(c=>c.method==='DELETE');
 assert.ok(gStop>=0&&gDel>gStop);assert.equal(ga[gStop].body.trigger.price,'99');
 const gTp=ga.find(c=>c.method==='POST'&&c.body?.order_type==='plan-close-long-position');assert.equal(gTp.body.trigger.price,'106');assert.equal(gTp.body.initial.size,-8);
});

test('reconcile keeps a manual stop that is already better than break-even',async()=>{
 let amt='0.20';const m=mockBingX({positionAmt:()=>amt}),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row(),{signalKey:'m3'});await ex.setLevels('m3',{stop:101,targets:[105,108,112]});
 amt='0.12';const before=m.calls.length;await ex.reconcile();
 assert.ok(!m.calls.slice(before).some(c=>c.method==='POST'),'no break-even stop placed');assert.equal(ex.store.records[0].stop,101);assert.equal(ex.store.records[0].breakevenMoved,true);
});

test('cross margin and leverage are set and confirmed before every live entry; a failure sends no entry',async()=>{
 const m=mockBingX(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row('BINGX',{score:95,marketCap:3e8}),{signalKey:'c1'});
 const r=ex.store.records[0];assert.equal(r.status,'OPEN');assert.equal(r.marginMode,'CROSS');assert.equal(r.leverage,18);
 const seq=m.calls.filter(c=>c.method==='POST').map(c=>c.path);
 assert.deepEqual(seq.slice(0,3),['/openApi/swap/v2/trade/marginType','/openApi/swap/v2/trade/leverage','/openApi/swap/v2/trade/order'],'margin, leverage, then entry');
 assert.equal(m.calls.find(c=>c.method==='POST'&&c.path.endsWith('/marginType')).params.marginType,'CROSSED');
 const lev=m.calls.find(c=>c.method==='POST'&&c.path.endsWith('/leverage')).params;assert.deepEqual([lev.side,lev.leverage],['BOTH','18']);
 // Venue maximum below the wanted leverage: capped, recorded.
 const capped=mockBingX({maxLev:15}),c=new LiveExecutor({config:config(),clients:{BINGX:capped.client},now:()=>NOW});c.arm();
 await c.onSignal(row('BINGX',{leverage:28}),{signalKey:'c2'});assert.equal(c.store.records[0].leverage,15);
 // Already cross: no switch request.
 const already=mockBingX({margin:'CROSSED'}),a=new LiveExecutor({config:config(),clients:{BINGX:already.client},now:()=>NOW});a.arm();
 await a.onSignal(row(),{signalKey:'c3'});assert.ok(!already.calls.some(x=>x.method==='POST'&&x.path.endsWith('/marginType')));
 // Switch refused: no entry is sent.
 const bad=mockBingX({marginFail:true}),b=new LiveExecutor({config:config(),clients:{BINGX:bad.client},now:()=>NOW});b.arm();
 await b.onSignal(row(),{signalKey:'c4'});assert.equal(b.store.records[0].status,'FAILED');
 assert.ok(!bad.calls.some(x=>x.path==='/openApi/swap/v2/trade/order'),'no order without cross margin');
 // Gate.io: leverage=0 (cross) with cross_leverage_limit, before the entry; venue cap read back.
 const g=mockGate(),gx=new LiveExecutor({config:config(),clients:{GATEIO:g.client},now:()=>NOW});gx.arm();
 await gx.onSignal(row('GATEIO',{leverage:28}),{signalKey:'c5'});
 const gp=g.calls.filter(x=>x.method==='POST');assert.ok(gp[0].path.endsWith('/positions/ETH_USDT/leverage'));
 assert.deepEqual(gp[0].query,{leverage:'0',cross_leverage_limit:28});assert.equal(gx.store.records[0].leverage,25);assert.equal(gx.store.records[0].status,'OPEN');
});

test('balance sizing: the account balance sets the unit; adds 1, 2, 4 ... rest at zones, one whole-position stop, resized targets',async()=>{
 const zones=[97,94,91,88,85,82].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
 const split=row('BINGX',{entry:100,score:95,marketCap:3e8,paperAddInputs:{atr:1,takerRate:.0005,zoneSets:[{label:'15분봉 3일',zones}]}});
 let amt='0.34';const m=mockBingX({positionAmt:()=>amt});
 const ex=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60}),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(split,{signalKey:'b1'});
 const r=ex.store.records[0];assert.equal(r.status,'OPEN',JSON.stringify(r.events));assert.equal(r.balanceUSD,1000);assert.equal(r.leverage,18);
 // 1000 x 0.19% x 18 = 34.2 USDT at 100 -> 0.34 ETH on the 0.01 grid.
 assert.equal(r.quantity.total,0.34);assert.deepEqual(r.quantity.parts,[0.13,0.11,0.1]);
 assert.ok(r.adds.length>=1&&r.adds.length<=10);assert.deepEqual(r.adds.slice(0,3).map(a=>a.qty),[0.34,0.68,1.36],'adds of 1, 2, 4 units');
 assert.ok(r.stop<r.adds.at(-1).price,'stop beyond the last add');
 const orders=m.calls.filter(c=>c.method==='POST'&&c.path==='/openApi/swap/v2/trade/order').map(c=>c.params);
 const whole=orders.find(o=>o.closePosition==='true');assert.equal(whole.type,'STOP_MARKET');assert.equal(Number(whole.stopPrice),r.stop);
 const limits=orders.filter(o=>o.type==='LIMIT');assert.equal(limits.length,r.adds.length);assert.ok(limits.every(o=>o.side==='BUY'&&o.timeInForce==='GTC'&&!o.reduceOnly));
 assert.ok(r.adds.every(a=>a.orderId));
 // First add fills: targets are resized to the whole position (0.68).
 amt='0.68';await ex.reconcile();assert.equal(r.filledAdds,1);assert.equal(r.peakSize,0.68);assert.deepEqual(r.targetParts,[0.27,0.23,0.18]);
 // TP1 fills: the resting adds are cancelled.
 amt='0.41';await ex.reconcile();assert.ok(r.adds.slice(1).every(a=>a.cancelled));
 // Daily limit is a share of the balance, not a fixed dollar amount.
 assert.ok(!ex.store.skipped.some(x=>x.reasons?.includes('DAILY_RISK_LIMIT')));
 // Gate.io: contracts, GTC adds, flat position cancels what is still resting.
 let size=34;const g=mockGate({size:()=>size,fill:34});
 const gx=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60}),clients:{GATEIO:g.client},now:()=>NOW});gx.arm();
 await gx.onSignal(row('GATEIO',{entry:100,score:95,marketCap:3e8,paperAddInputs:split.paperAddInputs}),{signalKey:'b2'});
 const gr=gx.store.records[0];assert.equal(gr.status,'OPEN',JSON.stringify(gr.events));assert.equal(gr.quantity.total,34);assert.deepEqual(gr.adds.slice(0,2).map(a=>a.qty),[34,68]);
 assert.ok(g.calls.filter(c=>c.method==='POST'&&c.body?.tif==='gtc').every(c=>c.body.size>0&&c.body.text.length<=28));
 size=0;await gx.reconcile();assert.equal(gr.status,'CLOSED');assert.ok(gr.adds.every(a=>a.cancelled));
 assert.ok(g.calls.some(c=>c.method==='DELETE'&&c.path.startsWith('/api/v4/futures/usdt/orders/')),'resting adds cancelled');
});

test('an add that fills after the position went flat is closed at market and trading stops',async()=>{
 const zones=[97,94,91].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
 const sizes=[0,34];let size=()=>34;const g=mockGate({size:()=>size(),fill:34});
 const gx=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60}),clients:{GATEIO:g.client},now:()=>NOW});gx.arm();
 await gx.onSignal(row('GATEIO',{entry:100,score:95,marketCap:3e8,paperAddInputs:{atr:1,takerRate:.0005,zoneSets:[{label:'15분봉 3일',zones}]}}),{signalKey:'late'});
 assert.equal(gx.store.records[0].status,'OPEN');
 size=()=>sizes.shift()??0; // flat on the first look, 34 contracts again right after the cancel
 await gx.reconcile();const r=gx.store.records[0];
 assert.equal(r.status,'CLOSED');assert.equal(r.closeReason,'LATE_ADD_AFTER_FLAT');assert.equal(gx.store.killSwitch,true);
 assert.ok(g.calls.some(c=>c.method==='POST'&&c.body?.close===true&&c.path.endsWith('/orders')),'market close sent');
});

test('LIVE_BALANCE_CAP_USD: a 100,000 virtual USDT testnet is sized like a $400 account',async()=>{
 const zones=[97,94,91].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
 const m=mockBingX();
 const ex=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60,balanceCapUSD:400}),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row('BINGX',{entry:100,score:95,marketCap:3e8,paperAddInputs:{atr:1,takerRate:.0005,zoneSets:[{label:'15분봉 3일',zones}]}}),{signalKey:'cap'});
 const r=ex.store.records[0];assert.equal(r.balanceUSD,400);assert.equal(r.quantity.total,0.13,'400 x 0.19% x 18 = 13.68 USDT -> 0.13 ETH');
});

test('a signal routed from Gate.io is ordered on BingX with BingX symbol and grid, and recorded as routed',async()=>{
 const {routeLiveSignal}=await import('../venue_execution.mjs');
 const gate=row('GATEIO');const bingx=row('BINGX');
 const routed=routeLiveSignal({...gate,targetPlan:{quantity:.6,costAssumptions:{takerRate:.0005,makerRate:.0002,slippageBps:2,spreadBps:2,fundingRate:0}},entry:100,rawStop:97.987,stop:97.95,targets:[105.057,108.003,112.009],
  liveAlternatives:[{venue:'BINGX',venueSymbol:'ETH-USDT',entryBasis:100.01,quantity:0.6,estimatedStopLossUSD:6,spreadBps:2,quotedAt:NOW,venueContract:bingx.venueContract}]},{enabled:['BINGX'],credentials:{BINGX:true},now:NOW});
 const m=mockBingX(),ex=new LiveExecutor({config:config({venues:['BINGX']}),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(routed,{signalKey:'route1'});
 const r=ex.store.records[0];assert.equal(r.status,'OPEN',JSON.stringify(r.events));assert.equal(r.venue,'BINGX');assert.equal(r.venueSymbol,'ETH-USDT');assert.equal(r.routedFrom,'GATEIO');
 const entry=m.calls.find(c=>c.method==='POST'&&c.path==='/openApi/swap/v2/trade/order').params;assert.equal(entry.symbol,'ETH-USDT');
 assert.equal(JSON.parse(entry.stopLoss).stopPrice,97.98);assert.deepEqual(r.targets,[105.05,108,112]);
});

test('manual levels on a live record are put on its venue grid; NaN fields are left alone',async()=>{
 const m=mockBingX(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 await ex.onSignal(row('BINGX'),{signalKey:'lv'});const r=ex.store.records[0];assert.equal(r.status,'OPEN');
 const before=m.calls.length;
 const res=await ex.setLevels('lv',{stop:NaN,targets:[NaN,NaN,113.017]});
 assert.equal(res.ok,true);assert.equal(res.stopMoved,false,'stop untouched');assert.deepEqual(res.targetsMoved,[3]);
 assert.equal(r.targets[2],113.01,'target toward the entry on the 0.01 grid');assert.equal(r.targets[0],105);
 const placed=m.calls.slice(before).filter(c=>c.method==='POST').map(c=>c.params);assert.equal(placed.length,1);assert.equal(placed[0].stopPrice,'113.01');
});

test('testnet round trip: same order path, then everything cancelled and closed; only on TESTNET; left out of daily risk',async()=>{
 let amt='0.20';const m=mockBingX({positionAmt:()=>amt});
 const ex=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60}),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 const zones=[97,95,93].map(p=>({priceLow:p-.1,priceHigh:p+.1}));
 const testRow=row('BINGX',{entry:100,leverage:10,stop:99,targets:[101.5,102,103],paperAddInputs:{zoneSets:[{label:'시험',zones}],atr:.4,takerRate:.0005}});
 const res=await ex.testRoundTrip(testRow,{holdMs:0,sleep:async()=>{amt='0'},maxBalanceUSD:1000});
 assert.equal(res.ok,true,JSON.stringify(res.events));assert.equal(res.status,'CLOSED');assert.ok(res.adds>=1);
 const types=res.events.map(e=>e.type);for(const t of ['MARGIN_SET','ENTRY_SENT','PROTECTED','ADDS_PLACED','ADDS_CANCELLED','TEST_CLOSED'])assert.ok(types.includes(t),t);
 assert.equal(ex.store.records[0].test,true);assert.equal(ex.store.killSwitch,false);
 // Position still there after the close order: stop trading.
 let amt2='0.2';const m2=mockBingX({positionAmt:()=>amt2}),ex2=new LiveExecutor({config:config(),clients:{BINGX:m2.client},now:()=>NOW});ex2.arm();
 const bad=await ex2.testRoundTrip(row('BINGX'),{holdMs:0,sleep:async()=>{}});
 assert.ok(bad.events.some(e=>e.type==='TEST_CLOSE_INCOMPLETE'));
 assert.ok(!m2.calls.some(c=>c.method==='DELETE'),'stop and targets stay while the position is open');assert.equal(bad.ok,false);assert.equal(ex2.store.killSwitch,true);
 await assert.rejects(new LiveExecutor({config:config({mode:'LIVE',liveConfirmed:true}),clients:{BINGX:m.client},now:()=>NOW}).testRoundTrip(row('BINGX')),/TEST_TESTNET_ONLY/);
});

test('a signal offered on every tick is ordered once, and a refused one is listed once',async()=>{
 const m=mockBingX(),ex=new LiveExecutor({config:config(),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 const [a,b]=await Promise.all([ex.onSignal(row(),{signalKey:'tick'}),ex.onSignal(row(),{signalKey:'tick'})]);
 assert.deepEqual([a.sent,b.sent].sort(),[false,true]);assert.equal(ex.store.records.length,1);assert.equal(ex.hasSignal('tick'),true);
 assert.equal(m.calls.filter(c=>c.method==='POST'&&c.path==='/openApi/swap/v2/trade/order'&&c.params.type==='MARKET').length,1,'one entry order');
 const blocked=new LiveExecutor({config:config({venues:['GATEIO']}),clients:{BINGX:m.client},now:()=>NOW});blocked.arm();
 for(let i=0;i<5;i++)await blocked.onSignal(row(),{signalKey:'again'});
 assert.equal(blocked.store.skipped.length,1,'same reasons listed once');
});

test('a skipped signal is retried at most every 30 s (no balance read on every tick); arming retries at once',async()=>{
 let now=NOW;const m=mockBingX(),ex=new LiveExecutor({config:config({maxOpen:1}),clients:{BINGX:m.client},now:()=>now});ex.arm();
 const blocked=row('BINGX',{decision:{ready:false}});
 assert.equal((await ex.onSignal(blocked,{signalKey:'w1'})).reasons.includes('SIGNAL_NOT_READY'),true);
 now+=5000;assert.deepEqual((await ex.onSignal(row('BINGX'),{signalKey:'w1'})).reasons,['RETRY_WAIT']);
 ex.arm();assert.equal((await ex.onSignal(row('BINGX'),{signalKey:'w1'})).status,'OPEN','arming clears the wait');
 now+=1000;assert.deepEqual((await ex.onSignal(row('BINGX'),{signalKey:'w1'})).reasons,['DUPLICATE_SIGNAL']);
});

test('a record left SUBMITTING by a restart becomes UNKNOWN and blocks new entries',async()=>{
 const dir=tmp(),m=mockBingX();const a=new LiveExecutor({config:config(),clients:{BINGX:m.client},directory:dir,now:()=>NOW});a.arm();
 await a.onSignal(row('BINGX'),{signalKey:'s1'});
 const file=path.join(dir,'live-orders.json'),stored=JSON.parse(fs.readFileSync(file,'utf8'));stored.records[0].status='SUBMITTING';fs.writeFileSync(file,JSON.stringify(stored));
 const b=new LiveExecutor({config:config({maxOpen:4}),clients:{BINGX:m.client},directory:dir,now:()=>NOW});b.arm();
 assert.equal(b.store.records[0].status,'UNKNOWN');assert.equal(b.canTry('x'),true);
 assert.ok((await b.onSignal(row('BINGX',{symbol:'SOLUSDT'}),{signalKey:'s2'})).reasons.includes('UNRESOLVED_ORDER_STATE'));
});

test('BingX removes stop/targets itself on a flat position: a failed cancel of an order no longer open is not a failure',async()=>{
 let amt='0.20';const m=mockBingX({positionAmt:()=>amt});
 const ex=new LiveExecutor({config:config({sizing:'BALANCE',unitPct:.19,maxLossPct:30,maxAdds:10,dailyMaxLossPct:60}),clients:{BINGX:m.client},now:()=>NOW});ex.arm();
 const testRow=row('BINGX',{entry:100,leverage:10,stop:99,targets:[101.5,102,103],paperAddInputs:null});
 globalThis.__bingxAutoCancel=true;
 try{
  const res=await ex.testRoundTrip(testRow,{holdMs:0,sleep:async()=>{amt='0';m.orders.length=0},maxBalanceUSD:1000});
  const types=res.events.map(e=>e.type);
  assert.equal(res.ok,true,JSON.stringify(res.events));assert.ok(types.includes('ORDER_ALREADY_GONE'));assert.equal(types.includes('CANCEL_FAILED'),false);
 }finally{delete globalThis.__bingxAutoCancel}
});
