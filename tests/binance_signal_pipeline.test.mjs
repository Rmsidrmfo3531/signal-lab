import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSignal} from '../signal_pipeline.mjs';
import {estimateBinanceExecution} from '../binance_execution.mjs';
const NOW=Date.now();
function fixture(){
 const market={symbol:'SOLUSDT',quoteAsset:'USDT',status:'TRADING',contractType:'PERPETUAL',filters:{PRICE_FILTER:{tickSize:'.01'},LOT_SIZE:{stepSize:'.01',minQty:'.01'},MIN_NOTIONAL:{notional:'5'}}},
  book={T:NOW-100,bids:[['99.99','100']],asks:[['100.01','100']]},row={symbol:'SOLUSDT',direction:'LONG',entry:100.01,stop:98,atr:2,
   pattern:'박스권 상단 돌파',patternConfirmed:true,patternConfirmedAt:NOW-1000,scannedAt:NOW,score:90,
   technicalValidation:{passed:true},quality:{passed:true,failed:[],validUntil:NOW+60000},managementVersion:'VOLUME_PROFILE_V1'},
  size=estimateBinanceExecution({signal:row,market,book,now:NOW});
 row.targetPlan={ok:true,targets:[106,110,114],quantity:size.quantity,estimatedNetRR:2.5,
  profileEvidence:{receivedAt:NOW-500,windowEnd:NOW-500},costAssumptions:{takerRate:.0006,spreadBps:.2,slippageBps:5,fundingRate:.0003}};
 [row.target1,row.target2,row.target3]=row.targetPlan.targets;
 return {row,context:{analysisVenue:'BINANCE',market,book,verified:true,venueConnected:true,price:100.01,priceAt:NOW-100,now:NOW}};
}
test('single-score Binance final approval needs no other exchange and never becomes live trade approval',()=>{
 const {row,context}=fixture(),decision=evaluateSignal(row,context);
 assert.equal(decision.ready,true,decision.reasons.join());assert.equal(decision.analysisVenue,'BINANCE');
 assert.equal(decision.tradeApproval,false);assert.equal(decision.orangeXApproval,false);
 row.technicalValidation.passed=false;assert.equal(evaluateSignal(row,context).technical,false);
 row.technicalValidation.passed=true;row.score=null;const unavailable=evaluateSignal(row,context);
 assert.equal(unavailable.ready,false);assert.match(unavailable.reasons.join(),/평가 불가/);
});
test('profile absence or expiry holds an otherwise90pointsetup without inventing R targets',()=>{
 const {row,context}=fixture();row.targetPlan=null;
 assert.equal(evaluateSignal(row,context).technical,true);assert.equal(evaluateSignal(row,context).ready,false);
 assert.ok(evaluateSignal(row,context).reasons.includes('TP_PROFILE_UNAVAILABLE'));
 const fresh=fixture();fresh.row.targetPlan.profileEvidence.windowEnd=NOW-90001;fresh.row.targetPlan.profileEvidence.receivedAt=NOW-90001;
 assert.equal(evaluateSignal(fresh.row,fresh.context).ready,false);
 const oldWindow=fixture();oldWindow.row.targetPlan.profileEvidence.windowEnd=NOW-90001;
 assert.equal(evaluateSignal(oldWindow.row,oldWindow.context).ready,false,'a fresh receipt cannot refresh an expired trade window');
 const futureWindow=fixture();futureWindow.row.targetPlan.profileEvidence.windowEnd=NOW+1;
 assert.equal(evaluateSignal(futureWindow.row,futureWindow.context).ready,false);
});
test('an old target-plan quantity or reward ratio cannot borrow a smaller fresh risk estimate to pass',()=>{
 const {row,context}=fixture();row.targetPlan.quantity*=2;
 assert.equal(evaluateSignal(row,context).ready,false);assert.match(evaluateSignal(row,context).reasons.join(),/최대 손실/);
 const near=fixture();near.row.targetPlan.targets=[100.2,100.3,100.4];near.row.target1=100.2;
 assert.equal(evaluateSignal(near.row,near.context).ready,false,'cached estimatedNetRR2.5 cannot override current target costs');
 assert.ok(evaluateSignal(near.row,near.context).execution.estimatedNetRR<1.8);
});

test('a fresh executable book that crossed the stop or moved outside the original entry zone cannot borrow an unchanged ticker approval',()=>{
 for(const direction of ['LONG','SHORT']){
  const {row,context}=fixture();row.direction=direction;row.stop=direction==='LONG'?98:102;
  row.targetPlan.targets=direction==='LONG'?[106,110,114]:[94,90,86];[row.target1,row.target2,row.target3]=row.targetPlan.targets;
  row.targetPlan.quantity=2;
  const invalidQuote=direction==='LONG'?97.99:102.01;
  context.book={T:NOW-100,bids:[[String(invalidQuote-.01),'100']],asks:[[String(invalidQuote),'100']]};
  const crossed=evaluateSignal(row,context);assert.equal(crossed.ready,false,direction+' executable quote invalidated the stop');
  assert.ok(crossed.execution.reasons.includes('PROTECTIVE_STOP_INVALID_AT_CURRENT_BOOK'));
  const moved=fixture();moved.row.direction=direction;moved.row.stop=row.stop;moved.row.targetPlan.targets=row.targetPlan.targets;
  moved.row.targetPlan.quantity=2;
  const far=direction==='LONG'?98.2:101.8;
  moved.context.book={T:NOW-100,bids:[[String(far-.01),'100']],asks:[[String(far),'100']]};
  const chased=evaluateSignal(moved.row,moved.context);assert.equal(chased.ready,false);
  assert.ok(chased.execution.reasons.includes('EXECUTABLE_BOOK_OUTSIDE_ENTRY_ZONE'));
 }
 const drift=fixture();drift.row.referenceEntry=99.6;
 assert.equal(evaluateSignal(drift.row,drift.context).ready,false,'repricing cannot erase the original pattern entry zone');
});
