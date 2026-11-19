import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {copyHTML,scalpHTML,testnetClosedHTML,venuePositionsHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-18T14:00:00Z');
const venue={symbol:'NCSKSNDK2USDT',origin:'manual',direction:'LONG',leverage:18,marginMode:'CROSSED',
 size:1.39189,avg:769,mark:782.96,margin:59.46,unrealized:19.43,roePct:32.67,liquidation:700};

test('real account merges only the symbol column across two compact metric rows',()=>{
 const copy={...venue,symbol:'ETHUSDT',origin:'copy',direction:'SHORT',liquidation:900};
 const open=[{symbol:'ETHUSDT',direction:'SHORT',openedAt:NOW-3600000,adds:3,reduces:2}];
 const html=venuePositionsHTML({mode:'LIVE',venuePositions:[venue,copy]},open);
 assert.match(html,/<div class="copy-table-scroll" role="region" aria-label="실계좌 보유 포지션" tabindex="0">/);
 assert.match(html,/<table class="copy-table vp-table vp-two-row only-desk">/);
 assert.equal((html.match(/<tr class="vp-primary/g)||[]).length,2);
 assert.equal((html.match(/<tr class="vp-secondary/g)||[]).length,2);
 assert.equal((html.match(/class="vp-symbol-cell" rowspan="2"/g)||[]).length,2,'only symbol cells span both rows');
 assert.doesNotMatch(html,/colspan="6"/,'second row has real table cells aligned to the columns');
 assert.match(html,/NCSKSNDK2USDT/);
 for(const field of ['증거금','추매','보유','미실현 · 수익률','청산가'])
  assert.match(html,new RegExp('<small>'+field+'</small>'),'each second-row field has its own cell');
 assert.match(html,/19\.43/);
 assert.match(html,/32\.7%/);
 assert.match(html,/3회/,'copy additional buys remain visible');
 assert.match(html,/추매 · 부분청산/,'both counts share the same compact column');
 assert.match(html,/3회 · 2회/,'copy adds and partial reductions have different counters');
 assert.match(html,/부분청산 2회/,'mobile copy row shows its partial reductions');
 assert.doesNotMatch(html,/부분익절 2회/,'a reduction is not automatically a profitable take-profit');

 assert.match(html,/<ul class="copy-list only-mob">/,'mobile list remains unchanged');
});

test('copy and scalp positions and closed trades scroll independently from their controls',()=>{
 const position={symbol:'ETHUSDT',direction:'LONG',leverage:10,qty:1,avg:100,mark:101,unrealized:1,openedAt:NOW};
 const close={...position,closedAt:NOW+600000,netUSD:0.5,netSource:'EXCHANGE_FILLS',adds:0};
 const copy=copyHTML({mode:'LIVE',enabled:true,armed:true,positions:[position],closed:[close],funds:{equity:100,available:90}});
 assert.match(copy,/aria-label="보유 포지션"/);
 assert.match(copy,/aria-label="최근 종료 거래"/);
 assert.match(copy,/<div class="copy-main">/);
 const scalp=scalpHTML({mode:'TESTNET',armed:true,credentials:true,positions:[{...position,status:'OPEN',size:1}],closed:[{...close,netSource:'EXCHANGE'}],stats:{},settings:{}});
 assert.match(scalp,/aria-label="보유 포지션"/);
 assert.match(scalp,/aria-label="최근 종료 거래"/);
});

test('missing partial close count is unknown, not a fabricated zero',()=>{
 const copy={...venue,symbol:'ETHUSDT',origin:'copy'};
 const html=venuePositionsHTML({mode:'LIVE',venuePositions:[copy]},[{symbol:'ETHUSDT',direction:'LONG',adds:1,openedAt:NOW}]);
 assert.match(html,/1회 · —/);
});

test('copy fallback still shows partial reduction count without venue positions',()=>{
 const position={symbol:'ETHUSDT',direction:'LONG',leverage:10,qty:1,avg:100,mark:101,unrealized:1,openedAt:NOW,adds:3,reduces:2};
 const html=copyHTML({mode:'LIVE',enabled:true,armed:true,positions:[position],closed:[],funds:{equity:100,available:90}});
 assert.match(html,/추매 3회 · 부분청산 2회/);
 assert.match(html,/추매 \/ 부분청산/);
});


test('copy page omits the verbose exchange audit rows while preserving positions',()=>{
 const copy={mode:'LIVE',enabled:true,armed:true,positions:[{symbol:'ETHUSDT',direction:'LONG',leverage:80,qty:0.01,avg:1739.87,mark:1772.29,openedAt:NOW,unrealized:0.32}],closed:[],funds:{equity:100,available:90},
  audit:{ready:true,lanes:[{symbol:'ETHUSDT',direction:'LONG',expectedQty:0.01,venueQty:0.01,stop:'OFF',stale:true,blocked:true,issues:['ORDERS_UNREADABLE']}]} };
 const html=copyHTML(copy);
 assert.match(html,/ETHUSDT/,'open position is still shown');
 assert.doesNotMatch(html,/거래소 대조|원장 0\\.01|확인 정보 오래됨|보호 손절 미설정|신규 진입·추매 보류/,'audit-only rows are not rendered');
 assert.doesNotMatch(html,/class="copy-audit"/);
});

test('testnet closed trades use the same wrapper; CSS scrolls only wide desktop tables',()=>{
 const html=testnetClosedHTML({closed:[],scalp:{closed:[{symbol:'BTCUSDT',kind:'MOVE_REVERSAL',direction:'LONG',openedAt:NOW,closedAt:NOW+600000,netUSD:1,netSource:'EXCHANGE'}]}});
 assert.match(html,/aria-label="테스트넷 종료 거래"/);
 const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
 assert.match(css,/\.copy-table-scroll\{display:none/,'mobile layout keeps the lists');
 assert.match(css,/\.copy-table-scroll\{display:block;width:100%;overflow-x:auto/,'desktop scrolls each table');
 assert.match(css,/\.copy-table-scroll \.copy-table\{width:max-content;min-width:100%/);
 assert.match(css,/\.copy-main\{min-width:0;overflow-x:visible\}/,'the entire panel does not horizontally scroll');
 assert.match(css,/\.copy-table-scroll \.vp-two-row\{width:100%;min-width:0;max-width:100%;table-layout:fixed\}/);
 assert.match(css,/\.copy-side \.pnl-cal\{width:100%;max-width:320px\}/,'calendar is compact');
 assert.match(css,/grid-template-columns:minmax\(260px,320px\) minmax\(0,1fr\)/,'desktop uses narrow sidebar again');
 assert.doesNotMatch(css,/\.vp-detail-grid\{display:grid/,'no full-width detail grid');
});
