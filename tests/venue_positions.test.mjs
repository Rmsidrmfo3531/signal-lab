import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVenuePosition,tagOrigins,directionOf,createVenuePositionsReader,venueRows} from '../venue_positions.mjs';

test('normalize: one-way signed rows, hedge rows, margin, ROE, liquidation, symbol',()=>{
 const longOne=normalizeVenuePosition({symbol:'BTC-USDT',positionSide:'BOTH',positionAmt:'0.002',avgPrice:'50000',markPrice:'51000',unrealizedProfit:'2',leverage:10,isolated:false,initialMargin:'10',liquidationPrice:'45000',updateTime:1700000000000});
 assert.equal(longOne.symbol,'BTCUSDT');assert.equal(longOne.venueSymbol,'BTC-USDT');assert.equal(longOne.direction,'LONG');assert.equal(longOne.size,0.002);
 assert.equal(longOne.avg,50000);assert.equal(longOne.mark,51000);assert.equal(longOne.unrealized,2);assert.equal(longOne.roePct,20);assert.equal(longOne.leverage,10);
 assert.equal(longOne.margin,10);assert.equal(longOne.liquidation,45000);assert.equal(longOne.marginMode,'CROSSED');assert.equal(longOne.positionSide,'BOTH');
 const shortOne=normalizeVenuePosition({symbol:'ETH-USDT',positionSide:'BOTH',positionAmt:'-0.5',avgPrice:'3000',markPrice:'2900',unrealizedProfit:'50',leverage:'5',isolated:'true',margin:'310'});
 assert.equal(shortOne.direction,'SHORT');assert.equal(shortOne.size,0.5,'size is positive');assert.equal(shortOne.marginMode,'ISOLATED');
 assert.equal(shortOne.margin,310,'isolated: the venue margin');assert.equal(shortOne.initialMargin,300,'no initialMargin: notional / leverage');assert.ok(Math.abs(shortOne.roePct-50/300*100)<1e-9);
 assert.equal(shortOne.liquidation,null,'no liquidation price given');
 const hedgeShort=normalizeVenuePosition({symbol:'SOL-USDT',positionSide:'SHORT',positionAmt:'3',avgPrice:'100',markPrice:'110',unrealizedProfit:'-30',leverage:3});
 assert.equal(hedgeShort.direction,'SHORT');assert.equal(hedgeShort.positionSide,'SHORT');assert.equal(hedgeShort.margin,100);assert.ok(Math.abs(hedgeShort.roePct+30)<1e-9);
 assert.equal(normalizeVenuePosition({symbol:'SOL-USDT',positionSide:'LONG',positionAmt:'2',avgPrice:'100',leverage:2}).direction,'LONG');
 assert.equal(normalizeVenuePosition({symbol:'X-USDT',positionSide:'BOTH',positionAmt:'0'}),null,'empty row dropped');
 assert.equal(normalizeVenuePosition(null),null);assert.equal(normalizeVenuePosition({positionAmt:'1'}),null,'no symbol');
 // No markPrice: the cached ticker, and the PnL from it when the venue gives none.
 const noMark=normalizeVenuePosition({symbol:'DOGE-USDT',positionSide:'LONG',positionAmt:'100',avgPrice:'0.1',leverage:5},{markOf:s=>s==='DOGE-USDT'?0.12:null});
 assert.equal(noMark.mark,0.12);assert.ok(Math.abs(noMark.unrealized-2)<1e-9);
 // An unsigned one-way amount whose PnL plainly disagrees with the price move is a short.
 assert.equal(directionOf({positionSide:'BOTH',positionAmt:'1',avgPrice:'100',markPrice:'90',unrealizedProfit:'10'}),'SHORT');
 assert.equal(directionOf({positionSide:'BOTH',positionAmt:'1',avgPrice:'100',markPrice:'90',unrealizedProfit:'-10'}),'LONG');
 assert.equal(venueRows({positions:[1]}).length,1);assert.equal(venueRows('x'),null);
});

test('normalize: only whitelisted fields leave (no ids, keys or other venue fields)',()=>{
 const out=normalizeVenuePosition({symbol:'BTC-USDT',positionSide:'LONG',positionAmt:'1',avgPrice:'1',leverage:1,positionId:'123456789',apiKey:'K',secret:'S',signature:'x',realisedProfit:'5'});
 assert.deepEqual(Object.keys(out).sort(),['avg','direction','initialMargin','leverage','liquidation','margin','marginMode','mark','positionSide','roePct','size','symbol','unrealized','updatedAt','venueSymbol'].sort());
 assert.doesNotMatch(JSON.stringify(out),/apiKey|secret|signature|123456789/);
});

test('tagging: copy = open ledger position with the same symbol and direction (hedge by side), else manual',()=>{
 const rows=[{venueSymbol:'BTC-USDT',symbol:'BTCUSDT',direction:'LONG'},{venueSymbol:'BTC-USDT',symbol:'BTCUSDT',direction:'SHORT'},{venueSymbol:'ETH-USDT',symbol:'ETHUSDT',direction:'LONG'},
  {venueSymbol:'NCSKSNDK2USD-USDT',symbol:'NCSKSNDK2USDUSDT',direction:'SHORT'},{venueSymbol:'XRP-USDT',symbol:'XRPUSDT',direction:'LONG'}];
 const ledger=[{status:'OPEN',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',hedge:true},{status:'OPEN',symbol:'SNDKUSDT',venueSymbol:'NCSKSNDK2USD-USDT',direction:'SHORT'},
  {status:'CLOSED',symbol:'XRPUSDT',venueSymbol:'XRP-USDT',direction:'LONG'}];
 const t=tagOrigins(rows,ledger);
 assert.deepEqual(t.map(r=>r.origin),['copy','manual','manual','copy','manual'],'opposite side, other coin and a closed ledger entry are manual');
 assert.equal(t[3].symbol,'SNDKUSDT','a copy row shows the ledger symbol');
 assert.deepEqual(tagOrigins(rows,null).map(r=>r.origin),Array(5).fill('manual'));
});

test('reader: 3 s cache, one request at a time, last good list kept on error, never throws',async()=>{
 let t=1000,calls=0,fail=false;
 const read=async()=>{calls++;if(fail)throw Object.assign(Error('rate <b>'),{code:'HTTP_429'});return [{symbol:'BTC-USDT',positionSide:'LONG',positionAmt:'1',avgPrice:'100',markPrice:'101',unrealizedProfit:'1',leverage:10}]};
 const r=createVenuePositionsReader({read,now:()=>t});
 const ledger=[{status:'OPEN',venueSymbol:'BTC-USDT',direction:'LONG',symbol:'BTCUSDT'}];
 const [a,b]=await Promise.all([r.snapshot(ledger),r.snapshot([])]);
 assert.equal(calls,1,'concurrent snapshots share one request');assert.equal(a.venuePositions[0].origin,'copy');assert.equal(a.venuePositionsAt,1000);assert.equal(a.venuePositionsError,null);
 t+=2000;await r.snapshot(ledger);assert.equal(calls,1,'within 3 s: cached');
 const manual=await r.snapshot([]);assert.equal(manual.venuePositions[0].origin,'manual','tagging follows the ledger of each call');
 t+=1500;fail=true;const e=await r.snapshot(ledger);assert.equal(calls,2);
 assert.equal(e.venuePositionsError,'HTTP_429');assert.equal(e.venuePositions.length,1,'last good list kept');assert.equal(e.venuePositionsAt,1000,'with its time');assert.equal(e.venuePositionsErrorAt,4500);
 await r.snapshot(ledger);assert.equal(calls,2,'a failed read is not retried before 3 s');
 t+=3000;fail=false;const ok=await r.snapshot(ledger);assert.equal(calls,3);assert.equal(ok.venuePositionsError,null);assert.equal(ok.venuePositionsAt,7500);
 // A read that throws synchronously or answers a non-list never escapes.
 const bad=createVenuePositionsReader({read:()=>{throw Error('boom')},now:()=>0});const s=await bad.snapshot();assert.equal(s.venuePositions,null);assert.equal(s.venuePositionsError,'boom');
 const odd=createVenuePositionsReader({read:async()=>({code:1}),now:()=>0});assert.equal((await odd.snapshot()).venuePositionsError,'BAD_RESPONSE');
 // A slow venue: the snapshot answers within waitMs with what it has.
 const slow=createVenuePositionsReader({read:()=>new Promise(()=>{}),waitMs:20});const st=Date.now();const z=await slow.snapshot();assert.ok(Date.now()-st<1000);assert.equal(z.venuePositions,null);
 assert.doesNotMatch(JSON.stringify(e),/<b>/);
});

test('real-account page: 거래소 전체 포지션 with 카피 / 수동 badges, totals, empty state, failure note',async()=>{
 const {copyHTML,venuePositionsHTML}=await import('../public/live_control.js');
 const base={mode:'LIVE',enabled:true,armed:true,positions:[],closed:[{symbol:'Z',direction:'LONG',netUSD:1,openedAt:1,closedAt:2}],events:[]};
 const vp=[{symbol:'BTCUSDT',origin:'copy',direction:'LONG',size:0.002,avg:50000,mark:51000,unrealized:2,roePct:20,leverage:10,margin:10,liquidation:45000,marginMode:'CROSSED'},
  {symbol:'ETHUSDT',origin:'manual',direction:'SHORT',size:0.5,avg:3000,mark:2900,unrealized:50,roePct:16.7,leverage:5,margin:310,liquidation:null,marginMode:'ISOLATED'}];
 const h=copyHTML({...base,venuePositions:vp,venuePositionsAt:Date.now(),venuePositionsError:null});
 assert.match(h,/거래소 전체 포지션 <small>2개 · 수동 1개<\/small>/);
 assert.match(h,/vp-badge copy">카피/);assert.match(h,/vp-badge manual">수동/);
 assert.match(h,/미실현 합계 <b class="paper-profit">\+\$52\.00<\/b> · 수동만 <b class="paper-profit">\+\$50\.00/);
 for(const th of ['종목','구분','방향','배율','수량','평단','현재가','증거금','미실현','수익률','청산가'])assert.ok(h.includes(`>${th}</th>`),th);
 assert.ok(h.indexOf('보유 중')<h.indexOf('거래소 전체 포지션')&&h.indexOf('거래소 전체 포지션')<h.indexOf('최근 종료'),'between 보유 중 and 최근 종료');
 assert.match(h,/copy-list only-mob/);assert.match(h,/격리/);
 const empty=copyHTML({...base,venuePositions:[],venuePositionsAt:Date.now()});assert.match(empty,/거래소에 열린 포지션이 없습니다\./);assert.match(empty,/0개 · 수동 0개/);
 const failed=venuePositionsHTML({...base,venuePositions:vp,venuePositionsAt:Date.now()-5000,venuePositionsError:'HTTP_429'});assert.match(failed,/갱신 실패/);assert.match(failed,/BTCUSDT/);
 assert.match(venuePositionsHTML({...base,venuePositions:null,venuePositionsError:'HTTP_500'}),/갱신 실패[\s\S]*아직 읽지 못했습니다/);
 assert.equal(venuePositionsHTML(base),'','no venue data (no real-account client): no section');
 assert.equal(venuePositionsHTML({...base,mode:'TESTNET',venuePositions:vp}),'','testnet copy: no section');
 assert.doesNotMatch(copyHTML({...base,venuePositions:[{...vp[1],symbol:'<img src=x>'}]}),/<img/,'escaped');
});
