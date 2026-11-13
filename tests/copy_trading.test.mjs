import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseCopyMessage} from '../copy_parser.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {copyEventText} from '../copy_telegram.mjs';

const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05300 USDT\n손익　　🔴 -0.51 USDT`;
const CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';

test('parser: both formats, dash quantities, monitor restart',()=>{
 assert.deepEqual(parseCopyMessage(OPEN),{kind:'OPEN',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,entry:.05296,price:.051,quantity:880,marginUSD:9.01});
 assert.deepEqual(parseCopyMessage('포지션 진입\n코인: BTWUSDT\n방향: Long  레버리지: 6X\n진입가: 0.077940 USDT\n현재가: 0.078116 USDT\n수량: 200  마진: 2.61 USDT'),
  {kind:'OPEN',symbol:'BTWUSDT',direction:'LONG',leverage:6,entry:.07794,price:.078116,quantity:200,marginUSD:2.61});
 assert.deepEqual(parseCopyMessage(CHANGE(200,400)),{kind:'CHANGE',symbol:'TNSRUSDT',direction:'SHORT',price:.053,from:200,to:400});
 assert.equal(parseCopyMessage(CHANGE('0.07','-')).to,0);assert.equal(parseCopyMessage(CHANGE('-','0.07')).from,0);
 assert.equal(parseCopyMessage(CLOSE).theirPnlUSD,1.72);
 assert.equal(parseCopyMessage('Gate.io 모니터 시작 (실시간)').kind,'MONITOR_START');
 assert.equal(parseCopyMessage('에바참치 맛있다.'),null);
 assert.equal(parseCopyMessage('📌 포지션 진입\nMUSDT  🟢 Long  ×10\n진입가　0.7367 USDT\n수량　　21').symbol,'MUSDT');
});

function venue({free=500}={}){
 const calls=[];let size=0,avg=0,id=1,failStop=false,failMarket=false,unreal='-0.12';
 const client={
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',l});return {}},
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:String(avg),markPrice:'0.053',unrealizedProfit:unreal}]:[],
  placeOrder:async p=>{if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('rate'),{code:'HTTP_429'});if(failMarket&&p.type==='MARKET'&&p.reduceOnly)throw Object.assign(Error('rate'),{code:'HTTP_429'});calls.push({op:'order',...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);if(p.reduceOnly){size=Math.max(0,+(size-q).toFixed(6))}else{avg=size?(avg*size+0.053*q)/(size+q):0.051;size=+(size+q).toFixed(6)}}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,setSize:v=>{size=v},get size(){return size},set failStop(v){failStop=v},set failMarket(v){failMarket=v},set unreal(v){unreal=v}};
}
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
const make=(v,extra={})=>new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),...extra.config},client:v.client,contractOf:async()=>contract,
 balance:async()=>({equity:400,available:extra.free??300}),isBusy:extra.isBusy??(()=>false),gate:extra.gate??(()=>({ok:true})),now:()=>1e12});

test('copy: 1 $ margin at the trader leverage (capped by the venue), doubles with the trader, cuts in proportion, closes, protective stop each time',async()=>{
 const v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:OPEN});
 const open=v.calls.find(c=>c.op==='order'&&c.type==='MARKET');
 // 1 $ x 5x / 0.051 = 98 coins (step 1).
 assert.equal(open.side,'SELL');assert.equal(open.quantity,'98');assert.ok(v.calls.some(c=>c.op==='lev'&&c.l===5));
 const stop=v.calls.find(c=>c.type==='STOP_MARKET');assert.equal(stop.closePosition,'true');assert.equal(stop.side,'BUY');
 // 25 % of 400 = 100 $ over 98 coins above 0.051 -> about 1.071.
 assert.ok(Math.abs(Number(stop.stopPrice)-(0.051+100/98))<1e-4,stop.stopPrice);
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,192,'the trader added as much as its first buy: 1 $ more (5x at 0.053 = 94)');assert.ok(v.calls.some(c=>c.op==='cancel'),'old stop replaced');
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});
 assert.equal(v.size,48,'cut to a quarter');assert.equal(v.calls.filter(c=>c.reduceOnly==='true').length,1);
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});assert.equal(v.size,48,'same message id once');
 await ex.handle({id:4,date:1e12,text:CLOSE});
 assert.equal(v.size,0);const st=ex.status();assert.equal(st.positions.length,0);assert.equal(st.closed[0].closeReason,'TRADER_CLOSE');assert.equal(st.closed[0].theirPnlUSD,1.72);
 assert.equal(new Set(v.calls.filter(c=>c.clientOrderId).map(c=>c.clientOrderId)).size,v.calls.filter(c=>c.clientOrderId).length,'every order has its own client id');
});

test('copy: no entry right after a monitor restart, while disarmed, or on a symbol the signal strategy holds; add skipped without margin',async()=>{
 let v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:'Gate.io 모니터 시작'});await ex.handle({id:2,date:1e12+30000,text:OPEN});
 assert.equal(v.calls.filter(c=>c.op==='order').length,0);assert.equal(ex.status().events[0].reason,'MONITOR_RESTART_SNAPSHOT');
 v=venue();ex=make(v,{gate:()=>({ok:false,reason:'LIVE_DISARMED'})});await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.calls.length,0);
 v=venue();ex=make(v,{isBusy:()=>true});await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.calls.length,0);
 v=venue();ex=make(v,{free:.5});await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,98,'add needs about 1 $ of margin, 0.45 free');assert.equal(ex.status().events[0].type,'ADD_SKIPPED');
 assert.equal(ex.heldSymbols().has('TNSRUSDT'),true);
});

test('copy: the protective stop closing it is booked; an error is reported, not thrown; LIVE never copies',async()=>{
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);await ex.reconcile();
 assert.equal(ex.status().closed[0].closeReason,'STOP_OR_EXTERNAL');
 const bad=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:venue().client,contractOf:async()=>null,balance:async()=>null,now:()=>1});
 const r=await bad.handle({id:9,date:1,text:OPEN});assert.equal(r.reason,'NO_BINGX_CONTRACT');assert.equal(bad.status().events[0].type,'ERROR');
 assert.equal(copyConfig({},'LIVE').enabled,false);assert.equal(copyConfig({COPY_TRADING:'off'},'TESTNET').enabled,false);
});

test('copy: ledger survives a restart; notices read well',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-'));const v=venue();
 const a=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 await a.handle({id:1,date:1e12,text:OPEN});
 const b=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 assert.equal(b.status().positions.length,1);assert.equal((await b.handle({id:1,date:1e12,text:OPEN})).duplicate,true);
 assert.match(copyEventText({type:'OPENED',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,qty:98,avg:.051,stop:1.07}),/📋 카피 · TNSRUSDT 숏 5배 진입 \(테스트넷\)/);
 assert.match(copyEventText({type:'CLOSED',symbol:'TNSRUSDT',reason:'TRADER_CLOSE',netUSD:-.12,theirPnlUSD:1.72,adds:1}),/손익 −\$0\.12 .* 트레이더 \+\$1\.72/);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('copy review fixes: new stop before the old is cancelled; no stop at all -> closed; failed close retried; ledger loss limit; small cuts follow',async()=>{
 let v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 const iStop=v.calls.map((c,i)=>c.type==='STOP_MARKET'?i:-1).filter(i=>i>=0)[1],iCancel=v.calls.findIndex(c=>c.op==='cancel');
 assert.ok(iStop<iCancel,'new stop placed before the old one is cancelled');
 // The new stop fails after an add: the old stop stays, retried by the routine check.
 v.failStop=true;await ex.handle({id:3,date:1e12,text:CHANGE(1760,3520)});
 const p=ex.status().positions[0];assert.ok(p.stopOrderId,'old stop kept');assert.equal(p.stopStale,true);
 v.failStop=false;await ex.reconcile();assert.equal(ex.status().positions[0].stopStale,false);
 // A first stop that cannot be placed: the position is closed at market.
 v=venue();ex=make(v);v.failStop=true;await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'NO_STOP');
 // A close refused by the venue is retried.
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.failMarket=true;await ex.handle({id:2,date:1e12,text:CLOSE});
 assert.equal(v.size,98);assert.equal(ex.status().pending,1);v.failMarket=false;await ex.reconcile();assert.equal(v.size,0);assert.equal(ex.status().pending,0);
 // Ledger loss limit (user 2026-11-13: 50 %): -110 on 400 (27 %) keeps going, -210 (52 %) closes everything and stops new copies.
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.unreal='-110';await ex.reconcile();assert.equal(ex.status().killed,false);v.unreal='-210';await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().killed,true);await ex.handle({id:5,date:1e12,text:OPEN});assert.equal(v.size,0);
 ex.resume();assert.equal(ex.status().killed,false);
 // A 1-unit cut of a 3-unit position (trader 300 -> 200) is not lost to rounding down.
 v=venue();ex=make(v,{config:{marginUSD:.03}});await ex.handle({id:1,date:1e12,text:OPEN});
 const before=v.size;await ex.handle({id:2,date:1e12,text:CHANGE(300,200)});assert.equal(before-v.size,Math.round(before/3));
});

test('copy: a venue that refuses a second close-position stop gets the swap the other way round',async()=>{
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const place=v.client.placeOrder;let stops=0;
 v.client.placeOrder=async p=>{if(p.type==='STOP_MARKET'&&++stops===1)throw Object.assign(Error('exists'),{code:'VENUE_ERROR_101400'});return place(p)};
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 const p=ex.status().positions[0];assert.equal(p.stopStale,false);assert.ok(p.stopOrderId);assert.equal(v.size,192);
});

test('copy (user 2026-11-13): first buy 1 $, a later 진입 card of 0.4 = 1 $, 0.8 = 2 $; the same card twice is one buy; a 청산 card with a quantity closes that share',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});const first=v.size;
 assert.equal(first,100,'1 $ x 5 / 0.05');
 await ex.handle({id:2,date:1e12+1000,text:card(0.4,'0.05000')});assert.equal(v.size,100,'same card again (same entry within 3 min): not a buy');
 await ex.handle({id:3,date:1e12+600000,text:card(0.4,'0.05100')});assert.equal(v.size,200,'0.4 more = 1 $ more');
 await ex.handle({id:4,date:1e12+900000,text:card(0.8,'0.05200')});assert.equal(v.size,400,'0.8 more = 2 $ more');
 // The trader holds 1.6; a 청산 card of 0.4 closes a quarter of ours.
 await ex.handle({id:5,date:1e12+990000,text:'✅ 포지션 청산\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short\n━━━━━━━━━━━━━━━━\n진입가 0.05000 USDT\n수량 0.4\n최종손익 🟢 +0.3 USDT'});
 assert.equal(v.size,300,'a quarter closed');assert.equal(ex.status().positions.length,1);
 await ex.handle({id:6,date:1e12+999000,text:CLOSE});assert.equal(v.size,0);
 assert.equal(ex.status().events.find(e=>e.type==='ADDED').marginUSD,2);
});

test('copy exit at a volume zone at least 20 % away, only when a 15m candle closes beyond it on 1.5x volume; exchange stop = balance cap; at most 10 adds',async()=>{
 const zones=[{priceLow:.0515,priceHigh:.0518},{priceLow:.0560,priceHigh:.0570},{priceLow:.0630,priceHigh:.0640}];
 let candles=[];const v=venue();
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,zonesOf:async()=>zones,candlesOf:async()=>candles,
  balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // Short at 0.051: 0.0518 (1.6 %) and 0.0570 (11.8 %) are where the trader adds; 0.0640 (25 %) is the exit zone.
 assert.deepEqual(ex.zoneStop({direction:'SHORT',entry:.051,zones}).zone,{priceLow:.063,priceHigh:.064});
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.status().positions[0];assert.equal(p.stopSource,'BALANCE_CAP');assert.ok(Math.abs(p.stopDistPct-25.5)<.2,p.stopDistPct);
 const bar=(i,c,vol)=>[1e12-(30-i)*900000,c,c,c,c,vol,1e12-(30-i)*900000+899999];
 // Beyond the zone on ordinary volume: kept.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,120)];await ex.reconcile();assert.equal(v.size,98);
 // Beyond the zone on 2x volume: closed.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,200)];await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'ZONE_BREAK_VOLUME');
 // At most 10 adds.
 const v2=venue(),ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_MAX_TOTAL_MARGIN_PCT:'100'},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:400}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:OPEN});let q=880;
 for(let k=0;k<12;k++){await ex2.handle({id:10+k,date:1e12,text:CHANGE(q,q+880)});q+=880}
 assert.equal(ex2.status().positions[0].adds,10);assert.ok(ex2.status().events.some(e=>e.reason==='COPY_MAX_ADDS'));
});

test('copy review: the trader total follows the trader even when our buy is skipped; a failed partial close retries the same share; "- → q" positions keep their scale',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const closeQ=q=>`✅ 포지션 청산\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short\n━━━━━━━━━━━━━━━━\n진입가 0.05000 USDT\n수량 ${q}\n최종손익 🟢 +0.3 USDT`;
 let v=venue(),ex=make(v,{free:.5});
 await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(0.4,'0.05100')});
 assert.equal(v.size,100,'add skipped (margin)');assert.equal(ex.status().positions[0].theirTotal,.8,'trader total still 0.8');
 await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,50,'half of ours, not all');
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(1.2,'0.05100')});
 assert.equal(v.size,400);v.failMarket=true;await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,400);
 v.failMarket=false;await ex.reconcile();assert.equal(v.size,300,'a quarter, once');await ex.reconcile();assert.equal(v.size,300);
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:CHANGE('-','880')});
 assert.equal(ex.status().positions[0].theirFirstQty,880);
});

test('copy default (user 2026-11-13): the trader quantity x our equity / 20,000 $, no 1 $ floor; each cut has its own order id',async()=>{
 assert.equal(copyConfig({},'TESTNET').sizing,'BALANCE_RATIO');
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue();const ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 880 x 400 / 20,000 = 17.6 -> 17 coins (0.87 $ of notional... venue minimum 2 $ -> raised to the minimum).
 await ex.handle({id:1,date:1e12,text:card(5000,'0.05000')});
 assert.equal(v.size,100,'5,000 x 0.02 = 100 coins');assert.equal(ex.status().positions[0].scale,.02);
 await ex.handle({id:2,date:1e12+600000,text:card(2500,'0.05100')});assert.equal(v.size,150,'2,500 more x 0.02 = 50');
 await ex.handle({id:3,date:1e12+700000,text:CHANGE(7500,5000)});await ex.handle({id:4,date:1e12+800000,text:CHANGE(5000,2500)});
 assert.equal(v.size,50);
 const cuts=v.calls.filter(c=>c.reduceOnly==='true').map(c=>c.clientOrderId);assert.equal(cuts.length,2);assert.notEqual(cuts[0],cuts[1]);
 assert.equal(ex.status().positions[0].reduces,2);
 // Tiny trader order: below the venue minimum -> the minimum, flagged.
 const v2=venue();const ex2=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:card(100,'0.05000')});assert.equal(ex2.status().positions[0].minOrder,true);
});

test('copy: a card whose quantity does not match its margin x leverage is not traded; first entries respect the total margin cap; small adds are carried',async()=>{
 const v=venue(),ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 880 coins x 0.051 = 44.9 $ but 마진 9.01 x 5 = 45 $: coins. 88 "contracts" with the same margin would not match.
 const bad=OPEN.replace('수량　　880','수량　　88');
 assert.equal((await ex.handle({id:1,date:1e12,text:bad})).reason,'QUANTITY_UNIT_UNCLEAR');assert.equal(v.size,0);
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 // 30 % of 400 = 120 $ of margin: 1,000,000 coins x 0.02 = 20,000 coins = 1,000 $ notional / 5 = 200 $ -> skipped.
 assert.equal((await ex.handle({id:2,date:1e12,text:card(1000000,'0.05000')})).reason,'COPY_MARGIN_CAP');
 await ex.handle({id:3,date:1e12,text:card(5000,'0.05000')});assert.equal(v.size,100);
 // 1,000 more x 0.02 = 20 coins = 1 $ < 2 $ venue minimum: carried; the next 1,000 makes 40 coins = 2 $: bought together.
 await ex.handle({id:4,date:1e12+600000,text:card(1000,'0.05100')});assert.equal(v.size,100);
 await ex.handle({id:5,date:1e12+700000,text:card(1000,'0.05200')});assert.equal(v.size,140,'carried adds bought together');
 await ex.handle({id:6,date:1e12+800000,text:card(1000,'0.05300')});assert.equal(v.size,140,'the next small one carried again');
});
