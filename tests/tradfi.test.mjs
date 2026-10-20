import test from 'node:test';
import assert from 'node:assert/strict';
import {extractTradFiMarkets,extractTradFiSwaps,swapFundingUSD,tradfiQuoteVerdict,chartUrlForSwap} from '../tradfi.mjs';
import {normalizeTwelveSeries,analyzeTradFi} from '../tradfi_signal.mjs';
import {fetchTwelveSeries} from '../tradfi_feed.mjs';
const now=Date.parse('2026-10-19T12:00:00Z');
const q={updated_at:new Date(now-90000).toISOString(),size_1k:{bid:'3999.00',ask:'4001.00'}};
const swap=(ticker='XAU-SWAP',overrides={})=>({ticker,contract_type:'swap',name:'Swap on Gold Spot',mark_price:'4000',volume_24h:'24000000',funding:{last:{interval_long_rate:'0.0001',interval_short_rate:'0.00007'}},quotes:q,...overrides});
const payload={listings:[swap(),{ticker:'BTC-PERP',contract_type:'perpetual',mark_price:'83000'}, {ticker:'XAU-PERP',contract_type:'perpetual',name:'Gold',mark_price:'4000',quotes:q,funding:{last:{interval_rate:'0.0002'}}},swap('US100-SWAP',{name:'Swap on US Non-Financial 100'}),swap('XAG-SWAP',{name:'Swap on Silver Spot'})]};
test('SWAP and known TradFi PERP are shown; BTC cryptocurrency never mixed',()=>{
 const rows=extractTradFiMarkets(payload,{now});assert.equal(rows.length,4);assert.ok(rows.some(x=>x.ticker==='XAU-PERP'));assert.ok(!rows.some(x=>x.ticker==='BTC-PERP'));
 assert.equal(extractTradFiSwaps(payload,{now}).length,3);
});
test('live listings only; no phantom US500 when not in payload',()=>{
 const rows=extractTradFiMarkets(payload,{now});assert.ok(!rows.some(x=>x.base==='US500'));
});
test('TradFi swap funding uses different long and short rates',()=>{
 const x=extractTradFiSwaps(payload,{now}).find(r=>r.base==='XAU');
 assert.ok(Math.abs(swapFundingUSD(x,'LONG',1000)-(-.1))<1e-8);
 assert.ok(Math.abs(swapFundingUSD(x,'SHORT',1000)-(+.07))<1e-8);
});
test('TradFi PERP funding uses symmetric payer/receiver sign',()=>{
 const x=extractTradFiMarkets(payload,{now}).find(r=>r.ticker==='XAU-PERP');
 assert.equal(swapFundingUSD(x,'LONG',1000),-.2);assert.equal(swapFundingUSD(x,'SHORT',1000),.2);
});
test('stale quote blocks eligibility regardless of current mark',()=>{
 const x=extractTradFiSwaps(payload,{now})[0];assert.equal(tradfiQuoteVerdict(x,{now}).eligible,true);
 assert.equal(tradfiQuoteVerdict(x,{now:now+181000}).eligible,false);
});
test('unknown swap has no invented TradingView symbol or direct trading route',()=>{
 const x=extractTradFiSwaps({listings:[swap('NEWASSET-SWAP')]},{now})[0];assert.equal(x.chartSymbol,null);assert.equal(x.tradeUrl,null);assert.equal(chartUrlForSwap(x),null);
});
test('mark-only without bid and ask is blocked (possible market closure)',()=>{
 const row=extractTradFiSwaps({listings:[swap('XAU-SWAP',{quotes:null})]},{now})[0];assert.equal(tradfiQuoteVerdict(row,{now}).eligible,false);
});
test('Twelve Data parses UTC and excludes current unfinished bar',()=>{
 const values=Array.from({length:80},(_,i)=>{let d=new Date(now-i*3600000);return {datetime:d.toISOString().slice(0,19).replace('T',' '),open:'100',high:'102',low:'99',close:'101'}});
 const all=normalizeTwelveSeries({values},'1h',{now});assert.equal(all.length,80);assert.equal(all.filter(x=>x.closed).length,79);
});
test('No OHLC means TradFi signals are always withheld',()=>{
 const x=extractTradFiSwaps(payload,{now})[0];let out=analyzeTradFi(x,{}, {now});assert.equal(out.status,'withheld');assert.ok(out.reason.includes('데이터 부족'));
});
test('Expired OHLC must block TradFi signals even when volume exists',()=>{
 const x=extractTradFiSwaps(payload,{now})[0];const bar=(minute,i)=>({time:now-24*3600000-i*minute*60000,closeTime:now-24*3600000-i*minute*60000+minute*60000,open:100,close:101,high:102,low:99,volume:0,closed:true});
 const series={h1:Array.from({length:85},(_,i)=>bar(60,i)).sort((a,b)=>a.time-b.time),h4:Array.from({length:80},(_,i)=>bar(240,i)).sort((a,b)=>a.time-b.time)};
 let out=analyzeTradFi(x,series,{now});assert.equal(out.status,'withheld');assert.ok(out.reason.includes('휴장/지연'));
});
test('api key required for optional OHLC; no network hit',async()=>{
 await assert.rejects(fetchTwelveSeries({symbol:'XAU/USD',interval:'h1'}),/API_KEY/);
});
test('Twelve Data rate or entitlement error cannot become a signal',async()=>{
 await assert.rejects(fetchTwelveSeries({symbol:'XAU/USD',interval:'h1',apiKey:'test',fetchFn:async()=>new Response(JSON.stringify({status:'error',message:'quota exceeded'}))}),/quota exceeded/);
});
