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

test('real-account page: one 보유 중 list from the exchange (user 2026-11-17 23:19), 카피 / 수동 badges, copy adds and hold time, totals, empty state, failure note',async()=>{
 const {copyHTML,venuePositionsHTML}=await import('../public/live_control.js');
 const base={mode:'LIVE',enabled:true,armed:true,positions:[],closed:[{symbol:'Z',direction:'LONG',netUSD:1,openedAt:1,closedAt:2}],events:[]};
 const vp=[{symbol:'BTCUSDT',origin:'copy',direction:'LONG',size:0.002,avg:50000,mark:51000,unrealized:2,roePct:20,leverage:10,margin:10,liquidation:45000,marginMode:'CROSSED'},
  {symbol:'ETHUSDT',origin:'manual',direction:'SHORT',size:0.5,avg:3000,mark:2900,unrealized:50,roePct:16.7,leverage:5,margin:310,liquidation:null,marginMode:'ISOLATED'}];
 const rec=[{symbol:'BTCUSDT',direction:'LONG',adds:3,openedAt:Date.now()-90*60000,qty:0.002},{symbol:'SOLUSDT',direction:'SHORT',adds:0,openedAt:Date.now()}];
 const h=copyHTML({...base,positions:rec,venuePositions:vp,venuePositionsAt:Date.now(),venuePositionsError:null});
 assert.match(h,/보유 중 <small>2개 · 카피 1개 · 수동 1개<\/small>/);
 assert.doesNotMatch(h,/보유<b/,'the count is the list heading\'s only (user 2026-11-18)');assert.doesNotMatch(h,/미실현<b/,'the 미실현 합계 line has the total');assert.doesNotMatch(h,/거래소 전체 포지션/,'one list only');
 assert.equal((h.match(/class="copy-sub">보유 중/g)||[]).length,1);
 assert.match(h,/vp-badge copy">카피/);assert.match(h,/vp-badge manual">수동/);
 assert.match(h,/추매 3회 · 1시간 30분/);assert.match(h,/>3회<\/td>/);
 assert.match(h,/거래소 확인 중인 카피 기록 1개: <b>SOLUSDT<\/b>/);
 assert.match(h,/미실현 합계 <b class="paper-profit">\+\$52\.00<\/b> · 수동만 <b class="paper-profit">\+\$50\.00/);
 for(const th of ['종목','구분','방향','배율','수량','평단','현재가','증거금','추매','보유','미실현','수익률','청산가'])assert.ok(h.includes(`>${th}</th>`),th);
 assert.ok(h.indexOf('보유 중')<h.indexOf('최근 종료'));assert.match(h,/copy-list only-mob/);assert.match(h,/격리/);
 const empty=copyHTML({...base,venuePositions:[],venuePositionsAt:Date.now()});assert.match(empty,/보유 중인 포지션이 없습니다/);assert.match(empty,/0개 · 카피 0개 · 수동 0개/);
 const failed=venuePositionsHTML({...base,venuePositions:vp,venuePositionsAt:Date.now()-5000,venuePositionsError:'HTTP_429'});assert.match(failed,/갱신 실패/);assert.match(failed,/BTCUSDT/);
 assert.match(venuePositionsHTML({...base,venuePositions:null,venuePositionsError:'HTTP_500'}),/갱신 실패[\s\S]*아직 읽지 못했습니다/);
 assert.equal(venuePositionsHTML(base),'','no venue data (no real-account client): no section');
 assert.equal(venuePositionsHTML({...base,mode:'TESTNET',venuePositions:vp}),'','testnet copy: no section');
 const old=copyHTML({...base,positions:rec});assert.match(old,/보유 중 <small>2개<\/small>/,'no venue data: the copy list as before');
 assert.doesNotMatch(copyHTML({...base,venuePositions:[{...vp[1],symbol:'<img src=x>'}]}),/<img/,'escaped');
});

test('real copy dashboard shows exchange order checks and both P&L samples with settlement details',async()=>{
 const {copyHTML,setCopyPage}=await import('../public/live_control.js');setCopyPage(0);
 const now=Date.now(),closed=[{symbol:'ETHUSDT',direction:'LONG',netUSD:2,netSource:'EXCHANGE_FILLS',openedAt:now-3000,closedAt:now-2000},
  {symbol:'SOLUSDT',direction:'SHORT',netUSD:-1,netSource:'ESTIMATE_BEFORE_FEES',openedAt:now-3000,closedAt:now-1000,
   settlement:{state:'QUANTITY_MISMATCH',checkedAt:now}}];
 const html=copyHTML({mode:'LIVE',closed,audit:{ready:true,positionAt:now,lanes:[{symbol:'BTCUSDT',direction:'LONG',expectedQty:3,venueQty:2,
  stop:'MISSING',issues:['STOP_MISSING','SIZE_MISMATCH'],checkedAt:now,blocked:true}]}});
 assert.match(html,/원장 3 · 거래소 2/);assert.match(html,/보호 손절 누락 · 수량 불일치/);assert.match(html,/신규 진입·추매 보류/);
 assert.match(html,/카피 · 거래소 확인 1건<b[^>]*>\+\$2\.00 · 승률 100%/);
 assert.match(html,/카피 · 추정 포함 2건<b[^>]*>\+\$1\.00 · 승률 50%/);
 assert.match(html,/진입·청산 체결 수량 불일치 · [^<]+ 조회/);
});

test('real-account page shows each fact once (user 2026-11-18 "활성화됨 부분이 2개"): one 활성화됨 next to its button, one time stamp, rules folded',async()=>{
 const fs=await import('node:fs');
 const {copyHTML}=await import('../public/live_control.js');
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const real=html.match(/<section id="real"[\s\S]*?<\/section>/)[0];
 assert.doesNotMatch(real,/realModeBadge|활성화됨/,'no second state chip in the page header');
 const now=Date.now(),vp=[{symbol:'BTCUSDT',origin:'copy',direction:'LONG',size:1,avg:1,mark:1,unrealized:1,leverage:10,margin:1,marginMode:'CROSSED'}];
 const c={mode:'LIVE',enabled:true,armed:true,killed:false,funds:{equity:100,available:80,at:now},positions:[{symbol:'BTCUSDT',direction:'LONG',qty:1,avg:1,leverage:10,openedAt:now}],closed:[],events:[],
  venuePositions:vp,venuePositionsAt:now,venuePositionsError:null,daily:{at:now,since:now-86400000,byDay:{}}};
 const h=copyHTML(c),text=h.replace(/<[^>]+>/g,' ');
 assert.equal(text.split('활성화됨').length-1,1,'활성화됨 once');assert.match(h,/● 활성화됨<\/b>\s*<button[^>]*data-copy-disarm/,'next to its button');
 assert.equal(text.split('실계좌').length-1,1,'the mode once');assert.doesNotMatch(text,/실제 돈으로 주문합니다/);
 assert.equal((text.match(/3초마다 갱신/g)||[]).length,1);assert.doesNotMatch(text,/거래소 기준 · 조회 전용|잔고 \S+ \S+ \S+ 확인/,'one stamp per panel');
 assert.match(h,/<details class="copy-rules-fold"><summary>규칙 보기<\/summary><p class="copy-rules">/);
 const off=copyHTML({...c,armed:false}).replace(/<[^>]+>/g,' ');assert.equal(off.split('비활성').length-1,1,'off: ○ 비활성 once, next to the 활성화하기 button');
 assert.match(copyHTML({...c,armed:false}),/data-copy-arm/);
 const killed=copyHTML({...c,killed:true,ledgerLossPct:50});assert.doesNotMatch(killed,/copy-state/,'stopped: the 정지 line (with 다시 시작) says it once');assert.match(killed,/data-copy-resume/);
 // Testnet copy follows the testnet switch: no state, chip, balance or stamp of its own.
 const tn=copyHTML({...c,mode:'TESTNET',followArmed:true});assert.doesNotMatch(tn,/copy-state|copy-chip|>잔고<|3초마다/);assert.match(tn,/사용 가능/);
 assert.match(copyHTML({...c,mode:'TESTNET',enabled:false}),/카피 꺼짐/);
});
