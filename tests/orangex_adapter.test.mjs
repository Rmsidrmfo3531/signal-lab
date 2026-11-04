import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXClient,ORANGEX_API,orangeXInstrument,verifiedOrangeXInstrument,
 examineOrangeXBook,makeOrangeXOrderPlan,orangeXSignature} from '../orangex_adapter.mjs';

const now=1793750400000;
const instruments=[{instrument_name:'SOL-USDT-PERPETUAL',kind:'perpetual',is_active:true,
 contract_size:'1',min_qty:'0.1',min_trade_amount:'0.1',tick_size:'0.001'}];
const book={timestamp:now-1000,bids:[['149.95','100']],asks:[['150.05','100']]};
const signal={symbol:'SOLUSDT',direction:'LONG',pattern:'retest',time:now-3600000,patternConfirmedAt:now-20000,
 score:100,technicalQualified:true,qualified:true,status:'signal',stop:148,target1:155};

test('matches only active exact OrangeX USDT perpetuals',()=>{
 assert.equal(orangeXInstrument('SOLUSDT'),'SOL-USDT-PERPETUAL');
 assert.equal(verifiedOrangeXInstrument('SOLUSDT',instruments),'SOL-USDT-PERPETUAL');
 assert.throws(()=>verifiedOrangeXInstrument('ETHUSDT',instruments));
 assert.throws(()=>orangeXInstrument('SOLBTC'));
});
test('rejects stale, crossed and wide order books',()=>{
 assert.equal(examineOrangeXBook(book,{now}).ask,150.05);
 assert.throws(()=>examineOrangeXBook({...book,timestamp:now-20000},{now}));
 assert.throws(()=>examineOrangeXBook({...book,asks:[['149','100']]},{now}));
 assert.throws(()=>examineOrangeXBook({...book,asks:[['151','100']]},{now}));
});
test('previews only qualified 100/100 signals with fresh Binance quotes',()=>{
 const opts={signal,binancePrice:150,binancePriceAt:now-1000,orangexBook:book,instruments,now};
 const plan=makeOrangeXOrderPlan(opts);
 assert.equal(plan.previewOnly,true);
 assert.equal(plan.method,'/private/buy');
 assert.equal(plan.params.type,'limit');
 assert.equal(plan.params.position_side,'BOTH');
 assert.equal(plan.params.stop_loss_price,'148');
 assert.throws(()=>makeOrangeXOrderPlan({...opts,signal:{...signal,score:85}}));
 assert.throws(()=>makeOrangeXOrderPlan({...opts,signal:{...signal,qualified:false}}));
 assert.throws(()=>makeOrangeXOrderPlan({...opts,binancePriceAt:now-20000}));
 assert.throws(()=>makeOrangeXOrderPlan({...opts,instruments:[]}));
 assert.throws(()=>makeOrangeXOrderPlan({...opts,binancePrice:140}));
});
test('HMAC signature reflects auth fields, does not expose credential values',()=>{
 const args={clientId:'id',clientSecret:'secret',timestamp:'12',nonce:'nonce'};
 assert.equal(orangeXSignature(args).length,64);
 assert.notEqual(orangeXSignature(args),orangeXSignature({...args,nonce:'different'}));
});
test('read-only adapter refuses live write methods without making network calls',async()=>{
 const client=new OrangeXClient({transport:()=>{throw Error('unexpected network call')}});
 for(const method of ['/private/buy','/private/sell','/private/withdraw','/private/cancel'])
  await assert.rejects(()=>client.rpc(method,{},'token'),/disabled/);
});
test('public book is sent to correct endpoint as JSON RPC',async()=>{
 let calls=0;
 const client=new OrangeXClient({transport:async(url,init)=>{
  calls++;assert.equal(url,ORANGEX_API);assert.equal(JSON.parse(init.body).method,'/public/get_order_book');
  assert.equal('Authorization' in init.headers,false);
  return {ok:true,json:async()=>({id:1,jsonrpc:'2.0',result:book})};
 }});
 assert.deepEqual(await client.orderBook('SOL-USDT-PERPETUAL'),book);
 assert.equal(calls,1);
});
