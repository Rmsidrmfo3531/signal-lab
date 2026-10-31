import test from 'node:test';
import assert from 'node:assert/strict';
import {roundOrangeXDecimal,floorOrangeXQuantity,roundOrangeXPrice,reviewOrangeXQuantity} from '../orangex_contract_validation.mjs';

const NOW=Date.parse('2026-10-31T00:59:19.246Z'),doc='https://openapi-docs.orangex.com/';
const raw=value=>({value,units:'UNVERIFIED'});
const reviewed=extra=>({status:'VERIFIED',officialDocumentURL:doc,reviewedAt:NOW-1,...extra});
function fixture({quantityUnit='BASE_ASSET',contractSize=.1}={}){
 const market={dataSource:'SYNTHETIC_FIXTURE',asset:'SOL',instrumentName:'SOL-USDT-PERPETUAL',actualInstrumentName:'SOL-USDT-PERPETUAL',
  listingObserved:true,active:true,listingDomainEligible:true,listingSourceCurrency:'BTC',
  contractFields:{kind:raw('perpetual'),contract_size:raw(contractSize),min_qty:raw(1),min_trade_amount:raw(.1),min_notional:raw(100),tick_size:raw(.01)}};
 const proof={listing:reviewed({instrumentName:market.instrumentName,kind:'PERPETUAL',active:true,tradingArea:'BTC'}),
  contractSize:reviewed({rawField:'contract_size',value:contractSize,unit:'BASE_PER_CONTRACT'}),quantityUnit:reviewed({value:quantityUnit}),
  minimumQuantity:reviewed({rawField:'min_qty',value:1,unit:quantityUnit,meaning:'MINIMUM_ORDER_QUANTITY'}),
  quantityIncrement:reviewed({rawField:'min_trade_amount',value:.1,unit:quantityUnit,meaning:'ORDER_QUANTITY_INCREMENT'}),
  minNotional:reviewed({rawField:'min_notional',value:100,unit:'USDT'}),priceTick:reviewed({rawField:'tick_size',value:.01,unit:'USDT'}),
  notionalFormula:reviewed({contractType:'LINEAR_PERPETUAL',quantityUnit,contractSizeBase:contractSize,priceCurrency:'USDT',notionalCurrency:'USDT',settlementCurrency:'USDT'})};
 return {market,proof};
}
const review=(f,quantity,price=100)=>reviewOrangeXQuantity(f.market,{proof:f.proof,quantity,price,now:NOW});
const check=(result,id)=>result.checks.find(row=>row.id===id)?.status;

test('exact quantity grids keep a minimum quantity distinct from the increment and never round upward to enter',()=>{
 assert.equal(floorOrangeXQuantity('1.29','.1'),'1.2');assert.equal(floorOrangeXQuantity('.99','.1'),'0.9');
 const f=fixture();assert.equal(review(f,'1.2').constraintStatus,'PASS');
 const tooSmall=review(f,floorOrangeXQuantity('.99','.1'));assert.equal(tooSmall.quantity,'0.9');assert.equal(check(tooSmall,'MINIMUM_QUANTITY'),'FAIL');
 const offGrid=review(f,'1.25');assert.equal(check(offGrid,'QUANTITY_GRID'),'FAIL');assert.equal(offGrid.constraintStatus,'FAIL');
 f.market.contractFields.min_qty=raw(1);f.proof.minimumQuantity.value=1;
 f.market.contractFields.min_trade_amount=raw(.3);f.proof.quantityIncrement.value=.3;
 assert.equal(check(review(f,'1'),'QUANTITY_GRID'),'FAIL');assert.equal(review(f,'1.2').constraintStatus,'PASS');
});

test('base-quantity and contract-quantity notional calculations differ by the reviewed contract size',()=>{
 const base=review(fixture({quantityUnit:'BASE_ASSET',contractSize:.1}),'2'),contracts=review(fixture({quantityUnit:'CONTRACT',contractSize:.1}),'2');
 assert.equal(base.notional,'200');assert.equal(base.constraintStatus,'PASS');
 assert.equal(contracts.notional,'20');assert.equal(check(contracts,'MINIMUM_NOTIONAL'),'FAIL');
 assert.equal(review(fixture({quantityUnit:'CONTRACT',contractSize:.1}),'10').constraintStatus,'PASS');
 for(const result of [base,contracts]){assert.equal(result.status,'NOT_READY');assert.equal(result.executionAllowed,false);assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false)}
});

test('missing contract size, quantity unit, linear type or USDT meaning never become a value of one or a zero cost',()=>{
 for(const mutate of [
  f=>{delete f.market.contractFields.contract_size},f=>{delete f.proof.quantityUnit},f=>{delete f.proof.notionalFormula},
  f=>{f.proof.minNotional.unit='UNVERIFIED'},f=>{f.proof.notionalFormula.contractType='INVERSE_PERPETUAL'},
  f=>{f.proof.notionalFormula.settlementCurrency='BTC'}
 ]){const f=fixture();mutate(f);const result=review(f,'10');assert.notEqual(result.constraintStatus,'PASS');assert.equal(result.notional,null);assert.equal(result.status,'NOT_READY')}
 const f=fixture();f.proof.notionalFormula.officialDocumentURL='https://secret@example.invalid/?token=never-export';
 const result=review(f,'10');assert.equal(result.constraintStatus,'FAIL');assert.doesNotMatch(JSON.stringify(result),/never-export|secret@example/);
});

test('min_trade_amount cannot be claimed as the minimum quantity or min_qty borrowed as the increment',()=>{
 const f=fixture();f.proof.minimumQuantity=reviewed({rawField:'min_trade_amount',value:.1,unit:'BASE_ASSET',meaning:'MINIMUM_ORDER_QUANTITY'});
 assert.equal(review(f,'10').constraintStatus,'FAIL');
 const other=fixture();other.proof.quantityIncrement=reviewed({rawField:'min_qty',value:1,unit:'BASE_ASSET',meaning:'ORDER_QUANTITY_INCREMENT'});
 assert.equal(review(other,'10').constraintStatus,'FAIL');
 const conflict=fixture();conflict.market.contractFields.qty_step=raw(.001);
 conflict.proof.quantityIncrement=reviewed({rawField:'qty_step',value:.001,unit:'BASE_ASSET',meaning:'ORDER_QUANTITY_INCREMENT'});
 const blocked=review(conflict,'1.001');assert.equal(blocked.constraintStatus,'UNVERIFIED');
 assert.equal(blocked.notional,null);assert.equal(blocked.executionAllowed,false);
});

test('limit prices preserve maximum buy and minimum sell limits while risk-plan rounding is separately conservative',()=>{
 assert.equal(roundOrangeXPrice('100.011','.01',{purpose:'LIMIT_PRICE',side:'BUY'}).price,'100.01');
 assert.equal(roundOrangeXPrice('100.011','.01',{purpose:'LIMIT_PRICE',side:'SELL'}).price,'100.02');
 for(const [direction,leg,expected]of [['LONG','ENTRY','100.02'],['LONG','STOP','100.01'],['LONG','TARGET','100.02'],
  ['SHORT','ENTRY','100.01'],['SHORT','STOP','100.02'],['SHORT','TARGET','100.01']]){
  const result=roundOrangeXPrice('100.011','.01',{purpose:'RISK_PLAN',direction,leg});assert.equal(result.price,expected);
  assert.equal(result.riskMustBeRecalculated,true);assert.equal(result.exchangeStopTriggerVerified,false);assert.equal(result.executionAllowed,false);
 }
 assert.throws(()=>roundOrangeXPrice(100,.01,{side:'BUY'}),/PURPOSE_REQUIRED/);
});

test('decimal operations do not silently accept binary drift or excessive precision and invalid prices',()=>{
 assert.equal(roundOrangeXDecimal('0.30000000000000004','.1','DOWN'),'0.3');
 assert.equal(roundOrangeXDecimal('1.23456789','1e-8','DOWN'),'1.23456789');
 assert.equal(roundOrangeXDecimal('1.234567891','1e-8','UP'),'1.2345679');
 const f=fixture();assert.equal(check(review(f,'1.1000000000000001'),'QUANTITY_GRID'),'FAIL');
 assert.equal(check(review(f,'2','100.001'),'PRICE_GRID'),'FAIL');
 for(const value of [0,-1,NaN,Infinity,'1e999','x','1'.repeat(81)])assert.throws(()=>roundOrangeXDecimal(value,'.1'));
 for(const value of [0,-1,'not-a-price'])assert.equal(review(f,'2',value).constraintStatus,'FAIL');
});

test('the actual 2026-10-31 observation keeps SOL minimum-one/increment-point-one and remains blocked without invented rules',()=>{
 // The portable regression uses the exact publicly observed fields, labelled as
 // a copied observation summary. It does not require an uploaded workspace path.
 const observation={asset:'SOL',instrumentName:'SOL-USDT-PERPETUAL',actualInstrumentName:'SOL-USDT-PERPETUAL',listingObserved:true,active:true,
  listingSourceCurrency:'PERPETUAL',listingDomainEligible:false,contractFields:{kind:raw('perpetual'),min_qty:raw(1),min_trade_amount:raw(.1),min_notional:raw(100),tick_size:raw(.01)}};
 const before=structuredClone(observation),result=reviewOrangeXQuantity(observation,{quantity:'1.1',price:'96.71',now:NOW});
 assert.equal(result.constraintStatus,'UNVERIFIED');assert.equal(result.status,'NOT_READY');assert.equal(result.notional,null);
 assert.deepEqual(observation,before);assert.equal(result.source,'SUPPLIED_OBSERVATION_SOURCE_UNVERIFIED');
 assert.ok(result.requirements.some(row=>row.id==='CONTRACT_SIZE'&&row.status==='UNVERIFIED'));
 assert.ok(result.requirements.some(row=>row.id==='QUANTITY_UNIT'&&row.status==='UNVERIFIED'));
});
