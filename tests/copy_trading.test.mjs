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
 const calls=[];let size=0,avg=0,id=1;
 const client={
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',l});return {}},
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:String(avg),markPrice:'0.053',unrealizedProfit:'-0.12'}]:[],
  placeOrder:async p=>{calls.push({op:'order',...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);if(p.reduceOnly){size=Math.max(0,+(size-q).toFixed(6))}else{avg=size?(avg*size+0.053*q)/(size+q):0.051;size=+(size+q).toFixed(6)}}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,setSize:v=>{size=v},get size(){return size}};
}
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
const make=(v,extra={})=>new CopyExecutor({config:{...copyConfig({},'TESTNET'),...extra.config},client:v.client,contractOf:async()=>contract,
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
 assert.equal(v.size,196,'doubled');assert.ok(v.calls.some(c=>c.op==='cancel'),'old stop replaced');
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});
 assert.equal(v.size,49,'cut to a quarter');assert.equal(v.calls.filter(c=>c.reduceOnly==='true').length,1);
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});assert.equal(v.size,49,'same message id once');
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
 const bad=new CopyExecutor({config:copyConfig({},'TESTNET'),client:venue().client,contractOf:async()=>null,balance:async()=>null,now:()=>1});
 const r=await bad.handle({id:9,date:1,text:OPEN});assert.equal(r.reason,'NO_BINGX_CONTRACT');assert.equal(bad.status().events[0].type,'ERROR');
 assert.equal(copyConfig({},'LIVE').enabled,false);assert.equal(copyConfig({COPY_TRADING:'off'},'TESTNET').enabled,false);
});

test('copy: ledger survives a restart; notices read well',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-'));const v=venue();
 const a=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 await a.handle({id:1,date:1e12,text:OPEN});
 const b=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 assert.equal(b.status().positions.length,1);assert.equal((await b.handle({id:1,date:1e12,text:OPEN})).duplicate,true);
 assert.match(copyEventText({type:'OPENED',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,qty:98,avg:.051,stop:1.07}),/📋 카피 · TNSRUSDT 숏 5배 진입 \(테스트넷\)/);
 assert.match(copyEventText({type:'CLOSED',symbol:'TNSRUSDT',reason:'TRADER_CLOSE',netUSD:-.12,theirPnlUSD:1.72,adds:1}),/손익 −\$0\.12 .* 트레이더 \+\$1\.72/);
 fs.rmSync(dir,{recursive:true,force:true});
});
