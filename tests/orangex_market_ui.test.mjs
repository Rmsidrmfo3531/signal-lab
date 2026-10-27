import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orangeXContractDetails,orangeXView,renderOrangeX} from '../public/orangex.js';

// Synthetic field-shape fixtures; no Windows or exchange response is claimed.
const NOW=Date.parse('2026-10-27T08:00:00Z');
const raw=value=>({value,units:'UNVERIFIED',source:'synthetic fixture'});
const row=()=>({symbol:'BTCUSDT',instrumentName:'BTC-USDT-PERPETUAL',actualInstrumentName:'BTC-USDT-PERPETUAL',
 instrumentVerified:false,tradable:false,listingObserved:true,active:true,listingStatus:'OBSERVED_ACTIVE',
 bid:100,ask:100.01,bids:[[100,.123]],asks:[[100.01,.456]],spreadBps:1,
 priceAt:NOW,fresh:true,markPrice:100.005,markPriceAt:NOW,markPriceFresh:true,minQty:null,qtyStep:null,priceTick:null,
 contractFields:{min_trade_amount:raw('0.001'),min_qty:raw('0.0001'),min_notional:raw(5),tick_size:raw('0.01'),
  contract_size:raw('0.0000000001'),qty_step:raw('0.00001'),quantity_step:raw('0.0000001'),quantity_increment:raw('0.000001'),
  maker_fee:raw('0'),taker_fee:raw('0.0005'),maker:raw('0.012'),taker:raw('0.034'),maker_fee_rate:raw('0.00012'),taker_fee_rate:raw('0.00034'),
  base_currency:raw('USDT'),quote_currency:raw('BTC')},
 precision:{priceGrid:'MATCH',quantityGrid:'UNVERIFIED',priceBasis:'tick_size',quantityBasis:null,unitsVerified:false},
 binanceComparison:{status:'OBSERVATION_ONLY',referenceSymbol:'BTCUSDT',price:100.002,priceAt:NOW,gapBps:.3,mappingVerified:false}});
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');

test('readonly contract details retain the existing market table, legacy panels and responsive navigation without new controls',()=>{
 const section=html.slice(html.indexOf('<section id="orangex"'),html.indexOf('<section id="tradfi"'));
 assert.match(section,/id="orangexContractDetails"/);assert.match(section,/colspan="11"/);
 assert.doesNotMatch(section,/<(?:input|form|select)\b/);assert.equal((section.match(/<button\b/g)||[]).length,1);
 for(const id of ['paper','scanner','tradfi','news','chartPanel','orangexPositions','orangexPnl'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(css,/\.orangex-contract-grid\{grid-template-columns:1fr\}/);
 assert.match(css,/\.mobile-bottom-nav\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
});

test('raw minimum, trade amount and quantity increment remain separate observations with exact small values',()=>{
 const detail=orangeXContractDetails([row()],{now:NOW,dataSource:'SYNTHETIC_FIXTURE'});
 for(const [key,value]of [['min_trade_amount','0.001'],['min_qty','0.0001'],['min_notional','5'],['qty_step','0.00001'],
  ['quantity_step','0.0000001'],['quantity_increment','0.000001'],['contract_size','0.0000000001'],
  ['maker','0.012'],['taker','0.034'],['maker_fee_rate','0.00012'],['taker_fee_rate','0.00034']]){
  assert.match(detail,new RegExp(`<dt>${key}</dt><dd>${value.replaceAll('.','\\.')}`));
 }
 assert.match(detail,/필드 의미·단위 미검증/);assert.match(detail,/최소값과 주문 증분은 서로 대체하지 않습니다/);
 assert.match(detail,/가격 관측 호가 격자 일치/);assert.match(detail,/수량 관측 격자 미검증/);
 const view=orangeXView({markets:[row()]});assert.equal((view.markets.match(/>미검증<\/td>/g)||[]).length,3);
 assert.doesNotMatch(view.markets,/>거래 가능</);
});

test('raw currency definitions and fee values do not become Binance mapping, percent fees or bps fees',()=>{
 const detail=orangeXContractDetails([row()],{now:NOW});
 assert.match(detail,/<dt>base_currency<\/dt><dd>USDT/);assert.match(detail,/<dt>quote_currency<\/dt><dd>BTC/);
 assert.match(detail,/<dt>maker_fee<\/dt><dd>0<small>/);assert.match(detail,/<dt>taker_fee<\/dt><dd>0\.0005<small>/);
 assert.match(detail,/거래소 정의 미검증/);assert.match(detail,/수수료|Maker·Taker/);
 assert.match(detail,/단위가 확인되지 않아 %·bp·예상 비용으로 환산하지 않습니다/);
 assert.match(detail,/대응 계약 미검증/);assert.doesNotMatch(detail,/대응 계약 확인/);
});

test('Mark uses its own timestamp and freshness rather than borrowing the book clock',()=>{
 for(const markPriceAt of [null,undefined,NOW-90001,NOW+60000]){
  const value={...row(),markPriceAt};
  const detail=orangeXContractDetails([value],{now:NOW});assert.match(detail,/Mark 시각 만료\/미확인/);
  assert.doesNotMatch(detail,/Mark 시각 확인/);
 }
 assert.match(orangeXContractDetails([row()],{now:NOW}),/Mark 시각 확인/);
 assert.match(orangeXContractDetails([{...row(),markPriceFresh:false}],{now:NOW}),/Mark 시각 만료\/미확인/);
 assert.match(orangeXContractDetails([{...row(),markPrice:null}],{now:NOW}),/Mark 미확인/);
});

test('listing observations distinguish active, inactive and unavailable without approving orders',()=>{
 assert.match(orangeXContractDetails([row()],{now:NOW}),/상장·활성 관측 · 주문 차단/);
 assert.match(orangeXContractDetails([{...row(),active:false}],{now:NOW}),/상장·비활성 관측 · 주문 차단/);
 assert.match(orangeXContractDetails([{...row(),active:null}],{now:NOW}),/상장 관측 · 활성 미확인/);
 assert.match(orangeXContractDetails([{...row(),listingObserved:false,active:null}],{now:NOW}),/상장 목록 미관측/);
});

test('data-source labels distinguish synthetic tests and replay from a public response without independent verification',()=>{
 assert.match(orangeXContractDetails([row()],{dataSource:'SYNTHETIC_FIXTURE',now:NOW}),/합성 Mock 자료 · 실제 시장 관측 아님/);
 assert.match(orangeXContractDetails([row()],{dataSource:'WINDOWS_DIAGNOSTIC_REPLAY',now:NOW}),/Windows 진단 재생 · 현재 실시간 응답 아님/);
 assert.match(orangeXContractDetails([row()],{dataSource:'REAL_PUBLIC_READ_ONLY',now:NOW}),/공개 조회 응답 · 독립 출처 미검증/);
 assert.match(orangeXContractDetails([row()],{dataSource:'unknown-private-provider',now:NOW}),/자료 출처 미확인/);
});

test('contract detail renderer escapes text, ignores provider-only fields and never invents missing costs or units',()=>{
 const item=row(),secret='synthetic-token-do-not-render';item.actualInstrumentName='<img src=x onerror=alert(1)>';
 item.access_token=secret;item.contractFields.access_token=raw(secret);item.contractFields.min_qty=raw([]);
 item.contractFields.quote_currency=raw(secret);item.fees={makerBps:999,secret};
 const detail=orangeXContractDetails([item],{now:NOW});assert.doesNotMatch(detail,/<img/);assert.match(detail,/&lt;img/);
 assert.doesNotMatch(detail,new RegExp(secret));assert.match(detail,/<dt>min_qty<\/dt><dd>미관측/);assert.doesNotMatch(detail,/999/);
 assert.match(orangeXContractDetails([]),/누락 값을 계산하거나 수수료를 0으로 채우지/);
 const nodes=new Map([['orangexContractDetails',{innerHTML:''}]]);
 renderOrangeX({markets:[row()],dataSource:'SYNTHETIC_FIXTURE'},{root:{getElementById:id=>nodes.get(id)}});
 assert.match(nodes.get('orangexContractDetails').innerHTML,/합성 Mock/);
});
