import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {copyHTML,scalpHTML,testnetClosedHTML,venuePositionsHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-18T14:00:00Z');
const venue={symbol:'NCSKSNDK2USDT',origin:'manual',direction:'LONG',leverage:18,marginMode:'CROSSED',
 size:1.39189,avg:769,mark:782.96,margin:59.46,unrealized:19.43,roePct:32.67,liquidation:700};

test('real account venue table has a keyboard-scrollable region, preserving the long symbol and all columns',()=>{
 const html=venuePositionsHTML({mode:'LIVE',venuePositions:[venue]},[]);
 assert.match(html,/<div class="copy-table-scroll" role="region" aria-label="실계좌 보유 포지션" tabindex="0">/);
 assert.match(html,/<table class="copy-table vp-table only-desk">/);
 assert.match(html,/NCSKSNDK2USDT/);
 assert.match(html,/<th class="num">수익률<\/th><th class="num">청산가<\/th>/);
 assert.match(html,/<ul class="copy-list only-mob">/,'compact mobile list is retained');
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

test('testnet closed trades use the same wrapper; CSS scrolls only wide desktop tables',()=>{
 const html=testnetClosedHTML({closed:[],scalp:{closed:[{symbol:'BTCUSDT',kind:'MOVE_REVERSAL',direction:'LONG',openedAt:NOW,closedAt:NOW+600000,netUSD:1,netSource:'EXCHANGE'}]}});
 assert.match(html,/aria-label="테스트넷 종료 거래"/);
 const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
 assert.match(css,/\.copy-table-scroll\{display:none/,'mobile layout keeps the lists');
 assert.match(css,/\.copy-table-scroll\{display:block;width:100%;overflow-x:auto/,'desktop scrolls each table');
 assert.match(css,/\.copy-table-scroll \.copy-table\{width:max-content;min-width:100%/);
 assert.match(css,/\.copy-main\{min-width:0;overflow-x:visible\}/,'the entire panel does not horizontally scroll');
});
