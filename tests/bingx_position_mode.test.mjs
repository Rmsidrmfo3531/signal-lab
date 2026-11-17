import test from 'node:test';
import assert from 'node:assert/strict';
import {hedgeOf,isHedge,readPositionMode,positionSideFor,leverageSideFor,sideParams,forMode,positionRow,orderOnSide,ordersOnSide,otherSideAmount} from '../bingx_position_mode.mjs';

test('mode answer: booleans and strings, nothing guessed',async()=>{
 assert.equal(hedgeOf({dualSidePosition:true}),true);assert.equal(hedgeOf({dualSidePosition:'true'}),true);assert.equal(hedgeOf({dualSidePosition:'TRUE'}),true);
 assert.equal(hedgeOf({dualSidePosition:false}),false);assert.equal(hedgeOf({dualSidePosition:'false'}),false);
 for(const bad of [null,undefined,{},{dualSidePosition:''},{dualSidePosition:'yes'},{dualSidePosition:1}])assert.equal(hedgeOf(bad),null,JSON.stringify(bad));
 assert.equal(isHedge({dualSidePosition:'true'}),true);assert.equal(isHedge({}),false);
 assert.deepEqual(await readPositionMode({positionMode:async()=>({dualSidePosition:'true'})}),{ok:true,hedge:true});
 assert.deepEqual(await readPositionMode({positionMode:async()=>({dualSidePosition:false})}),{ok:true,hedge:false});
 assert.deepEqual(await readPositionMode({}),{ok:true,hedge:false},'a client without positionMode stays one-way');
 const fail=await readPositionMode({positionMode:async()=>{throw Object.assign(Error('x'),{code:'HTTP_429'})}});assert.deepEqual(fail,{ok:false,reason:'BINGX_POSITION_MODE_UNKNOWN',detail:'HTTP_429'});
 assert.equal((await readPositionMode({positionMode:async()=>({})})).ok,false);
});

test('order params by mode: positionSide, reduceOnly only one-way closing, leverage side',()=>{
 assert.equal(positionSideFor({hedge:false,direction:'SHORT'}),'BOTH');assert.equal(positionSideFor({hedge:true,direction:'SHORT'}),'SHORT');assert.equal(positionSideFor({hedge:true,direction:'LONG'}),'LONG');
 assert.equal(leverageSideFor({hedge:true,direction:'LONG'}),'LONG');assert.equal(leverageSideFor({hedge:false,direction:'LONG'}),'BOTH');
 assert.deepEqual(sideParams({hedge:false,direction:'LONG',closing:true}),{positionSide:'BOTH',reduceOnly:'true'});
 assert.deepEqual(sideParams({hedge:false,direction:'LONG'}),{positionSide:'BOTH'});
 assert.deepEqual(sideParams({hedge:true,direction:'SHORT',closing:true}),{positionSide:'SHORT'});
 const p={symbol:'X',reduceOnly:'true',type:'MARKET'};assert.equal(forMode(p,false),p,'one-way: the same object');
 assert.deepEqual(forMode(p,true),{symbol:'X',type:'MARKET'});assert.equal(p.reduceOnly,'true','the input is not changed');
});

test('position rows: one-way = the symbol row; hedge = the row of the position side only',()=>{
 const rows=[{symbol:'A-USDT',positionSide:'SHORT',positionAmt:'5'},{symbol:'A-USDT',positionSide:'LONG',positionAmt:'2'},{symbol:'B-USDT',positionSide:'BOTH',positionAmt:'-1'}];
 assert.equal(positionRow(rows,'A-USDT',{hedge:true,direction:'LONG'}).positionAmt,'2');
 assert.equal(positionRow(rows,'A-USDT',{hedge:true,direction:'SHORT'}).positionAmt,'5');
 assert.throws(()=>positionRow(rows,'B-USDT',{hedge:true,direction:'SHORT'}),e=>e.code==='POSITION_SIDE_UNKNOWN','hedge: a non-zero row without LONG / SHORT is not read as "no position"');
 assert.equal(positionRow([{symbol:'B-USDT',positionSide:'BOTH',positionAmt:'0'}],'B-USDT',{hedge:true,direction:'LONG'}),null,'an empty row is ignored');
 assert.equal(positionRow(rows,'B-USDT',{direction:'SHORT'}).positionAmt,'-1','one-way unchanged');
 assert.equal(otherSideAmount(rows,'A-USDT','LONG'),5);assert.equal(otherSideAmount(rows,'A-USDT','SHORT'),2);assert.equal(otherSideAmount([],'A-USDT','LONG'),0);
 assert.deepEqual(ordersOnSide([{positionSide:'SHORT'},{positionSide:'LONG'},{}],{hedge:true,direction:'LONG'}),[{positionSide:'LONG'},{}]);
 assert.equal(positionRow(rows,'A-USDT',{direction:'LONG'}),rows[0],'one-way: the first row, as before');
 assert.equal(positionRow(null,'A-USDT',{hedge:true,direction:'LONG'}),null);
 assert.equal(orderOnSide({positionSide:'SHORT'},{hedge:true,direction:'LONG'}),false);assert.equal(orderOnSide({positionSide:'LONG'},{hedge:true,direction:'LONG'}),true);
 assert.equal(orderOnSide({},{hedge:true,direction:'LONG'}),true);assert.equal(orderOnSide({positionSide:'SHORT'},{hedge:false,direction:'LONG'}),true);
});

test('a direction other than LONG / SHORT is refused, never read as LONG',()=>{
 for(const bad of ['long','BOTH','',undefined,null])for(const hedge of [true,false]){
  assert.throws(()=>positionSideFor({hedge,direction:bad}),e=>e.code==='DIRECTION_INVALID',String(bad));
  assert.throws(()=>sideParams({hedge,direction:bad,closing:true}),e=>e.code==='DIRECTION_INVALID')}
 assert.throws(()=>positionRow([],'A-USDT',{hedge:true,direction:'short'}),e=>e.code==='DIRECTION_INVALID');
});
