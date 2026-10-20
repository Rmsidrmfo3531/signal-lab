import test from 'node:test';
import assert from 'node:assert/strict';
import {paperEngineHealth} from '../paper_health.mjs';
import {PaperEngine} from '../paper.mjs';
const now=1770000000000;
const healthy={ws:'connected',lastTickerAt:now-1000,variational:'connected',scanMode:'verified',activeCount:20};
const empty={open:[],pending:[],closed:[]};
test('paper can be on standby without claiming a real trade',()=>{
 const result=paperEngineHealth({paper:empty,scanner:healthy,now});
 assert.equal(result.state,'WATCHING');assert.match(result.reason,/현재 열린 가상 포지션은 없습니다/);
 assert.equal(result.cryptoSignalReady,true);
});
test('paper does not falsely report active trading when feed is stale',()=>{
 const result=paperEngineHealth({paper:empty,scanner:{...healthy,lastTickerAt:now-900001},now});
 assert.equal(result.state,'OFFLINE');assert.equal(result.cryptoQuotesFresh,false);
});
test('paper distinguishes in progress vs stale positions',()=>{
 const pos={market:'CRYPTO',lastPriceAt:now-1200};
 assert.equal(paperEngineHealth({paper:{open:[pos],pending:[]},scanner:healthy,now}).state,'TRACKING');
 assert.equal(paperEngineHealth({paper:{open:[{...pos,lastPriceAt:now-180001}],pending:[]},scanner:healthy,now}).state,'DELAYED');
});
test('paper activity counters are session-only and preserve stored records',()=>{
 const store={closed:[{key:'old'}],open:[],pending:[],seen:{}};
 const eng=new PaperEngine(store,{now:()=>now});
 assert.equal(eng.store.closed.length,1);
 assert.equal(eng.telemetry.priceTickCount,0);
 eng.onPrice('CRYPTO','BTCUSDT',100,now-1000);
 assert.equal(eng.telemetry.priceTickCount,1);
 assert.equal(eng.telemetry.lastQuoteAt,now);
 assert.equal(eng.store.closed.length,1);
});
