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
  placeOrder:async p=>{if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('rate'),{code:failStop===true?'HTTP_429':failStop});if(failMarket&&p.type==='MARKET'&&p.reduceOnly)throw Object.assign(Error('rate'),{code:'HTTP_429'});calls.push({op:'order',...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);if(p.reduceOnly){size=Math.max(0,+(size-q).toFixed(6))}else{avg=size?(avg*size+0.053*q)/(size+q):0.051;size=+(size+q).toFixed(6)}}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,setSize:v=>{size=v},get size(){return size},set failStop(v){failStop=v},set failMarket(v){failMarket=v},set unreal(v){unreal=v}};
}
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
const make=(v,extra={})=>new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),...extra.config},client:v.client,contractOf:async()=>contract,
 balance:async()=>({equity:400,available:typeof extra.free==='function'?extra.free():extra.free??300}),isBusy:extra.isBusy??(()=>false),gate:extra.gate??(()=>({ok:true})),now:()=>1e12});

test('copy: 1 $ margin at the trader leverage (capped by the venue), doubles with the trader, cuts in proportion, closes, protective stop each time',async()=>{
 const v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:OPEN});
 const open=v.calls.find(c=>c.op==='order'&&c.type==='MARKET');
 // 1 $ x 5x / 0.051 = 98 coins (step 1).
 assert.equal(open.side,'SELL');assert.equal(open.quantity,'98');assert.ok(v.calls.some(c=>c.op==='lev'&&c.l===5));
 const stop=v.calls.find(c=>c.type==='STOP_MARKET');assert.equal(stop.closePosition,'true');assert.equal(stop.side,'BUY');
 // The balance cap (25 % of 400 over 98 coins) would be 20x the price away: the 50 % backstop instead, with the quantity.
 assert.ok(Math.abs(Number(stop.stopPrice)-0.051*1.5)<1e-4,stop.stopPrice);assert.equal(stop.quantity,'98');
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
 v=venue();{let n=0;ex=make(v,{free:()=>n++<1?300:.5})}await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,98,'add needs about 1 $ of margin, 0.45 free');assert.equal(ex.status().events[0].type,'ADD_SKIPPED');
 assert.equal(ex.heldSymbols().has('TNSRUSDT'),true);
});

test('copy: the protective stop closing it is booked; an error is reported, not thrown; LIVE never copies',async()=>{
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);await ex.reconcile();
 // One empty answer does not close the ledger; the second in a row does.
 assert.equal(ex.status().closed.length,0);assert.equal(ex.status().positions.length,1);
 await ex.reconcile();assert.equal(ex.status().closed[0].closeReason,'STOP_OR_EXTERNAL');
 // A position already on the venue (manual) is not added to.
 const v3=venue();v3.setSize(5000);const ex3=make(v3);const r3=await ex3.handle({id:1,date:1e12,text:OPEN});
 assert.equal(r3.reason,'VENUE_POSITION_EXISTS');assert.equal(v3.size,5000);
 const bad=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:venue().client,contractOf:async()=>null,balance:async()=>null,now:()=>1});
 const r=await bad.handle({id:9,date:1,text:OPEN});assert.equal(r.reason,'NO_BINGX_CONTRACT');assert.equal(bad.status().events[0].type,'ERROR');
 assert.equal(copyConfig({},'LIVE').enabled,false);assert.equal(copyConfig({COPY_TRADING:'off'},'TESTNET').enabled,false);
});

test('copy: ledger survives a restart; notices read well',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-'));const v=venue();
 const a=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 await a.handle({id:1,date:1e12,text:OPEN});
 const b=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
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
 v=venue();ex=make(v);v.failStop='VENUE_ERROR_101204';await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'NO_STOP');
 // A rate limit is not a refusal: kept (stale), placed again by the routine check.
 v=venue();ex=make(v);v.failStop=true;await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.size,98);assert.equal(ex.status().positions[0].stopStale,true);
 v.failStop=false;await ex.reconcile();assert.equal(ex.status().positions[0].stopStale,false);
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

test('copy: BingX allows one stop per position (110406): the stop is swapped — cancelled, then placed at the new price; on failure the old price is put back',async()=>{
 let v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const place=v.client.placeOrder;let live=1;
 v.client.cancelOrder=async()=>{live--;return {}};
 v.client.placeOrder=async p=>{if(p.type==='STOP_MARKET'){if(live>0)throw Object.assign(Error('A Stop Loss order already exists'),{code:'VENUE_ERROR_110406'});live++}return place(p)};
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 let p=ex.status().positions[0];assert.equal(p.stopStale,false);assert.equal(live,1,'exactly one stop');assert.equal(v.size,192);
 // The new stop keeps failing after the cancel: the old price is placed again (stale, retried later).
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});const first=ex.status().positions[0].stop;let n=0;
 const place2=v.client.placeOrder;
 v.client.placeOrder=async p=>{if(p.type==='STOP_MARKET'){n++;if(n===1)throw Object.assign(Error('exists'),{code:'VENUE_ERROR_110406'});if(Number(p.stopPrice)!==first)throw Object.assign(Error('busy'),{code:'VENUE_ERROR_100500'})}return place2(p)};
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 p=ex.status().positions[0];assert.equal(p.stopStale,true);assert.ok(p.stopOrderId);assert.equal(v.size,192);
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
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,zonesOf:async()=>zones,candlesOf:async()=>candles,
  balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // Short at 0.051: 0.0518 (1.6 %) and 0.0570 (11.8 %) are where the trader adds; 0.0640 (25 %) is the exit zone.
 assert.deepEqual(ex.zoneStop({direction:'SHORT',entry:.051,zones}).zone,{priceLow:.063,priceHigh:.064});
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.status().positions[0];assert.equal(p.stopSource,'BACKSTOP');assert.ok(Math.abs(p.stopDistPct-25.5)<.2,p.stopDistPct);
 const bar=(i,c,vol)=>[1e12-(30-i)*900000,c,c,c,c,vol,1e12-(30-i)*900000+899999];
 // Beyond the zone on ordinary volume: kept.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,120)];await ex.reconcile();assert.equal(v.size,98);
 // Beyond the zone on 2x volume: closed.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,200)];await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'ZONE_BREAK_VOLUME');
 // At most COPY_MAX_ADDS adds (default 100 since 2026-11-14; 10 here).
 const v2=venue(),ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_MAX_ADDS:'10',COPY_STOPS:'on',COPY_MAX_TOTAL_MARGIN_PCT:'100'},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:400}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:OPEN});let q=880;
 for(let k=0;k<12;k++){await ex2.handle({id:10+k,date:1e12,text:CHANGE(q,q+880)});q+=880}
 assert.equal(ex2.status().positions[0].adds,10);assert.ok(ex2.status().events.some(e=>e.reason==='COPY_MAX_ADDS'));
});

test('copy review: the trader total follows the trader even when our buy is skipped; a failed partial close retries the same share; "- → q" positions keep their scale',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const closeQ=q=>`✅ 포지션 청산\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short\n━━━━━━━━━━━━━━━━\n진입가 0.05000 USDT\n수량 ${q}\n최종손익 🟢 +0.3 USDT`;
 let v=venue(),ex;{let n=0;ex=make(v,{free:()=>n++<1?300:.5})}
 await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(0.4,'0.05100')});
 assert.equal(v.size,100,'add skipped (margin)');assert.equal(ex.status().positions[0].theirTotal,.8,'trader total still 0.8');
 await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,50,'half of ours, not all');
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(1.2,'0.05100')});
 assert.equal(v.size,400);v.failMarket=true;await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,400);
 v.failMarket=false;await ex.reconcile();assert.equal(v.size,300,'a quarter, once');await ex.reconcile();assert.equal(v.size,300);
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:CHANGE('-','880')});
 assert.equal(ex.status().positions[0].theirFirstQty,880);
});

test('copy BALANCE_RATIO: the trader quantity x our equity / 20,000 $, no 1 $ floor; each cut has its own order id',async()=>{
 // Default (user 2026-11-14 12:31): the venue's smallest order first, adds as many as the trader (100), up to 100 % of the equity as margin.
 assert.equal(copyConfig({},'TESTNET').sizing,'MIN_ORDER');assert.equal(copyConfig({},'TESTNET').maxAdds,100);assert.equal(copyConfig({},'TESTNET').maxTotalMarginPct,100);assert.equal(copyConfig({},'TESTNET').marginUSD,1);
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue();const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 880 x 400 / 20,000 = 17.6 -> 17 coins (0.87 $ of notional... venue minimum 2 $ -> raised to the minimum).
 await ex.handle({id:1,date:1e12,text:card(5000,'0.05000')});
 assert.equal(v.size,100,'5,000 x 0.02 = 100 coins');assert.equal(ex.status().positions[0].scale,.02);
 await ex.handle({id:2,date:1e12+600000,text:card(2500,'0.05100')});assert.equal(v.size,150,'2,500 more x 0.02 = 50');
 await ex.handle({id:3,date:1e12+700000,text:CHANGE(7500,5000)});await ex.handle({id:4,date:1e12+800000,text:CHANGE(5000,2500)});
 assert.equal(v.size,50);
 const cuts=v.calls.filter(c=>c.reduceOnly==='true').map(c=>c.clientOrderId);assert.equal(cuts.length,2);assert.notEqual(cuts[0],cuts[1]);
 assert.equal(ex.status().positions[0].reduces,2);
 // Tiny trader order: below the venue minimum -> the minimum, flagged.
 const v2=venue();const ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:card(100,'0.05000')});assert.equal(ex2.status().positions[0].minOrder,true);
});

test('copy: a card whose quantity does not match its margin x leverage is not traded; first entries respect the total margin cap; small adds are carried',async()=>{
 const v=venue(),ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
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

test('copy entries need 90 % of the free margin; a venue minimum above 5 $ of margin is not taken',async()=>{
 const v=venue(),ex=make(v,{free:1});
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).reason,'MARGIN_SHORT');assert.equal(v.size,0);
 const big={...contract,minQuantityBase:'1000'};// 1000 coins x 0.05 / 5 = 10 $ of margin > 5 $
 const v2=venue(),ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v2.client,contractOf:async()=>big,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 const card=`📌 포지션 진입\nTNSRUSDT 🔴 Short ×5\n진입가 0.05 USDT\n현재가 0.05000 USDT\n수량 100`;
 assert.equal((await ex2.handle({id:1,date:1e12,text:card})).reason,'MIN_ORDER_TOO_LARGE');assert.equal(v2.size,0);
});

test('copy: the position mode is read before any setting or order; unreadable -> skipped, one-way unchanged',async()=>{
 const v=venue();v.client.positionMode=async()=>{throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 const ex=make(v);const r=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(r.reason,'BINGX_POSITION_MODE_UNKNOWN');assert.equal(v.size,0);assert.equal(v.calls.length,0);
 assert.equal(copyEventText(ex.status().events[0]).includes('BINGX_POSITION_MODE_UNKNOWN'),false,'shown in Korean');
 const v2=venue();v2.client.positionMode=async()=>({dualSidePosition:false});const ex2=make(v2);await ex2.handle({id:1,date:1e12,text:OPEN});assert.ok(v2.size>0);
 const open=v2.calls.find(c=>c.op==='order'&&c.type==='MARKET');assert.equal(open.positionSide,'BOTH');assert.equal(ex2.status().positions[0].hedge,false);
 const v3=venue();v3.client.positionMode=async()=>({});assert.equal((await make(v3).handle({id:1,date:1e12,text:OPEN})).reason,'BINGX_POSITION_MODE_UNKNOWN','a mode not stated is not guessed');
});

// Hedge (dual-side) account (user 2026-11-17): one row per side with a positive amount; BingX refuses
// reduceOnly and positionSide BOTH there.
function hedgeVenue(){
 const calls=[],pos={LONG:{amt:0,avg:0},SHORT:{amt:0,avg:0}};let id=1;
 const client={positionMode:async()=>({dualSidePosition:true}),
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {}},
  positions:async()=>Object.entries(pos).filter(([,x])=>x.amt>0).map(([side,x])=>({symbol:'TNSR-USDT',positionSide:side,positionAmt:String(x.amt),avgPrice:String(x.avg),markPrice:'0.053',unrealizedProfit:'-0.1'})),
  placeOrder:async p=>{calls.push({op:'order',...p});
   if('reduceOnly' in p||!['LONG','SHORT'].includes(p.positionSide))throw Object.assign(Error('hedge mode params'),{code:'VENUE_ERROR_109400'});
   if(p.type==='MARKET'){const q=Number(p.quantity),x=pos[p.positionSide],opening=(p.positionSide==='LONG')===(p.side==='BUY');
    if(opening){x.avg=0.051;x.amt=+(x.amt+q).toFixed(6)}else x.amt=Math.max(0,+(x.amt-q).toFixed(6))}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,pos};
}
const OPEN_LONG=OPEN.replace('🔴 Short','🟢 Long'),CLOSE_LONG=CLOSE.replace('🔴 Short','🟢 Long');

test('copy hedge mode: orders carry positionSide LONG / SHORT and no reduceOnly; both sides of a coin can be copied',async()=>{
 const v=hedgeVenue(),ex=make(v);
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true,JSON.stringify(ex.status().events));
 const short=ex.status().positions.find(p=>p.direction==='SHORT');assert.equal(short.hedge,true);
 const open=v.calls.find(c=>c.op==='order'&&c.type==='MARKET');assert.deepEqual([open.side,open.positionSide],['SELL','SHORT']);assert.ok(!('reduceOnly' in open));
 assert.deepEqual(v.calls.find(c=>c.op==='lev'),{op:'lev',side:'SHORT',l:5});
 const stop=v.calls.find(c=>c.type==='STOP_MARKET');assert.deepEqual([stop.side,stop.positionSide,stop.closePosition],['BUY','SHORT','true']);
 await ex.handle({id:2,date:1e12,text:CHANGE(880,440)});
 const cut=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([cut.side,cut.positionSide],['BUY','SHORT']);assert.ok(!('reduceOnly' in cut));
 assert.equal(v.pos.SHORT.amt,49);
 // The other side of the same coin: a separate venue position in hedge mode.
 assert.equal((await ex.handle({id:3,date:1e12,text:OPEN_LONG})).ok,true,JSON.stringify(ex.status().events.slice(0,3)));
 const lo=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([lo.side,lo.positionSide],['BUY','LONG']);
 assert.ok(v.pos.LONG.amt>0);assert.equal(ex.status().positions.length,2);
 // Each position reads its own row; closing the long leaves the short.
 await ex.reconcile();assert.equal(ex.status().positions.find(p=>p.direction==='SHORT').qty,49);assert.equal(ex.status().positions.find(p=>p.direction==='LONG').qty,v.pos.LONG.amt);
 await ex.handle({id:4,date:1e12,text:CLOSE_LONG});
 const cl=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([cl.side,cl.positionSide],['SELL','LONG']);assert.ok(!('reduceOnly' in cl));
 assert.equal(v.pos.LONG.amt,0);assert.equal(v.pos.SHORT.amt,49);assert.equal(ex.status().positions.length,1);
 assert.ok(!ex.status().events.some(e=>e.reason==='BINGX_HEDGE_MODE'||e.type==='ERROR'));
});

test('copy hedge mode: a same-side position already on the venue still blocks; an opposite one does not',async()=>{
 const v=hedgeVenue();v.pos.SHORT={amt:500,avg:.05};
 assert.equal((await make(v).handle({id:1,date:1e12,text:OPEN})).reason,'VENUE_POSITION_EXISTS');
 const v2=hedgeVenue();v2.pos.LONG={amt:500,avg:.05};
 assert.equal((await make(v2).handle({id:1,date:1e12,text:OPEN})).ok,true);assert.equal(v2.pos.LONG.amt,500,'the manual long is untouched');
 // One-way ledger positions still keep the other side out (one-way would merge them).
 const v3=venue(),ex3=make(v3);await ex3.handle({id:1,date:1e12,text:OPEN});await ex3.handle({id:2,date:1e12,text:OPEN_LONG});
 assert.equal(ex3.status().events[0].reason,'OPPOSITE_COPY_OPEN');
});

test('copy: a venue error shows the exchange message and the failed step',async()=>{
 const {VenueHttpError}=await import('../bingx_market.mjs');
 const v=venue();v.client.setLeverage=async()=>{throw new VenueHttpError('VENUE_ERROR_109400','PositionSide must be LONG or SHORT in hedge mode')};
 const ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const e=ex.status().events.find(x=>x.type==='ERROR');assert.equal(e.reason,'VENUE_ERROR_109400');
 assert.match(e.detail,/단계 레버리지 설정/);assert.match(e.detail,/BingX: PositionSide must be/);
});

test('copy MIN_ORDER (default): first buy = venue minimum, adds in proportion to it, small ones carried',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\nTNSRUSDT 🔴 Short ×5\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:card(1000,'0.05000')});const first=v.size;
 // The smallest valid order: at most 2 % over the venue minimum (2 $ notional here).
 assert.ok(first*0.05>=2&&first*0.05<=2.1,'minimum order: '+first);
 // Trader adds 500 (half of the first): half of our first -> below the minimum, carried.
 await ex.handle({id:2,date:1e12+600000,text:card(500,'0.05100')});assert.equal(v.size,first,'carried');
 // Trader adds 1500: with the carry, two of our first quantities.
 await ex.handle({id:3,date:1e12+700000,text:card(1500,'0.05200')});assert.ok(Math.abs(v.size-3*first)<=1,'proportional to our first: '+v.size);
});

test('copy: the screen gets PnL from the last price and a fresh balance',async()=>{
 const v=venue();let mark=0.05,eq=400,reads=0;const ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>mark,balance:async()=>{reads++;return {equity:eq,available:300}},now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});const p=ex.status().positions[0];
 mark=p.avg*0.9;eq=412;const s=await ex.liveStatus(),q=s.positions[0];
 // A short gains 10 % of avg x qty when the price falls 10 %.
 assert.ok(Math.abs(q.unrealized-p.avg*0.1*q.qty)<1e-9,'short PnL: '+q.unrealized);assert.equal(s.funds.equity,412);
});

test('copy: a missed position is entered late on the trader\'s add (with the reason); never after our own close, never on a cut',async()=>{
 const chg=(sym,dir,a,b)=>`📊 포지션 변경\n🪙 ${sym}  ${dir==='LONG'?'🟢 Long':'🔴 Short'}\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
 // The entry was skipped (no free margin); the add later finds no free margin either: the reason is kept.
 const v=venue(),ex=make(v,{free:1});
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).reason,'MARGIN_SHORT');
 await ex.handle({id:2,date:1e12+60000,text:chg('TNSRUSDT','SHORT',880,1760)});
 const late=ex.status().events.find(x=>x.type==='LATE_ENTRY');assert.equal(late.cause,'MARGIN_SHORT');assert.equal(v.size,0);
 // Never received: the add opens a new position now (the minimum order), tracked from the trader's 1760.
 const v2=venue(),ex2=make(v2);
 const r=await ex2.handle({id:3,date:1e12+60000,text:chg('TNSRUSDT','SHORT',880,1760)});
 assert.equal(r.ok,true);assert.ok(v2.size>0);const p=ex2.status().positions[0];assert.equal(p.theirFirstQty,1760);
 assert.equal(ex2.status().events.find(x=>x.type==='OPENED').late,true);
 // A cut of a missed position does not enter.
 const v3=venue(),ex3=make(v3);
 assert.equal((await ex3.handle({id:4,date:1e12,text:chg('TNSRUSDT','SHORT',1760,880)})).reason,'NOT_COPIED');assert.equal(v3.size,0);
 assert.equal(ex3.status().events.find(x=>x.reason==='NOT_COPIED').cause,'NO_ENTRY_RECEIVED');
 // Off switch.
 assert.equal(copyConfig({COPY_LATE_ENTRY:'off'},'TESTNET').lateEntry,false);assert.equal(copyConfig({},'TESTNET').lateEntry,true);
});

test('copy: no late entry after our own close; old messages that arrive late are ignored',async()=>{
 const chg=(a,b)=>`📊 포지션 변경\n🪙 TNSRUSDT  🔴 Short\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
 // Opened, then closed by hand on the venue: the next add finds it gone, the one after must not reopen it.
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);
 await ex.handle({id:2,date:1e12+60000,text:chg(880,1760)});
 const r=await ex.handle({id:3,date:1e12+120000,text:chg(1760,3520)});
 assert.equal(r.reason,'NOT_COPIED');assert.equal(v.size,0);
 assert.equal(ex.status().events.find(x=>x.reason==='NOT_COPIED').cause,'OUR_COPY_CLOSED');
 // An entry card while the trader still holds it (an add in card form) does not reopen it either.
 assert.equal((await ex.handle({id:4,date:1e12+150000,text:OPEN.replace('0.05296','0.05100')})).reason,'OUR_COPY_CLOSED');assert.equal(v.size,0);
 // After the trader closes, a new entry is followed again.
 const nowT=ex.now;ex.now=()=>nowT()+1000;
 await ex.handle({id:7,date:1e12+170000,text:'✅ 포지션 청산\n🪙 TNSRUSDT  🔴 Short\n진입가 0.05296 USDT\n최종손익 🟢 +1.72 USDT'});
 assert.equal((await ex.handle({id:8,date:1e12+180000,text:OPEN.replace('0.05296','0.05100')})).ok,true);
 // Gone on the venue before the trader's close card: the trader's next entry is followed.
 const v4=venue(),ex4=make(v4);let t4=1e12;ex4.now=()=>t4;await ex4.handle({id:20,date:1e12,text:OPEN});v4.setSize(0);
 t4+=1000;await ex4.handle({id:21,date:1e12+60000,text:'✅ 포지션 청산\n🪙 TNSRUSDT  🔴 Short\n진입가 0.05296 USDT\n최종손익 🟢 +1.72 USDT'});
 t4+=1000;assert.equal((await ex4.handle({id:22,date:1e12+120000,text:OPEN.replace('0.05296','0.05100')})).ok,true);
 // An entry card older than a message already handled for the coin is history.
 const v2=venue(),ex2=make(v2);await ex2.handle({id:5,date:1e12+60000,text:chg(880,1760)});const after=v2.size;
 assert.equal((await ex2.handle({id:6,date:1e12,text:OPEN})).reason,'STALE_MESSAGE');assert.equal(v2.size,after);
});

test('copy MIN_ORDER: the first buy is at least 0.3 $ of margin (BTC at 80x), the venue minimum when that is less',async()=>{
 assert.equal(copyConfig({},'TESTNET').firstMarginUSD,0.3);
 const btc={...contract,minQuantityBase:'0.0001',quantityStep:'0.0001',minNotionalUSDT:'2',tickSize:'0.1'};
 const card=`📌 포지션 진입\nBTCUSDT 🟢 Long ×80\n진입가 67727.2 USDT\n현재가 67727.2 USDT\n수량 0.5`;
 const v=venue();v.client.leverage=async()=>({maxLongLeverage:125});
 const ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>btc,markOf:async()=>67727.2,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:card});
 // 0.3 $ x 80 / 67727 = 0.000354 -> 0.0003 BTC (about 0.25 $ of margin; the bare minimum 0.0001 was 0.08 $).
 assert.equal(v.calls.find(c=>c.type==='MARKET').quantity,'0.0003');
 assert.equal(copyConfig({COPY_FIRST_MARGIN_USD:'0'},'TESTNET').firstMarginUSD,0);
});

test('copy FIRST_1USD (selectable): adds in proportion to the trader, tiny adds carried to the venue minimum',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // The first buy: 1 $ of margin (raised to the venue minimum of 2 $ notional when smaller).
 await ex.handle({id:1,date:1e12,text:card(1000,'0.05000')});const first=v.size;assert.ok(first>0);
 assert.ok(first*0.05>=2&&first*0.05/ex.status().positions[0].leverage<=1.05,'about 1 $ of margin');
 // Trader adds 10 (1 % of the first): far below the minimum -> carried, nothing sent.
 const sent=v.calls.length;await ex.handle({id:2,date:1e12+600000,text:card(10,'0.05100')});assert.equal(v.size,first,'carried');
 // Trader adds 1000 (same as the first): about the first quantity again, carry included.
 await ex.handle({id:3,date:1e12+700000,text:card(1000,'0.05200')});assert.ok(v.size>first*1.8,'proportional add: '+v.size);
});

test('copy stop: a venue that refuses the far backstop gets 30 %, then 20 %',async()=>{
 const v=venue(),ex=make(v),place=v.client.placeOrder;
 v.client.placeOrder=async q=>{if(q.type==='STOP_MARKET'&&Number(q.stopPrice)>0.051*1.35)throw Object.assign(Error('trigger price out of range'),{code:'VENUE_ERROR_101204'});return place(q)};
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.status().positions[0];assert.equal(p.stopDistPctActual,30);assert.ok(Math.abs(p.stop-0.051*1.3)<1e-5);
});

test('copy: SNDKUSDT follows the BingX stock perpetual, PEPEUSDT the 1000-coin contract (quantity / 1000, price x 1000)',async()=>{
 const {resolveCopyContract}=await import('../copy_executor.mjs');
 const m=new Map([['NCSKSNDK2USDUSDT',{symbol:'NCSKSNDK2USDUSDT',venueSymbol:'NCSKSNDK2USD-USDT'}],['1000PEPEUSDT',{symbol:'1000PEPEUSDT',venueSymbol:'1000PEPE-USDT',quantityStep:'1',tickSize:'0.000001',minQuantityBase:'1',minNotionalUSDT:2,tradable:true}]]);
 assert.equal(resolveCopyContract(m,'SNDKUSDT').venueSymbol,'NCSKSNDK2USD-USDT');assert.equal(resolveCopyContract(m,'AKEUSDT'),null);
 const pepe=resolveCopyContract(m,'PEPEUSDT');assert.equal(pepe.unitMultiplier,1000);
 const calls=[];let size=0;
 const client={leverage:async()=>({maxLongLeverage:50}),setMarginType:async()=>({}),setLeverage:async()=>({}),cancelOrder:async()=>({}),
  positions:async()=>size>0?[{symbol:'1000PEPE-USDT',positionAmt:String(size),avgPrice:'0.01',markPrice:'0.01',unrealizedProfit:'0'}]:[],
  placeOrder:async p=>{calls.push(p);if(p.type==='MARKET')size+=Number(p.quantity);return {order:{orderId:String(calls.length)}}}};
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO'},'TESTNET'),client,contractOf:async()=>pepe,markOf:async()=>0.01,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 10,000,000 PEPE at 0.00001 x 0.02 = 200,000 PEPE = 200 contracts of 1000 at 0.01.
 await ex.handle({id:1,date:1e12,text:'📌 포지션 진입\nPEPEUSDT 🟢 Long ×10\n진입가 0.00001 USDT\n현재가 0.00001 USDT\n수량 10000000'});
 assert.equal(calls.find(c=>c.type==='MARKET').quantity,'200');assert.equal(calls.find(c=>c.type==='MARKET').symbol,'1000PEPE-USDT');
});

test('copy: a contract at another price is refused (a stock perpetual matched to a coin of the same letters); an alias without a price is not traded',async()=>{
 const coin={symbol:'NCSKCOIN2USDUSDT',venueSymbol:'NCSKCOIN2USD-USDT',quantityStep:'1',tickSize:'0.01',minQuantityBase:'1',minNotionalUSDT:2,tradable:true,alias:'NCSKCOIN2USDUSDT'};
 const card='📌 포지션 진입\nCOINUSDT 🟢 Long ×10\n진입가 0.05 USDT\n현재가 0.05 USDT\n수량 10000';
 let v=venue(),ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>coin,markOf:async()=>250,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal((await ex.handle({id:1,date:1e12,text:card})).reason,'PRICE_MISMATCH');assert.equal(v.calls.filter(c=>c.op==='order').length,0);
 v=venue();ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>coin,markOf:async()=>null,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal((await ex.handle({id:1,date:1e12,text:card})).reason,'PRICE_UNVERIFIED');
 // A 1000-coin card with a 마진 line passes the unit check (coin price used there).
 const {resolveCopyContract}=await import('../copy_executor.mjs');
 const pepe=resolveCopyContract(new Map([['1000PEPEUSDT',{symbol:'1000PEPEUSDT',venueSymbol:'1000PEPE-USDT',quantityStep:'1',tickSize:'0.000001',minQuantityBase:'1',minNotionalUSDT:2,tradable:true}]]),'PEPEUSDT');
 v=venue();ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>pepe,markOf:async()=>0.01,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 const r=await ex.handle({id:2,date:1e12,text:'📌 포지션 진입\nPEPEUSDT 🟢 Long ×10\n진입가 0.00001 USDT\n현재가 0.00001 USDT\n수량 10000000\u3000마진 10 USDT'});
 assert.notEqual(r.reason,'QUANTITY_UNIT_UNCLEAR');
});

test('copy stops off by default (user 2026-11-13, testnet): no exchange stop, no zone exit; an old stop is removed; the ledger loss limit stays',async()=>{
 assert.equal(copyConfig({},'TESTNET').stops,false);
 const v=venue();let candles=[];
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,zonesOf:async()=>[{priceLow:.063,priceHigh:.064}],candlesOf:async()=>candles,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.calls.filter(c=>c.type==='STOP_MARKET').length,0);assert.equal(ex.status().positions[0].stopSource,'NONE');
 const bar=(i,c,vol)=>[1e12-(30-i)*900000,c,c,c,c,vol,1e12-(30-i)*900000+899999];
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,300)];await ex.reconcile();assert.equal(v.size,98,'no zone exit');
 v.unreal='-210';await ex.reconcile();assert.equal(v.size,0,'ledger loss limit still closes');
});

test('real-money copy only with COPY_MODE=LIVE and the confirm phrase; its own switch, off at start; notices say 실계좌',async()=>{
 const {COPY_LIVE_PHRASE}=await import('../copy_executor.mjs');
 assert.equal(copyConfig({COPY_MODE:'LIVE'},'TESTNET').mode,'TESTNET','no phrase: stays testnet');
 assert.equal(copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'yes'},'OFF').enabled,false);
 const cfg=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:COPY_LIVE_PHRASE},'TESTNET');assert.equal(cfg.mode,'LIVE');assert.equal(cfg.enabled,true);
 const v=venue();let ex;ex=new CopyExecutor({config:cfg,client:v.client,contractOf:async()=>contract,gate:()=>ex.armed?{ok:true}:{ok:false,reason:'COPY_DISARMED'},balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal(ex.status().armed,false);await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.size,0);
 ex.arm();await ex.handle({id:2,date:1e12+1,text:OPEN.replace('TNSRUSDT','TNSRUSDT')});
 assert.match(copyEventText({type:'OPENED',mode:'LIVE',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,qty:1}),/카피·실계좌 .* \(실계좌\)/);
});

test('copy MIN_ORDER: the minimum is met at the venue price, a 101400 minimum is retried once, a refused entry leaves no ledger row',async()=>{
 const mk=(v,markOf)=>new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // Card 0.051, venue 0.0485: 2 USDT x 1.05 / 0.0485 = 43.3 -> 44 coins (the card price alone gave 42).
 let v=venue(),ex=mk(v,async()=>0.0485);await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.calls.find(c=>c.type==='MARKET').quantity,'44');
 // BingX refuses with its own minimum: one retry at that minimum, a new client id.
 v=venue();let n=0;const place=v.client.placeOrder;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&!p.reduceOnly&&n++===0)throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return place(p)};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});
 const m=v.calls.filter(c=>c.type==='MARKET');assert.equal(m.length,1);assert.equal(m[0].quantity,'149');assert.equal(ex.status().positions[0].firstQty,149);
 assert.ok(ex.status().events.some(e=>e.type==='ENTRY_RETRY_MIN'));
 // Refused twice: no empty ledger row, and a later change card says why.
 v=venue();v.client.placeOrder=async p=>{if(p.type==='MARKET')throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(ex.status().positions.length,0);
 await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)});
 // With late entry on, the add tries again (LATE_ENTRY) and keeps the cause.
 const e=ex.status().events.find(x=>x.reason==='NOT_COPIED'||x.type==='LATE_ENTRY');assert.equal(e.cause,'VENUE_ERROR_101400');assert.match(e.causeDetail,/149/);
 // A minimum above the 5 $ margin limit is not retried.
 v=venue();n=0;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&n++===0)throw Object.assign(Error('The minimum order amount is 9000 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(n,1);assert.equal(ex.status().positions.length,0);
});

test('copy screen: an older "not copied" row without a stored cause shows the earlier failed entry',async()=>{
 const {copyHTML}=await import('../public/live_control.js');
 const events=[{type:'SKIPPED',symbol:'AKEUSDT',reason:'NOT_COPIED',at:3},{type:'ERROR',symbol:'AKEUSDT',kind:'CHANGE',reason:'VENUE_ERROR_101400',detail:'단계 진입 주문 · BingX: The minimum order amount is 182 AKE.',at:2}];
 const html=copyHTML({mode:'LIVE',enabled:true,armed:false,positions:[],closed:[],events});
 assert.match(html,/처음 진입을 .*건너뜀: 거래소 주문 조건 미달/);
});

test('copy: a "- → q" entry refused twice still explains the next change card; the retry respects the copy margin cap',async()=>{
 const chg=(a,b)=>CHANGE(a,b);
 let v=venue();v.client.placeOrder=async p=>{if(p.type==='MARKET')throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 let ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>0.053,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:chg('-',880)});await ex.handle({id:2,date:1e12+60000,text:chg(880,1760)});
 // With late entry on, the add tries again (LATE_ENTRY) and keeps the cause.
 const e=ex.status().events.find(x=>x.reason==='NOT_COPIED'||x.type==='LATE_ENTRY');assert.equal(e.cause,'VENUE_ERROR_101400');
 // Cap 1 % of 100 = 1 $: the first 42 coins fit, the 149-coin retry (1.5 $) does not.
 v=venue();let n=0;const place=v.client.placeOrder;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&!p.reduceOnly&&n++===0)throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return place(p)};
 ex=new CopyExecutor({config:copyConfig({COPY_MAX_TOTAL_MARGIN_PCT:'1'},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>0.051,balance:async()=>({equity:100,available:90}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(n,1);assert.equal(v.size,0);assert.equal(ex.status().positions.length,0);
});

test('copy page: recent closes 10 per page with page buttons and the full count (user 2026-11-17)',async()=>{
 const m=await import('../public/live_control.js');
 const c={mode:'LIVE',enabled:true,positions:[],events:[],closed:Array.from({length:23},(_,i)=>({symbol:'S'+i,direction:'LONG',closedAt:Date.now()-i*1e6,netUSD:1})),closedTotal:23};
 m.setCopyPage(0);let h=m.copyHTML(c);assert.match(h,/전체 23건/);assert.match(h,/1 \/ 3쪽/);assert.ok(h.includes('>S9<')&&!h.includes('>S10<'));assert.match(h,/data-copy-page="-1" disabled/);
 m.setCopyPage(9);h=m.copyHTML(c);assert.match(h,/3 \/ 3쪽/,'past the end: last page');assert.ok(h.includes('>S22<')&&!h.includes('>S0<'));
 m.setCopyPage(0);assert.doesNotMatch(m.copyHTML({...c,closed:c.closed.slice(0,5),closedTotal:5}),/copy-pager/);
});

test('copy page: entry failures below the closes with coin, long/short and reason, 10 per page (user 2026-11-17)',async()=>{
 const m=await import('../public/live_control.js');m.setCopyFailPage(0);
 const ev=Array.from({length:14},(_,i)=>({type:'SKIPPED',at:Date.now()-i*1e5,symbol:'C'+i,direction:i%2?'SHORT':'LONG',reason:'MARGIN_SHORT'}));
 const h=m.copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ev});
 assert.match(h,/진입 실패·건너뜀/);assert.match(h,/전체 14건/);assert.match(h,/1 \/ 2쪽/);assert.ok(h.includes('>C9<')&&!h.includes('>C10<'));assert.match(h,/<th>이유<\/th>/);
 m.setCopyFailPage(1);assert.ok(m.copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ev}).includes('>C13<'));m.setCopyFailPage(0);
});
