import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orangeXPaperView,renderOrangeXPaper} from '../public/orangex_paper.js';

const NOW=Date.parse('2026-10-28T03:00:00Z');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const section=html.slice(html.indexOf('<div id="orangexPaper"'),html.indexOf('<div class="orangex-subheading"><h4>계좌 잔고·PNL'));
const content=view=>Object.values(view).filter(value=>typeof value==='string').join('\n');
const position=(patch={})=>({instrumentName:'BTC-USDT-PERPETUAL',direction:'LONG',quantityOriginal:.1,quantityRemaining:.06,
 entryPrice:100,stop:98,targets:[104,106,108],leverage:2,marginUSD:5,markPrice:104,lastPriceAt:NOW,
 feesUSD:.02,fundingUSD:.001,realizedGrossUSD:.16,realizedPnLUSD:.139,unrealizedPnLUSD:.24,openedAt:NOW-10000,
 exitParts:[{type:'TP1',quantity:.04,price:104,feeUSD:.01,at:NOW-1000}],...patch});
const snapshot=()=>({kind:'ORANGEX_PAPER_OFFLINE',mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',configured:true,
 realDataAutoEntryEnabled:false,liveOrdersEnabled:false,settings:{capitalUSD:1000,leverage:2,maxRiskUSD:6,
 dailyLossLimitUSD:30,maxPositions:3,maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxQuoteAgeMs:10000,killSwitch:false},
 summary:{capitalUSD:1000,equityUSD:1001,availableMarginUSD:990,usedMarginUSD:10,realizedPnLUSD:1,
 unrealizedPnLUSD:.24,totalPnLUSD:1.24,dailyPnLUSD:.8,feesUSD:.04,fundingUSD:.001,openCount:1,pendingCount:1,
 closedCount:1,winRatePct:100,profitFactor:null,maxDrawdownUSD:.1,valuationStale:false,unverifiedFunding:false},
 pending:[{instrumentName:'ETH-USDT-PERPETUAL',direction:'SHORT',orderType:'LIMIT',limitPrice:105,
 quantityRequested:1,quantityRemaining:.5,createdAt:NOW-1000,expiresAt:NOW+10000}],open:[position()],
 closed:[position({quantityRemaining:0,closedAt:NOW,closeReason:'STOP',unrealizedPnLUSD:0,direction:'SHORT'})],
 events:[{type:'OPEN',instrumentName:'BTC-USDT-PERPETUAL',at:NOW-1000,quantity:.1,price:100},
 {type:'CLOSE',instrumentName:'BTC-USDT-PERPETUAL',at:NOW,quantity:.06,price:98,netPnLUSD:-.14}],
 rejections:[{key:'not-public',reason:'DAILY_LOSS_LIMIT',stage:'RISK',at:NOW}],storage:{status:'READY'}});

test('PAPER dashboard uses shared responsive DOM and adds no trading or enable controls',()=>{
 for(const id of ['orangexPaperStatus','orangexPaperSettings','orangexPaperSummary','orangexPaperPending','orangexPaperOpen',
  'orangexPaperClosed','orangexPaperEvents','orangexPaperRejections','orangexPaperStorage'])assert.match(section,new RegExp(`id="${id}"`));
 assert.doesNotMatch(section,/<(?:button|input|select|form)\b/);assert.match(section,/실제 데이터 자동 진입 OFF/);
 for(const id of ['scanner','paper','tradfi','news','journal','chartPanel','orangexContractDetails','orangexBalances'])
  assert.match(html,new RegExp(`id="${id}"`));
 const ids=[...html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);
 assert.match(css,/\.orangex-paper-position-grid\{grid-template-columns:1fr\}/);
 assert.match(css,/\.orangex-paper-metrics\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
 assert.match(css,/\.orangex-paper-pending-table\{min-width:790px\}/);
});

test('missing records, settings, costs and PNL never become fabricated zero values',()=>{
 const view=orangeXPaperView({mode:'PAPER_OFFLINE',dataSource:'UNOBSERVED'},{now:NOW});
 assert.equal(view.configured,false);assert.match(view.notice,/기록 미생성/);assert.match(view.summary,/미설정/);
 assert.doesNotMatch(view.settings,/\$0/);assert.doesNotMatch(view.summary,/\$0/);
 const missing=orangeXPaperView({open:[position({feesUSD:null,fundingUSD:null,realizedPnLUSD:null,unrealizedPnLUSD:null})],
  summary:{realizedPnLUSD:[],fundingUSD:'',feesUSD:false,equityUSD:{}}},{now:NOW});
 assert.doesNotMatch(missing.summary,/\$0/);assert.match(missing.open,/누적 펀딩 비용<\/dt><dd>미확인/);
 assert.match(missing.open,/누적 수수료<\/dt><dd>미확인/);
 assert.match(missing.open,/실현 PNL<\/dt><dd>미확인/);
});

test('an unconfigured empty engine ledger is not shown as a funded zero-cost simulation account',()=>{
 const data={dataSource:'UNOBSERVED',configured:false,settings:{capitalUSD:null},summary:{equityUSD:0,feesUSD:0,
  fundingUSD:0,realizedPnLUSD:0,unrealizedPnLUSD:0,totalPnLUSD:0,dailyPnLUSD:0,closedCount:0,winRatePct:0}};
 const view=orangeXPaperView(data,{now:NOW});assert.match(view.summary,/미설정/);assert.doesNotMatch(view.summary,/\$0|0%/);
});

test('synthetic simulation displays risk settings, LONG/SHORT, partial targets, CLOSE and cost-based PNL',()=>{
 const view=orangeXPaperView(snapshot(),{now:NOW});
 assert.match(view.notice,/PAPER_OFFLINE/);assert.match(view.notice,/합성 테스트 데이터 · 실제 거래소 체결 아님/);
 assert.match(view.settings,/\$1,000\.00/);assert.match(view.settings,/거래당 최대 손실/);assert.match(view.settings,/\$6\.00/);
 assert.match(view.settings,/일일 최대 손실/);assert.match(view.settings,/2x/);assert.match(view.settings,/동시 포지션 한도/);
 assert.match(view.summary,/실현 PNL · 비용 반영/);assert.match(view.summary,/\$1\.00/);assert.match(view.summary,/\$0\.001/);
 assert.match(view.pending,/ETH-USDT-PERPETUAL/);assert.match(view.pending,/SHORT/);assert.match(view.pending,/지정가 모의체결/);
 assert.match(view.open,/LONG/);assert.match(view.open,/1차 104 · 40% \/ 2차 106 · 35% \/ 3차 108 · 25%/);
 assert.match(view.open,/1차 익절 · 40%/);assert.match(view.open,/수수료 \$0\.01/);
 assert.match(view.closed,/CLOSE · 손절/);assert.match(view.closed,/SHORT/);
 assert.match(view.events,/가상 진입/);assert.match(view.events,/CLOSE/);assert.match(view.events,/-\$0\.14/);
 assert.match(view.rejections,/위험 한도|일일 손실 한도/);
 assert.equal(view.realDataAutoEntryEnabled,false);assert.equal(view.liveOrdersEnabled,false);
});

test('explicit zero in validated simulation remains visible while unverified funding stays unknown',()=>{
 const data=snapshot();Object.assign(data.summary,{feesUSD:0,fundingUSD:0,unrealizedPnLUSD:0,unverifiedFunding:true});
 const view=orangeXPaperView(data,{now:NOW});
 assert.match(view.summary,/수수료 합계<\/span><strong>\$0\.00/);
 assert.match(view.summary,/펀딩 비용 합계<\/span><strong>미검증 · PNL 확정 불가/);
 assert.match(view.summary,/실현 PNL · 비용 반영<\/span><strong>비용 미검증/);
 assert.match(view.summary,/가상 자산 평가액<\/span><strong>비용 미검증/);
 assert.match(view.summary,/총 PNL<\/span><strong>비용 미검증/);
 assert.match(view.open,/실현 PNL<\/dt><dd>비용 미검증/);
 assert.match(view.storage,/펀딩 비용 미검증, 0으로 계산하지 않음/);
});

test('stale market valuations and restored positions remain explicit without hiding historical positions',()=>{
 const data=snapshot();data._stale=true;data.recovered=true;data.summary.valuationStale=true;
 data.open[0].lastPriceAt=NOW-10001;data.open[0].recovered=true;
 const view=orangeXPaperView(data,{now:NOW});
 assert.match(view.notice,/조회 갱신 실패/);assert.match(view.notice,/이전에 확인한 PAPER 기록/);
 assert.match(view.open,/BTC-USDT-PERPETUAL/);assert.match(view.open,/시세 지연 · 마지막 평가값/);
 assert.match(view.open,/재시작 복구/);assert.match(view.open,/미실현 PNL · 이전 평가/);
 assert.match(view.storage,/저장된 진행 포지션 복구됨/);assert.match(view.storage,/시세 지연/);
 assert.match(view.state,/stale/);
 const clockOnly=snapshot();clockOnly.open[0].lastPriceAt=NOW-10001;
 assert.match(orangeXPaperView(clockOnly,{now:NOW}).open,/시세 지연/);
});

test('LIVE claims, real-source labels and hostile provider text never enable controls or expose secret fields',()=>{
 const data=snapshot(),secret='synthetic-provider-token-do-not-print';data.mode='LIVE';data.dataSource='REAL_PUBLIC_READ_ONLY';
 data.realDataAutoEntryEnabled=true;data.liveOrdersEnabled=true;data.access_token=secret;data.storage.path=secret;
 data.open[0].instrumentName='<img src=x onerror=alert(1)>';data.open[0].secret=secret;
 data.events.push({type:secret,instrumentName:secret,at:NOW,message:secret});
 data.rejections.push({reason:secret,stage:secret,key:secret,message:secret});data.storage.error=secret;
 const view=orangeXPaperView(data,{now:NOW}),all=content(view);
 assert.equal(view.realDataAutoEntryEnabled,false);assert.equal(view.liveOrdersEnabled,false);
 assert.match(view.notice,/지원하지 않는 모드 · 주문 차단/);assert.match(view.notice,/허용되지 않은 자료 출처/);
 assert.match(view.notice,/실제 데이터 자동 진입 OFF/);assert.match(view.notice,/LIVE 주문 없음/);
 assert.doesNotMatch(all,new RegExp(secret));assert.doesNotMatch(all,/<img/);
 assert.doesNotMatch(all,/<(?:button|input|form|select)\b/);
});

test('safe renderer updates only PAPER nodes and tolerates missing DOM during shared refresh',()=>{
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],{innerHTML:'retained',textContent:'retained',className:''}]));
 const root={getElementById:id=>nodes.get(id)||null},view=renderOrangeXPaper(snapshot(),{root,now:NOW});
 assert.equal(nodes.get('orangexPaperStatus').textContent,view.notice);
 assert.match(nodes.get('orangexPaperSummary').innerHTML,/총 PNL/);assert.match(nodes.get('orangexPaperOpen').innerHTML,/LONG/);
 for(const id of ['paperOpen','paperClosed','orangexMarkets','orangexPnl','scanner'])assert.equal(nodes.get(id).innerHTML,'retained');
 assert.doesNotThrow(()=>renderOrangeXPaper(snapshot(),{root:{getElementById:()=>null},now:NOW}));
});

test('storage failures show preserved records and never print a full provider error or data path',()=>{
 const data=snapshot();data.storageHealthy=false;data.storage={status:'CORRUPT',error:'private-path-and-token'};
 const view=orangeXPaperView(data,{now:NOW});
 assert.match(view.storage,/PAPER 기록 저장 실패 · 신규 모의 진입 중지/);assert.match(view.storage,/기존 Signal Lab PNL/);
 assert.doesNotMatch(view.storage,/private-path-and-token/);assert.match(view.open,/BTC-USDT-PERPETUAL/);
});

test('unavailable records remain an error state rather than empty positions, zero PNL or known trade counts',()=>{
 const data=snapshot();data.recordsUnavailable=true;data.storage={status:'ERROR',healthy:false};
 const view=orangeXPaperView(data,{now:NOW});
 assert.match(view.notice,/PAPER 기록 조회 실패 · 기존 파일 보존/);assert.match(view.summary,/조회 실패/);
 assert.doesNotMatch(view.summary,/\$|100%/);assert.match(view.open,/진행 포지션 유무를 확인할 수 없습니다/);
 assert.match(view.closed,/종료 거래 유무를 확인할 수 없습니다/);assert.match(view.pending,/대기 주문 유무를 확인할 수 없습니다/);
 assert.match(view.events,/모의체결 이력 미확인/);assert.match(view.rejections,/과거 시그널 거부 이력 미확인/);
 assert.match(view.storage,/PAPER 기록 조회 실패/);assert.doesNotMatch(view.open,/기록이 없습니다/);
 const rejection=snapshot();rejection.rejections=[{reason:'REAL_DATA_AUTO_ENTRY_DISABLED',stage:'SIGNAL',at:NOW}];
 assert.match(orangeXPaperView(rejection,{now:NOW}).rejections,/실제 시장 데이터 자동 진입 OFF/);
});

test('a position awaiting funding never presents its booked zero transfers as a verified cost or final net PNL',()=>{
 const data=snapshot();data.open[0].fundingComplete=false;data.open[0].fundingUSD=0;
 data.closed[0].settlementStatus='AWAITING_FUNDING';data.closed[0].fundingUSD=0;
 const view=orangeXPaperView(data,{now:NOW});
 for(const card of [view.open,view.closed]){
  assert.match(card,/펀딩 정산 대기/);assert.match(card,/누적 펀딩 비용<\/dt><dd>미검증 · 정산 대기/);
  assert.match(card,/실현 PNL<\/dt><dd>비용 미검증/);assert.doesNotMatch(card,/누적 펀딩 비용<\/dt><dd>\$0/);
 }
});

test('engine lowercase stages and fixed rejection or completion codes use Korean labels without provider text',()=>{
 const data=snapshot();data.rejections=[{reason:'RISK_OR_MINIMUM_CONFLICT',stage:'execution',at:NOW},
  {reason:'FUNDING_EVENTS_MISSING',stage:'funding',at:NOW},{reason:'TECHNICAL_UNQUALIFIED',stage:'technical',at:NOW}];
 data.events=[{type:'ENTRY_REMAINDER_CANCELLED',at:NOW},{type:'CLOSE_WAITING_FOR_FRESH_BOOK',at:NOW}];
 data.closed[0].closeReason='ALL_TARGETS';
 const view=orangeXPaperView(data,{now:NOW});
 assert.match(view.rejections,/모의체결 · 손실 한도와 최소 거래·분할 수량 충돌/);
 assert.match(view.rejections,/펀딩 · 정산 시각의 펀딩 이벤트 누락/);assert.match(view.rejections,/필수 기술 조건/);
 assert.match(view.events,/시장가 미체결 잔량 취소/);assert.match(view.events,/CLOSE 대기 · 신선한 호가 필요/);
 assert.match(view.closed,/CLOSE · 전체 목표가 도달/);
});
