import test from 'node:test';
import assert from 'node:assert/strict';
import {MockOrangeXOrderSafety} from '../orangex_order_safety.mjs';

// Protocol scenarios only. These are not observed OrangeX capabilities or fills.
const checked=()=>({status:'MOCK_VALIDATED',dataSource:'SYNTHETIC_TEST'});
const caps=()=>({protectiveStop:checked(),reduceOnly:checked(),safeStopReplace:{...checked(),mode:'REGISTER_BEFORE_CANCEL'}});
const preview=(reference='signal1',direction='LONG')=>({previewOnly:true,mode:'READ_ONLY',transportAllowed:false,liveOrdersEnabled:false,
 instrumentName:'SOL-USDT-PERPETUAL',notionalUSDT:100,plannedRiskUSDT:2.5,
 intent:{clientReference:reference,side:direction==='LONG'?'BUY':'SELL',amount:1,limitPrice:100,stop:direction==='LONG'?98:102,
  targets:[.4,.35,.25].map((quantity,i)=>({price:100+(direction==='LONG'?1:-1)*(10+i*10),quantity}))}});
const model=extra=>new MockOrangeXOrderSafety({capabilities:caps(),...extra});
function open(subject,{reference='signal1',direction='LONG',options}={}){
 assert.equal(subject.submit(preview(reference,direction),options).accepted,true);
 assert.equal(subject.acknowledgeEntry({reference,orderId:'entry1'}).accepted,true);
 assert.equal(subject.entryFill({reference,orderId:'entry1',fillId:'ef1',quantity:.5,price:99,confirmed:true}).accepted,true);
 assert.equal(subject.entryFill({reference,orderId:'entry1',fillId:'ef2',quantity:.5,price:101,confirmed:true}).accepted,true);
 assert.equal(subject.observeProtection({reference,orderId:'oldStop',price:direction==='LONG'?98:102,quantity:1,active:true,reduceOnly:true}).accepted,true);
 for(const [i,role]of ['TP1','TP2','TP3'].entries())assert.equal(subject.acknowledgeExit({reference,role,orderId:role,
  quantity:[.4,.35,.25][i],reduceOnly:true}).accepted,true);
 return subject;
}
const position=(subject,reference='signal1')=>subject.snapshot().entries[reference];
const intents=(subject,action)=>subject.snapshot().intents.filter(item=>item.action===action);
const exit=(subject,quantity,{role='TP1',fillId='tp1a',price=110,...patch}={})=>subject.exitFill({reference:'signal1',role,
 orderId:role,fillId,quantity,price,confirmed:true,reduceOnly:true,...patch});

test('missing protection, safe replacement or reduce-only proof blocks mock entry and never activates LIVE',()=>{
 for(const key of ['protectiveStop','safeStopReplace','reduceOnly']){
  const capabilities=caps();delete capabilities[key];const subject=model({capabilities});
  assert.equal(subject.submit(preview()).accepted,false);assert.equal(subject.snapshot().intents.length,0);
 }
 const subject=model();assert.equal(subject.snapshot().mockEntryAllowed,true);
 assert.equal(subject.snapshot().activationAllowed,false);assert.equal(subject.snapshot().transportAvailable,false);
 assert.throws(()=>new MockOrangeXOrderSafety({dataSource:'LIVE_MARKET_PAPER'}),/MOCK_CONTEXT_REQUIRED/);
});

test('order ACK and price touch cannot create a position or trigger breakeven',()=>{
 const subject=model();assert.equal(subject.submit(preview()).accepted,true);
 subject.acknowledgeEntry({reference:'signal1',orderId:'entry1'});
 assert.equal(position(subject).filledQuantity,0);assert.equal(position(subject).averageEntry,null);
 assert.equal(subject.entryFill({reference:'signal1',orderId:'entry1',fillId:'notconfirmed',quantity:1,price:100,confirmed:false}).accepted,false);
 assert.equal(subject.replacementAck({reference:'signal1',requestId:null,newOrderId:'premature'}).accepted,false);
 assert.equal(intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,0);
});

test('unknown timeout blocks a duplicate submission before and after restart, without automatic retransmission',()=>{
 let subject=model();subject.submit(preview());subject.timeout('signal1');
 assert.equal(subject.submit(preview()).accepted,false);assert.equal(intents(subject,'ENTRY_PREVIEW').length,1);
 subject=model({state:subject.exportState()});assert.equal(subject.submit(preview('signal2')).accepted,false);
 assert.equal(subject.reconcileEntry({reference:'signal1',status:'NOT_FOUND',filledQuantity:0}).accepted,true);
 assert.equal(subject.submit(preview()).code,'DUPLICATE_SIGNAL');assert.equal(intents(subject,'ENTRY_PREVIEW').length,1);
 assert.equal(subject.submit(preview('signal2')).accepted,true);
});

test('partial entry fills retain actual weighted entry and protection quantity through restart',()=>{
 let subject=model();subject.submit(preview());subject.entryFill({reference:'signal1',orderId:'entry1',fillId:'a',quantity:.3,price:99,confirmed:true});
 assert.equal(position(subject).entrySettled,false);assert.equal(position(subject).quantityRemaining,.3);
 assert.equal(subject.acknowledgeExit({reference:'signal1',role:'TP1',orderId:'TP1',quantity:.4,reduceOnly:true}).accepted,false);
 subject=model({state:subject.exportState()});
 assert.equal(subject.entryFill({reference:'signal1',orderId:'entry1',fillId:'b',quantity:.7,price:101,confirmed:true}).accepted,true);
 assert.ok(Math.abs(position(subject).averageEntry-100.4)<1e-10);
 assert.equal(subject.observeProtection({reference:'signal1',orderId:'oldStop',price:98,quantity:.3,reduceOnly:true,active:true}).accepted,false);
 assert.equal(subject.snapshot().mockEntryAllowed,false,'unprotected filled size blocks further entries');
});

test('partial TP1 does not move stop, full40percent requests one replacement at confirmed average entry',()=>{
 const subject=open(model());assert.equal(position(subject).averageEntry,100);
 assert.equal(exit(subject,.1).accepted,true);assert.equal(position(subject).quantityRemaining,.9);
 assert.equal(intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,0);
 assert.equal(exit(subject,.3,{fillId:'tp1b'}).accepted,true);
 const requests=intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE');assert.equal(requests.length,1);
 assert.equal(requests[0].price,100);assert.ok(Math.abs(requests[0].quantity-.6)<1e-10);
 assert.equal(position(subject).protection.orderId,'oldStop');assert.equal(position(subject).breakeven.moved,false);
 assert.equal(exit(subject,.3,{fillId:'tp1b'}).code,'DUPLICATE_FILL');assert.equal(intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,1);
});

test('replacement ACK is insufficient; old stop cancellation is proposed only after active reduce-only requery',()=>{
 const subject=open(model());exit(subject,.4);const requestId=position(subject).breakeven.requestId;
 assert.equal(subject.replacementAck({reference:'signal1',requestId,newOrderId:'newStop'}).accepted,true);
 assert.equal(position(subject).breakeven.moved,false);assert.equal(position(subject).protection.orderId,'oldStop');
 assert.equal(intents(subject,'CANCEL_OLD_PROTECTION_AFTER_VERIFICATION').length,0);
 for(const patch of [{reduceOnly:false},{active:false},{price:99},{quantity:.5},{orderId:'unexpected'}])
  assert.equal(subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,reduceOnly:true,active:true,...patch}).accepted,false);
 assert.equal(subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,reduceOnly:true,active:true}).accepted,true);
 assert.equal(position(subject).breakeven.moved,true);assert.equal(position(subject).protection.orderId,'newStop');
 assert.equal(intents(subject,'CANCEL_OLD_PROTECTION_AFTER_VERIFICATION').length,1);
 assert.equal(subject.observeCancelled({reference:'signal1',orderId:'oldStop'}).accepted,true);
 assert.equal(subject.snapshot().mockEntryAllowed,true);
});

test('replace failure or timeout retains the old stop and never proposes blind replacement retries',()=>{
 for(const unknown of [true,false]){
  const subject=open(model());exit(subject,.4);const requestId=position(subject).breakeven.requestId;
  const result=subject.replacementFailure({reference:'signal1',requestId,unknown});
  assert.equal(result.oldProtectionRetained,true);assert.equal(result.retryAllowed,false);
  assert.equal(position(subject).protection.orderId,'oldStop');assert.equal(subject.snapshot().mockEntryAllowed,false);
  assert.equal(intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,1);assert.equal(intents(subject,'CANCEL_OLD_PROTECTION_AFTER_VERIFICATION').length,0);
  assert.equal(subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,active:true,reduceOnly:true}).accepted,true);
  assert.equal(position(subject).breakeven.moved,true);
 }
});

test('restart after partial TP1 or replacement verification preserves fill deduplication and exactly-once movement',()=>{
 let subject=open(model());exit(subject,.2);subject=model({state:subject.exportState()});
 assert.equal(exit(subject,.2).code,'DUPLICATE_FILL');exit(subject,.2,{fillId:'tp1b'});
 const requestId=position(subject).breakeven.requestId;
 subject.replacementAck({reference:'signal1',requestId,newOrderId:'newStop'});subject=model({state:subject.exportState()});
 subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,active:true,reduceOnly:true});
 const remainingBeforeRestart=position(subject).quantityRemaining;
 subject=model({state:subject.exportState()});
 subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,active:true,reduceOnly:true});
 assert.equal(intents(subject,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,1);assert.equal(intents(subject,'CANCEL_OLD_PROTECTION_AFTER_VERIFICATION').length,1);
 assert.equal(position(subject).quantityRemaining,remainingBeforeRestart);assert.ok(Math.abs(remainingBeforeRestart-.6)<1e-10);
});

test('TP2 and TP3 use remaining quantity and a closing fill schedules reduce-only cleanup instead of a reverse position',()=>{
 const subject=open(model());exit(subject,.4);assert.equal(exit(subject,.35,{role:'TP2',fillId:'tp2',price:120}).accepted,true);
 assert.equal(exit(subject,.25,{role:'TP3',fillId:'tp3',price:130}).accepted,true);
 assert.equal(position(subject).quantityRemaining,0);assert.equal(position(subject).closed,true);
 assert.equal(intents(subject,'CLEANUP_REMAINING_REDUCE_ONLY_ORDERS').length,1);
 assert.equal(exit(subject,.25,{role:'TP3',fillId:'tp3',price:130}).code,'DUPLICATE_FILL');
 assert.equal(exit(subject,.1,{role:'TP3',fillId:'extra',price:130}).accepted,false);assert.equal(position(subject).quantityRemaining,0);
 const requestId=position(subject).breakeven.requestId;
 assert.equal(subject.observeProtection({reference:'signal1',requestId,orderId:'lateNewStop',price:100,quantity:.6,active:true,reduceOnly:true}).accepted,true);
 assert.equal(intents(subject,'CLEANUP_LATE_PROTECTION_AFTER_CLOSE').length,1);assert.equal(position(subject).breakeven.moved,false);
});

test('a TP2 concurrent fill reduces residual protection requirements and never increases remaining exposure',()=>{
 const subject=open(model());exit(subject,.4);const requestId=position(subject).breakeven.requestId;
 exit(subject,.35,{role:'TP2',fillId:'tp2',price:120});assert.ok(Math.abs(position(subject).quantityRemaining-.25)<1e-10);
 subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,active:true,reduceOnly:true});
 assert.equal(position(subject).breakeven.moved,true);assert.ok(Math.abs(position(subject).quantityRemaining-.25)<1e-10);
});

test('SHORT breakeven follows confirmed average fill; an unfavorable stop gap is recorded as an exit price, never filled at the desired stop',()=>{
 const subject=open(model(),{direction:'SHORT'});exit(subject,.4,{price:90});const requestId=position(subject).breakeven.requestId;
 subject.observeProtection({reference:'signal1',requestId,orderId:'newStop',price:100,quantity:.6,active:true,reduceOnly:true});
 assert.equal(subject.exitFill({reference:'signal1',role:'STOP',orderId:'newStop',fillId:'stopGap',quantity:.6,price:103,confirmed:true,reduceOnly:true}).accepted,true);
 assert.equal(position(subject).quantityRemaining,0);assert.equal(subject.exportState().seenFills['newStop:stopGap'].price,103);
 assert.equal(subject.snapshot().pnlCalculationStatus,'NOT_CALCULATED_BY_ORDER_SAFETY_MODEL');
});

test('BE OFF preserves the original stop and cost recovery requires explicitly reviewed mock inputs',()=>{
 const disabled=open(model(),{options:{moveStopToBreakeven:false}});exit(disabled,.4);
 assert.equal(intents(disabled,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE').length,0);assert.equal(position(disabled).protection.price,98);
 assert.equal(model().submit(preview(),{breakevenMode:'COST_COVERED',costCoveredPrice:100.2}).accepted,false);
 const covered=open(model(),{options:{breakevenMode:'COST_COVERED',costCoveredPrice:100.2,costProof:checked()}});exit(covered,.4);
 assert.equal(intents(covered,'REPLACE_PROTECTION_KEEP_OLD_ACTIVE')[0].price,100.2);
});

test('risk limits, kill switch, uncertain persistence and position mismatch block new entry while existing reduce-only exits remain available',()=>{
 for(const risk of [{killSwitch:true},{dailyLossUSDT:18},{storageHealthy:false},{positionSynchronized:false}]){
  let subject=open(model());subject.setRiskState(risk);subject=model({state:subject.exportState()});
  assert.equal(subject.submit(preview('signal2')).accepted,false);assert.equal(exit(subject,.4).accepted,true);
 }
 assert.equal(model({limits:{maxPositions:1}}).submit(preview()).accepted,true);
 const capped=open(model({limits:{maxPositions:1}}));assert.equal(capped.submit(preview('signal2')).code,'POSITION_LIMIT');
 const exposure=open(model({limits:{maxTotalNotionalUSDT:150}}));assert.equal(exposure.submit(preview('signal2')).code,'TOTAL_EXPOSURE_LIMIT');
 assert.equal(model().submit({...preview(),plannedRiskUSDT:7}).code,'RISK_OR_LEVERAGE_LIMIT');
 assert.equal(model().submit(preview(),{leverage:4}).code,'RISK_OR_LEVERAGE_LIMIT');
 const mismatch=open(model());assert.equal(mismatch.reconcilePosition({reference:'signal1',quantityRemaining:2}).code,'POSITION_MISMATCH');
 assert.equal(mismatch.submit(preview('signal2')).accepted,false);
});

test('reduce-only false, conflicting fill IDs and cancellation of the current stop fail closed',()=>{
 const subject=open(model());assert.equal(exit(subject,.4,{reduceOnly:false}).accepted,false);
 assert.equal(subject.acknowledgeExit({reference:'signal1',role:'CLOSE',orderId:'close',quantity:1,reduceOnly:false}).accepted,false);
 exit(subject,.1);assert.equal(exit(subject,.2).code,'CONFLICTING_FILL_ID');assert.equal(position(subject).quantityRemaining,.9);
 assert.equal(subject.snapshot().mockEntryAllowed,false);
 const cancelled=open(model());assert.equal(cancelled.observeCancelled({reference:'signal1',orderId:'oldStop'}).code,'PROTECTION_REMOVED_RECONCILIATION_REQUIRED');
 assert.equal(cancelled.submit(preview('signal2')).accepted,false);
});

test('partial-entry cancellation settles the actual quantity and manual CLOSE cannot overshoot it',()=>{
 const subject=model();subject.submit(preview());subject.entryFill({reference:'signal1',orderId:'entry1',fillId:'a',quantity:.5,price:100,confirmed:true});
 assert.equal(subject.reconcileEntry({reference:'signal1',orderId:'entry1',status:'CANCELLED',filledQuantity:.5}).accepted,true);
 subject.observeProtection({reference:'signal1',orderId:'oldStop',price:98,quantity:.5,active:true,reduceOnly:true});
 assert.equal(subject.acknowledgeExit({reference:'signal1',role:'TP1',orderId:'TP1',quantity:.2,reduceOnly:true}).accepted,true);
 assert.equal(subject.acknowledgeExit({reference:'signal1',role:'CLOSE',orderId:'close',quantity:.6,reduceOnly:true}).accepted,false);
 assert.equal(subject.acknowledgeExit({reference:'signal1',role:'CLOSE',orderId:'close',quantity:.5,reduceOnly:true}).accepted,true);
 assert.equal(subject.exitFill({reference:'signal1',role:'CLOSE',orderId:'close',fillId:'close1',quantity:.5,price:99,confirmed:true,reduceOnly:true}).accepted,true);
 assert.equal(position(subject).closed,true);assert.equal(position(subject).quantityRemaining,0);
});

test('late entry timeout cannot erase already confirmed fills and atomic mode does not cancel the same stop order',()=>{
 const capabilities=caps();capabilities.safeStopReplace.mode='ATOMIC_MODIFY';const subject=open(model({capabilities}));
 assert.equal(subject.timeout('signal1').code,'ENTRY_ALREADY_SETTLED');exit(subject,.4);const requestId=position(subject).breakeven.requestId;
 subject.replacementAck({reference:'signal1',requestId,newOrderId:'oldStop'});
 assert.equal(subject.observeProtection({reference:'signal1',requestId,orderId:'oldStop',price:100,quantity:.6,active:true,reduceOnly:true}).accepted,true);
 assert.equal(position(subject).breakeven.moved,true);assert.equal(intents(subject,'CANCEL_OLD_PROTECTION_AFTER_VERIFICATION').length,0);
});

test('corrupt recovery state is rejected without resetting its source or exposing arbitrary fields',()=>{
 const subject=open(model());exit(subject,.1);const original=subject.exportState(),before=JSON.stringify(original);
 for(const mutate of [state=>{state.dataSource='LIVE'},state=>{state.entries.signal1.quantityRemaining=.8},state=>{state.sequence=0},
  state=>{state.arbitraryToken='never-output'},state=>{state.entries.signal1.breakeven.arbitraryToken='never-output'}]){
  const broken=structuredClone(original);mutate(broken);assert.throws(()=>model({state:broken}),/MOCK/);
 }
 assert.equal(JSON.stringify(original),before);assert.equal(model({state:original}).snapshot().liveOrdersEnabled,false);
});
