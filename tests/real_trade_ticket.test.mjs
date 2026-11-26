import test from 'node:test';
import assert from 'node:assert/strict';
import {createRealTradeController} from '../public/real_trade.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function ticket(t){
 const handlers={},requests=[],orders=[],confirmations=[];
 const mount={innerHTML:'',querySelector:()=>null,contains:()=>false,addEventListener:(type,fn)=>{handlers[type]=fn}};
 t.mock.method(globalThis,'setInterval',()=>0);
 for(const [key,value] of Object.entries({
  document:{activeElement:{},addEventListener(){}},
  window:{confirm:message=>{confirmations.push(message);return true}},
 })){
  const prior=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{configurable:true,value});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key]});
 }
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.startsWith('/api/real/trade/info?'))return new Promise(resolve=>requests.push(resolve));
  if(url==='/api/real/trade/order')orders.push(JSON.parse(options.body));
  return {ok:true,json:async()=>({})};
 });
 const controller=createRealTradeController(mount);
 controller.syncContext({visible:true,availableUSD:100});
 const click=(selector,dataset)=>handlers.click({target:{closest:s=>s===selector?{dataset}:null},stopPropagation(){}});
 const fill=(symbol,fields={})=>controller.prefill({symbol,side:'LONG',...fields});
 const finish=async(index,symbol,fields={})=>{
  requests[index]({ok:true,json:async()=>({symbol,price:100,...fields})});
  await tick();
 };
 handlers.input({target:{matches:s=>s==='[data-rt-amount]',value:'2'}});
 return {mount,fill,finish,click,confirmations,orders,submit:async()=>{click('[data-rt-submit]',{rtSubmit:'LONG'});await tick()}};
}

test('only the latest selected contract can reach manual order confirmation and submission',async t=>{
 const ui=ticket(t);
 ui.fill('BTCUSDT');
 ui.click('[data-rt-pick-sym]',{rtPickSym:'ETHUSDT'});
 await ui.submit();
 assert.equal(ui.confirmations.length,0);
 await ui.finish(1,'ETHUSDT');
 await ui.finish(0,'BTCUSDT');
 assert.match(ui.mount.innerHTML,/rt-pair-name">ETHUSDT</);
 await ui.submit();
 assert.match(ui.confirmations[0],/종목: ETHUSDT/);
 assert.equal(ui.orders[0].symbol,'ETHUSDT');
});

test('unrelated contract response is refused and exchange-resolved aliases still work',async t=>{
 const ui=ticket(t);
 ui.fill('BTCUSDT');
 await ui.finish(0,'ETHUSDT');
 await ui.submit();
 assert.equal(ui.confirmations.length,0);
 ui.fill('PEPEUSDT');
 await ui.finish(1,'1000PEPEUSDT',{requestedSymbol:'PEPEUSDT'});
 await ui.submit();
 assert.match(ui.confirmations[0],/1000PEPEUSDT/);
 assert.equal(ui.orders[0].symbol,'1000PEPEUSDT');
});

test('a new external draft replaces both price fields and any automatic ROE stop',async t=>{
 const ui=ticket(t);
 ui.fill('BTCUSDT',{tpPrice:105,slPrice:90});
 assert.match(ui.mount.innerHTML,/data-rt-tp value="105"/);
 assert.match(ui.mount.innerHTML,/data-rt-sl value="90"/);
 ui.click('[data-rt-sl-roe]',{rtSlRoe:'15'});
 ui.fill('ETHUSDT',{slPrice:95});
 assert.match(ui.mount.innerHTML,/data-rt-sl value="95"/);
 assert.match(ui.mount.innerHTML,/data-rt-tp value=""/);
 ui.fill('ETHUSDT');
 await ui.finish(2,'ETHUSDT');
 await ui.submit();
 assert.equal(ui.orders[0].slPrice,null);
 assert.equal(ui.orders[0].tpPrice,null);
});
