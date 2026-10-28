import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orangeXPaperView,renderOrangeXPaper,orangeXPaperPerformanceView,orangeXPaperReplayView,renderOrangeXPaperReplay} from '../public/orangex_paper.js';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const NOW=Date.parse('2026-10-28T06:00:00Z');

test('an analysis-only historical mode does not relabel synthetic candles as observed market history',()=>{
 const base={kind:'ORANGEX_PAPER_REPLAY_VIEW',status:'OBSERVED',runKind:'BACKTEST',executionMode:'HISTORICAL_REPLAY',
  result:{kind:'ORANGEX_PAPER_REPLAY_RESULT',executionMode:'HISTORICAL_REPLAY',runKind:'BACKTEST',dataSource:'SYNTHETIC_FIXTURE',
   fillAccuracy:'UNVERIFIED_NO_HISTORICAL_DEPTH',summary:{analysisCount:1,trades:0},signals:[]}};
 assert.match(orangeXPaperReplayView(base).status,/합성 자료 · 실제 과거 실측 아님/);
 base.result.dataSource='USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN';
 assert.match(orangeXPaperReplayView(base).status,/출처 독립 검증 미완료/);
});
const metric=(extra={})=>({totalTrades:12,winningTrades:8,losingTrades:4,winRatePct:66.6667,
 averagePlannedRR:2.7,averageRealizedR:.6,profitFactor:1.8,maxDrawdownUSD:12,maxDrawdownPct:1.2,
 averageHoldingMs:7200000,expectancyUSD:1.25,currentLossStreak:2,maxLossStreak:3,grossPnLUSD:21,
 netPnLUSD:15,feesUSD:4,fundingUSD:2,slippageUSD:1.5,spreadCostUSD:.5,frictionlessPnLUSD:23,
 afterFeesPnLUSD:17,complete:true,auditValid:true,...extra});
const performance=(extra={})=>({kind:'ORANGEX_PAPER_PERFORMANCE',executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER',
 sample:{tradeCount:12,minSampleSize:30,sufficient:false,strategyValidated:false},metrics:metric(),
 directions:{LONG:metric({totalTrades:7}),SHORT:metric({totalTrades:5})},assets:{BTC:metric({totalTrades:4}),
 ETH:metric({totalTrades:5}),SOL:metric({totalTrades:3})},
 periods:{daily:[{period:'2026-10-28',netPnLUSD:3,tradeCount:2}],weekly:[{period:'2026-W44',netPnLUSD:10,tradeCount:7}],
 monthly:[{period:'2026-10',netPnLUSD:15,tradeCount:12}]},audit:{valid:true,complete:true,slippageComplete:true},...extra});
const content=view=>Object.values(view).filter(value=>typeof value==='string').join('\n');
const replay=(extra={})=>({kind:'ORANGEX_PAPER_REPLAY_VIEW',executionMode:'HISTORICAL_REPLAY',runKind:'BACKTEST',status:'OBSERVED',
 result:{kind:'ORANGEX_PAPER_REPLAY_RESULT',executionMode:'HISTORICAL_REPLAY',runKind:'BACKTEST',
  fillAccuracy:'UNVERIFIED_NO_HISTORICAL_DEPTH',summary:{analysisCount:100,patterns:3,technicalPassed:2,finalApproved:0,marketSamples:0,trades:0},
  signals:[{direction:'LONG',signalDetectedAt:NOW-2000,entryEligibleAt:NOW-1000,technicalQualified:true,finalApproved:false,entryAccepted:false}]},...extra});

test('performance and separate replay DOM use the common responsive page without extra trading controls',()=>{
 for(const id of ['orangexPaperContexts','orangexPaperPerformanceStatus','orangexPaperPerformanceMetrics','orangexPaperPerformanceDirections',
  'orangexPaperPerformanceAssets','orangexPaperPerformancePeriods','orangexPaperReplay','orangexPaperReplayStatus','orangexPaperReplaySummary',
  'orangexPaperReplaySignals','orangexPaperReplayPerformanceStatus','orangexPaperReplayPerformanceMetrics'])assert.match(html,new RegExp(`id="${id}"`));
 const section=html.slice(html.indexOf('<section id="orangex"'),html.indexOf('<section id="tradfi"'));
 assert.equal((section.match(/<button\b/g)||[]).length,1);assert.doesNotMatch(section,/<(?:input|form|select)\b/);
 assert.match(section,/백테스트와 순방향 성과 합산 금지/);assert.match(section,/캔들 고가·저가나 단일 JSON 스냅샷/);
 assert.match(css,/@media\(max-width:690px\)\{\.orangex-paper-performance-groups\{grid-template-columns:1fr/);
 assert.match(css,/\.orangex-paper-replay-table\{min-width:820px\}/);
 const ids=[...html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length);
});

test('all requested performance, direction, asset and period metrics render with an insufficient-sample warning',()=>{
 const view=orangeXPaperPerformanceView(performance());
 assert.match(view.status,/표본 12건 \/ 참고 기준 30건 · 표본 부족/);assert.match(view.status,/전략 검증 미완료/);
 for(const label of ['총 종료 거래 횟수','승률','평균 계획 손익비','평균 실현 R 배수','Profit Factor','현금 흐름 MDD','최대 낙폭 비율',
  '평균 보유 시간','체결 손익','수수료 차감 후 손익','비용 반영 순손익','수수료 합계','펀딩 비용 합계','슬리피지 비용',
  '스프레드 비용','현재 연속 손실','최대 연속 손실','거래당 평균 기대값'])assert.match(view.metrics,new RegExp(label));
 assert.match(view.metrics,/2시간/);assert.match(view.metrics,/0\.6배/);assert.match(view.metrics,/\$1\.25/);
 for(const label of ['LONG 성과','SHORT 성과'])assert.match(view.directions,new RegExp(label));
 for(const label of ['BTC 성과','ETH 성과','SOL 성과'])assert.match(view.assets,new RegExp(label));
 for(const period of ['2026-10-28','2026-W44','2026-10'])assert.match(view.periods,new RegExp(period));
 assert.match(view.periods,/한국 시간/);assert.equal(view.strategyValidated,false);
});

test('a larger synthetic sample and a forged validated flag never become proof of actual trading performance',()=>{
 const data=performance({sample:{tradeCount:40,minSampleSize:30,sufficient:true,strategyValidated:true}});
 const view=orangeXPaperPerformanceView(data);
 assert.match(view.status,/참고 표본 기준 충족/);assert.match(view.status,/전략 검증 미완료/);
 assert.match(view.status,/합성 성과를 실제 거래소 수익률로 해석하지/);assert.equal(view.strategyValidated,false);
 assert.doesNotMatch(view.status,/전략 검증 완료/);
});

test('execution mode and backtest context mismatches block metrics instead of mixing ledgers',()=>{
 const data=performance({runKind:'BACKTEST'}),view=orangeXPaperPerformanceView(data,{executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER'});
 assert.match(view.status,/결과 구분 불일치 · 성과 표시 차단/);assert.doesNotMatch(view.metrics,/\$/);
 const unknown=orangeXPaperPerformanceView(performance({executionMode:'LIVE'}));assert.match(unknown.status,/미확인/);
 assert.doesNotMatch(unknown.metrics,/\$/);
 for(const [executionMode,label]of [['SYNTHETIC_TEST','합성 데이터 검증'],['HISTORICAL_REPLAY','과거 데이터 분석 재생'],['LIVE_MARKET_PAPER','실제 시세 모의매매 OFF']]){
  const main=orangeXPaperView({mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',executionMode,runKind:'FORWARD_PAPER'},{now:NOW});
  assert.match(main.contexts,new RegExp(label));assert.equal(main.realDataAutoEntryEnabled,false);assert.equal(main.liveOrdersEnabled,false);
 }
});

test('invalid or incomplete accounting cannot display confident net results and missing slippage is not zero',()=>{
 const bad=orangeXPaperPerformanceView(performance({audit:{valid:false,complete:false}}));
 assert.match(bad.status,/원장 검증 실패/);assert.match(bad.metrics,/원장 검증 실패/);assert.doesNotMatch(bad.metrics,/\$/);
 const pending=performance({audit:{valid:true,complete:false}});pending.metrics.slippageUSD=null;pending.metrics.frictionlessPnLUSD=null;
 const view=orangeXPaperPerformanceView(pending);
 assert.match(view.metrics,/비용 반영 순손익<\/span><strong>비용 미검증/);
 assert.match(view.metrics,/수수료 합계<\/span><strong>\$4\.00/);
 assert.match(view.metrics,/잔량 슬리피지 비용<\/span><strong>미확인/);
 assert.doesNotMatch(view.metrics,/잔량 슬리피지 비용<\/span><strong>\$0/);
 const knownZero=performance();knownZero.metrics.slippageUSD=0;
 assert.match(orangeXPaperPerformanceView(knownZero).metrics,/잔량 슬리피지 비용<\/span><strong>\$0\.00/);
});

test('unknown source fields, period labels and provider errors never reach performance HTML',()=>{
 const secret='synthetic-secret-provider-content',data=performance();
 data.metrics.access_token=secret;data.audit.issues=[{message:secret}];data.sample.reasons=[secret];
 data.periods.daily.push({period:'<img src=x onerror=alert(1)>',pnlUSD:999,tradeCount:1});data.periods.weekly.push({period:secret,netPnLUSD:999});
 data.directions.LONG.name=secret;data.extra=secret;
 const all=content(orangeXPaperPerformanceView(data));assert.doesNotMatch(all,new RegExp(secret));assert.doesNotMatch(all,/<img/);
 assert.doesNotMatch(all,/<(?:button|input|select|form)\b/);
});

test('numeric performance claims without an independent accounting status remain unverified',()=>{
 for(const audit of [undefined,null,{}, {valid:true},{valid:true,complete:'yes'}]){
  const data=performance({audit});data.metrics.feesUSD=0;data.metrics.netPnLUSD=100;
  const view=orangeXPaperPerformanceView(data);assert.match(view.status,/미확인/);
  assert.doesNotMatch(view.metrics,/\$0|\$100|66\.6667%/);assert.match(view.metrics,/미확인/);
 }
});

test('historical replay displays analysis and two clocks while explicitly leaving execution accuracy unverified',()=>{
 const view=orangeXPaperReplayView(replay());assert.equal(view.observed,true);
 assert.match(view.status,/HISTORICAL_REPLAY/);assert.match(view.status,/모의체결 OFF/);assert.match(view.status,/과거 호가 없음 · 체결 정확도 미검증/);
 assert.match(view.status,/BACKTEST/);assert.match(view.summary,/1H·4H 분석 횟수/);assert.match(view.summary,/>100</);
 assert.match(view.signals,/LONG/);assert.match(view.signals,/미승인/);assert.match(view.signals,/등록 안 됨/);
 assert.doesNotMatch(view.signals,/실제 체결/);assert.match(view.performance.status,/미확인/);
});

test('synthetic backtest performance remains in its own view and entry registration is never described as a fill',()=>{
 const data=replay({executionMode:'SYNTHETIC_TEST'});Object.assign(data.result,{executionMode:'SYNTHETIC_TEST',fillAccuracy:'SYNTHETIC_MODEL_ONLY',performance:performance({runKind:'BACKTEST'})});
 data.result.signals[0].entryAccepted=true;data.result.signals[0].finalApproved=true;
 const view=orangeXPaperReplayView(data);assert.equal(view.observed,true);assert.match(view.status,/실제 체결 정확도 검증 아님/);
 assert.match(view.signals,/등록 · 체결 확인과 별도/);assert.match(view.performance.status,/BACKTEST/);assert.match(view.performance.status,/전략 검증 미완료/);
 data.result.runKind='FORWARD_PAPER';const wrong=orangeXPaperReplayView(data);assert.equal(wrong.observed,false);assert.doesNotMatch(wrong.summary,/>100</);
});

test('replay loading and record errors remain unknown rather than successful empty runs or zero results',()=>{
 for(const data of [{},replay({status:'ERROR',error:'hidden-provider-secret'}),replay({_stale:true})]){
  const view=orangeXPaperReplayView(data);assert.equal(view.observed,false);assert.doesNotMatch(view.summary,/\$|>0</);
  assert.match(view.summary,/미확인/);assert.doesNotMatch(content(view),/hidden-provider-secret/);
 }
 const failure=orangeXPaperPerformanceView(performance(),{recordsUnavailable:true});assert.match(failure.status,/조회 실패/);
 assert.doesNotMatch(failure.metrics,/\$/);
});

test('new risk limits, connection blocks and stop-gap overruns are visible without changing old positions',()=>{
 const view=orangeXPaperView({mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',settings:{capitalUSD:1000,
  maxConsecutiveLosses:3,maxPositionMarginUSD:50,maxTotalMarginUSD:100},
  risk:{connection:{connected:false},entryBlockReason:'CONNECTION_DISCONNECTED'},
  closed:[{instrumentName:'BTC-USDT-PERPETUAL',direction:'LONG',closedAt:NOW,closeReason:'STOP',
   gapStopExceeded:{plannedRiskUSD:6,realizedLossUSD:9,overrunUSD:3}}],
  rejections:[{reason:'CONSECUTIVE_LOSS_LIMIT',stage:'risk',at:NOW}],events:[{type:'STOP_RISK_OVERRUN',at:NOW}]},{now:NOW});
 assert.match(view.settings,/연속 손실 중지 한도/);assert.match(view.settings,/포지션 증거금 한도/);assert.match(view.settings,/전체 증거금 한도/);
 assert.match(view.settings,/연결 단절 · 신규 진입 중지/);assert.match(view.closed,/손절 갭 · 계획 손실 \$6\.00 \/ 모의 손실 \$9\.00 \/ 초과 \$3\.00/);
 assert.match(view.rejections,/연속 손실 한도/);assert.match(view.events,/계획 위험액 초과/);
});

test('renderers bind only their own forward or replay nodes and remain safe with missing DOM',()=>{
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],{innerHTML:'original',textContent:'original',className:''}]));
 const root={getElementById:id=>nodes.get(id)||null};
 renderOrangeXPaper({mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',performance:performance()},{root,now:NOW});
 assert.match(nodes.get('orangexPaperPerformanceStatus').textContent,/표본 부족/);
 assert.match(nodes.get('orangexPaperPerformanceDirections').innerHTML,/LONG 성과/);
 assert.equal(nodes.get('orangexPaperReplayStatus').textContent,'original');assert.equal(nodes.get('paperOpen').innerHTML,'original');
 renderOrangeXPaperReplay(replay(),{root});assert.match(nodes.get('orangexPaperReplayStatus').textContent,/과거 호가 없음/);
 assert.match(nodes.get('orangexPaperReplaySignals').innerHTML,/LONG/);assert.equal(nodes.get('orangexMarkets').innerHTML,'original');
 assert.doesNotThrow(()=>renderOrangeXPaperReplay({}, {root:{getElementById:()=>null}}));
});
