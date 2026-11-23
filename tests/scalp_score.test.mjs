import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreScalpSetup,SCALP_SCORE_DEFAULTS,SCALP_SCORE_WEIGHTS} from '../scalp_reversal.mjs';
import {ScalpExecutor,scalpExecConfig,SCALP_EXEC_SETTINGS} from '../scalp_executor.mjs';
import {scalpEventText,scalpReasonKo} from '../scalp_telegram.mjs';
import {journalLine} from '../scalp_journal.mjs';
import {scalpDetailsHTML,scalpPositionCardHTML} from '../public/live_control.js';

const I=300000,BUCKET=Math.floor(Date.parse('2026-11-22T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I,wick=.8}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-wick,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const down4h=now=>up4h(now).map((r,i)=>{const c=200-i*.1;return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
const BTC={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:5,tradable:true};

function mockVenue(fillAt=PX,{fillMaker=true}={}){
 const calls=[];let amt=0,avg=0,id=1;
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(avg),unrealizedProfit:'0'}]:[],
  openOrders:async()=>({orders:[]}),getOrder:async()=>({order:null}),cancelOrder:async()=>({}),
  placeOrder:async(p)=>{calls.push(p);
   if(p.type==='LIMIT'&&p.timeInForce==='PostOnly'){
    if(!fillMaker)throw Object.assign(Error('would immediately match'),{code:'101415'});
    const q=Number(p.quantity),px=Number(p.price)||fillAt;
    avg=px;amt=p.side==='SELL'?-q:q;
    return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(px)}};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='IOC'&&p.reduceOnly){
    const q=Number(p.quantity);
    amt=amt>0?+Math.max(0,amt-q).toFixed(8):+Math.min(0,amt+q).toFixed(8);
    return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(Number(p.price)||fillAt)}};
   }
   if(p.type==='MARKET'){const q=Number(p.quantity);avg=fillAt;amt=p.side==='SELL'?-q:q;return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(avg)}}}
   return {order:{orderId:String(id++),status:'NEW'}}}};
 return {client,calls,get amt(){return amt},set amt(v){amt=v}};
}

test('SCALP_SCORE_WEIGHTS sum strictly to 100 in 5-point increments and defaults match calibrated values',()=>{
 const values=Object.values(SCALP_SCORE_WEIGHTS);
 assert.equal(values.reduce((a,b)=>a+b,0),100);
 assert.ok(values.every(v=>v>0&&v%5===0));
 const cfg=scalpExecConfig({});
 assert.equal(cfg.minScore,SCALP_SCORE_DEFAULTS.minScore);
 assert.equal(cfg.minScore,65);
 assert.equal(cfg.highScore,70);
 assert.equal(cfg.highScoreSizeMult,1.25);
 assert.equal(SCALP_EXEC_SETTINGS.minMoveAtr,3);
 assert.equal(scalpExecConfig({SCALP_MIN_SCORE:'0',SCALP_HIGH_SCORE:'75',SCALP_HIGH_SCORE_SIZE_MULT:'1.4'}).minScore,0);
 assert.equal(scalpExecConfig({SCALP_HIGH_SCORE:'75',SCALP_HIGH_SCORE_SIZE_MULT:'1.4'}).highScoreSizeMult,1.4);
});

test('scoreScalpSetup scores perfect S-grade (100), B-grade (65), and blocked D-grade setups accurately',()=>{
 const perfect=scoreScalpSetup({
  direction:'LONG',
  evidence:{movePct:5.5,moveAtr:3.8,retracedPct:20,climaxVolumeRatio:6.5,rsiPeak:19},
  trend4h:'up',btcTrend4h:'up',netRR:1.4,
 });
 assert.equal(perfect.score,100);
 assert.equal(perfect.grade,'S');
 assert.equal(perfect.pass,true);
 assert.equal(perfect.sizeMult,1.25);
 assert.deepEqual(perfect.breakdown,{movePct:25,trend4h:20,btcTrend4h:15,moveAtr:15,retracedPct:10,climaxVolume:5,netRR:5,rsiExtreme:5});

 // SHORT mirror with extreme >=6x ATR blowoff (0 pts for ATR) & neutral range trends -> B-grade 65 (1.0x)
 const bGrade=scoreScalpSetup({
  direction:'SHORT',
  evidence:{movePct:5.2,moveAtr:7.1,retracedPct:18,climaxVolumeRatio:5.5,rsiPeak:82},
  trend4h:'range',btcTrend4h:null,netRR:1.3,
 });
 // 25 (move) + 10 (4h range) + 10 (btc null->range) + 0 (atr>=6) + 10 (retrace) + 5 (vol) + 5 (rr) + 5 (rsi>=78) = 70
 assert.equal(bGrade.score,70);
 assert.equal(bGrade.grade,'A');
 assert.equal(bGrade.sizeMult,1.25);

 // Exactly 65점 B-grade (1.0x sizing)
 const exactB=scoreScalpSetup({
  direction:'SHORT',
  evidence:{movePct:5.2,moveAtr:7.1,retracedPct:12,climaxVolumeRatio:5.5,rsiPeak:82},
  trend4h:'range',btcTrend4h:'range',netRR:1.3,
 });
 assert.equal(exactB.score,65);
 assert.equal(exactB.grade,'B');
 assert.equal(exactB.pass,true);
 assert.equal(exactB.sizeMult,1);

 // Against-trend small move + blowoff ATR + falling knife -> D-grade blocked
 const weak=scoreScalpSetup({
  direction:'LONG',
  evidence:{movePct:2.7,moveAtr:6.5,retracedPct:6,climaxVolumeRatio:3.2,rsiPeak:24},
  trend4h:'down',btcTrend4h:'down',netRR:0.9,
 });
 assert.equal(weak.score,5);
 assert.equal(weak.grade,'D');
 assert.equal(weak.pass,false);
 assert.equal(weak.sizeMult,0);
});

test('ScalpExecutor default score gate blocks low-score against-trend setup and scales up A/S setups by 1.25x',async()=>{
 // 1) Low score (<65): LONG against 4H downtrend & BTC downtrend -> blocked with SCORE_BELOW_MINIMUM
 const vLow=mockVenue();
 const exLow=new ScalpExecutor({
  config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false},
  client:vLow.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):down4h(T0),
  priceOf:async()=>PX,markOf:async()=>PX,
  balance:async()=>({equity:10000,available:9000}),
  now:()=>T0,
 });
 exLow.arm();
 await exLow.scan();
 assert.equal(exLow.store.open.length,0);
 assert.equal(exLow.store.skips.at(-1).reason,'SCORE_BELOW_MINIMUM');
 assert.match(exLow.store.skips.at(-1).detail,/점\/65점/);
 assert.ok(scalpReasonKo('SCORE_BELOW_MINIMUM').includes('점수 미달'));

 // 2) High score (>=70): LONG with 4H uptrend + BTC uptrend -> enters with 1.25x risk boost vs flat 1.0x
 const makeHigh=(extraCfg={})=>{
  const v=mockVenue();
  const ex=new ScalpExecutor({
   config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false,bounceSizing:false,scoreTierSizing:false,...extraCfg},
   client:v.client,
   contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
   tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
   candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):up4h(T0),
   priceOf:async()=>PX,markOf:async()=>PX,
   balance:async()=>({equity:10000,available:9000}),
   now:()=>T0,
  });
  return {v,ex};
 };
 const a=makeHigh();a.ex.arm();await a.ex.scan();
 const b=makeHigh({highScoreSizeMult:1});b.ex.arm();await b.ex.scan();
 assert.equal(a.ex.store.open.length,1);
 assert.equal(b.ex.store.open.length,1);
 const pA=a.ex.store.open[0],pB=b.ex.store.open[0];
 assert.equal(pA.scalpScore.score,80); // 25+20+15+0+5+5+5+5 = 80 (S-grade with BTC up4h!)
 assert.equal(pA.scalpScore.grade,'S');
 assert.equal(pA.scalpScore.sizeMult,1.25);
 assert.equal(pA.btcTrend4h,'up');
 assert.ok(pA.qty>pB.qty*1.20&&pA.qty<pB.qty*1.30,`expected ~1.25x qty boost: ${pA.qty} vs ${pB.qty}`);

 // Verify Telegram OPENED notice, journal line, status, runtimeSummary, and UI badges
 const opened=a.ex.store.events.find(e=>e.type==='OPENED');
 const tg=scalpEventText(opened);
 assert.match(tg,/점수 80점\(S급 · 비중 1\.25x\)/);
 const jl=journalLine({...pA,closedAt:T0+60000,closeReason:'EARLY_TAKE_PROFIT',netUSD:20});
 assert.equal(jl.score.score,80);
 assert.equal(jl.btcTrend4h,'up');
 const card=scalpPositionCardHTML(pA);
 assert.match(card,/80점 S급 · 1\.25x/);
 const st=a.ex.status();
 assert.equal(st.settings.minScore,65);
 assert.equal(st.settings.highScore,70);
 assert.equal(st.settings.highScoreSizeMult,1.25);
 assert.equal(a.ex.runtimeSummary().minScore,65);
 const details=scalpDetailsHTML(st);
 assert.match(details,/100점 신호 점수 65점 이상 진입 \(70점\+ 비중 1\.25배\)/);
 assert.match(details,/2\.5% 이상 통합 점수 판별 \(매물대 강제 해제\)/);
 assert.match(details,/name="minScore"/);
 assert.match(details,/S급 \(80\+\)/);
 assert.match(details,/A급 \(70~75\)/);
 assert.match(details,/B급 \(65\)/);
});

test('unified 2.5%+ score gate enters high-confluence 3% move without 4H/1D zone reads and tracks byGrade stats',async()=>{
 // Build a realistic ~3.1% drop (below 3.5% MOVE floor) with ~4.0x ATR, RSI<=20, 8x volume, and a clean hammer (~20% bounce)
 const rows=[];let p=100;
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.15:-.15);rows.push([0,o,Math.max(o,c)+.30,Math.min(o,c)-.30,c,100]);p=c}
 // 4 sharp drop candles (~2.64% body drop) with climax volume
 for(let i=0;i<4;i++){const o=p,c=p-0.66;rows.push([0,o,o+.04,c-.04,c,100*(i===3?8:4)]);p=c}
 // Hammer rejection candle dipping to ~3.3% total drop and closing ~16% off extreme (TP1 netRR > 1.3, ~4.2x ATR)
 const low=p-0.42,close=p-0.06;
 rows.push([0,p-0.04,close+0.03,low,close,700]);
 const lastOpen=(BUCKET-1)*I;
 const candles5m=[...rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]}),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']];

 let zoneCalls=0;
 const v=mockVenue(close);
 const ex=new ScalpExecutor({
  config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false},
  client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?candles5m:[]):up4h(T0),
  zoneCandles:async()=>{zoneCalls++;return []},
  priceOf:async()=>close,markOf:async()=>close,
  balance:async()=>({equity:10000,available:9000}),
  now:()=>T0,
 });
 ex.arm();
 await ex.scan();
 assert.equal(zoneCalls,0,'unified 2.5%+ score gate must not call 4H/1D zoneCandles');
 assert.equal(ex.store.open.length,1,'high-confluence 3% move passes >=65 unified score gate');
 assert.equal(ex.store.open[0].kind,'MOVE_REVERSAL');
 assert.ok(ex.store.open[0].evidence.movePct>=2.5&&ex.store.open[0].evidence.movePct<3.5);
 assert.ok(ex.store.open[0].scalpScore.score>=70);
 assert.equal(ex.store.open[0].scalpScore.grade,'A');

 // Close trade and verify stats().byGrade tracks S/A/B accurately
 ex.store.closed.push({...ex.store.open.pop(),status:'CLOSED',closedAt:T0+60000,closeReason:'EARLY_TAKE_PROFIT',netUSD:25.5});
 const st=ex.stats();
 assert.equal(st.byGrade.A.trades,1);
 assert.equal(st.byGrade.A.netUSD,25.5);
 assert.equal(st.byGrade.S.trades,0);
 assert.equal(st.byGrade.B.trades,0);
});

test('What-If simulator filters by minScore, retroactively scores legacy rows, and unlocks SCORE_BELOW_MINIMUM',async()=>{
 const {simulateScalpSignals,normalizeSimParams}=await import('../scalp_simulator.mjs');
 const now=Date.parse('2026-11-22T10:00:00Z');
 const signals=[
  // High score trade (80점): win +$30
  {at:now-100000,barAt:now-120000,symbol:'AUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:true,reason:null,evidence:{movePct:5.5,moveAtr:3.8,retracedPct:20,climaxVolumeRatio:6,rsiPeak:19},trend4h:'up',btcTrend4h:'up',withTrend:true,plan:{netRR:1.4}},
  // Low score legacy trade (30점): loss -$20
  {at:now-200000,barAt:now-220000,symbol:'BUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:true,reason:null,evidence:{movePct:3.0,moveAtr:7.0,retracedPct:8,climaxVolumeRatio:3.2,rsiPeak:24},trend4h:'down',btcTrend4h:'down',withTrend:false,plan:{netRR:0.9}},
  // Previously blocked by SCORE_BELOW_MINIMUM at 60점 (unlocks when minScore=60)
  {at:now-300000,barAt:now-320000,symbol:'CUSDT',direction:'SHORT',kind:'MOVE_REVERSAL',entered:false,reason:'SCORE_BELOW_MINIMUM',score:{score:60,grade:'C'},evidence:{movePct:4.2,moveAtr:5.0,retracedPct:16,climaxVolumeRatio:5.5,rsiPeak:80},trend4h:'range',withTrend:null,plan:{netRR:1.2}},
 ];
 const trades=[
  {symbol:'AUSDT',direction:'LONG',barAt:now-120000,kind:'MOVE_REVERSAL',evidence:signals[0].evidence,trend4h:'up',btcTrend4h:'up',withTrend:true,plan:{tp1NetR:1.4},exit:{at:now-50000},pnl:{netUSD:30,r:2.0}},
  {symbol:'BUSDT',direction:'LONG',barAt:now-220000,kind:'MOVE_REVERSAL',evidence:signals[1].evidence,trend4h:'down',btcTrend4h:'down',withTrend:false,plan:{tp1NetR:0.9},exit:{at:now-150000},pnl:{netUSD:-20,r:-1.3}},
 ];

 assert.equal(normalizeSimParams({minScore:120}).minScore,100);
 // At minScore=65: drops losing BUSDT (-$20), keeping winning AUSDT (+$30), CUSDT stays blocked
 const s65=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:2.5,trendMode:'off',zoneSignals:true,minNetRR:0,minScore:65},now,includePresets:false});
 assert.equal(s65.simulated.trades,1);
 assert.equal(s65.simulated.netUSD,30);
 assert.equal(s65.simulated.removedTrades,1);
 assert.equal(s65.simulated.removedNetUSD,-20);
 assert.equal(s65.simulated.unlockedSignals,0);

 // At minScore=60: unlocks CUSDT (SCORE_BELOW_MINIMUM)
 const s60=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:2.5,trendMode:'off',zoneSignals:true,minNetRR:0,minScore:60},now,includePresets:false});
 assert.equal(s60.simulated.unlockedSignals,1);
 assert.equal(s60.simulated.unlockedByReason.SCORE_BELOW_MINIMUM,1);
});

test('redundant against-trend 50% sizing is omitted when 100-point scoring is active',()=>{
 const details=scalpDetailsHTML({
  mode:'TESTNET',credentials:true,armed:true,
  settings:{...scalpExecConfig({}),...SCALP_EXEC_SETTINGS,stopLossEnabled:false,repeatedScaleIn:true,minScore:65},
  stats:{bySide:{},byKind:{},byGrade:{}},
 });
 assert.doesNotMatch(details,/4H 역추세 50%/);
 assert.match(details,/급변 2\.5%\+ \(통합\)/);
 assert.match(details,/종목 손실 쿨다운\(손실 후 120분 · 당일 2패 시 자정까지 휴식\)/);
});

test('per-symbol loss cooldown blocks rapid re-entry after recent loss or 2 same-day losses, and CLOSED alerts/table show score',async()=>{
 const {testnetClosedHTML,setTestnetPage}=await import('../public/live_control.js');
 // 1) Recent losing close (30m ago) -> blocked for remaining 90m
 const v1=mockVenue();
 const ex1=new ScalpExecutor({
  config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false},
  client:v1.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):up4h(T0),
  priceOf:async()=>PX,markOf:async()=>PX,
  balance:async()=>({equity:10000,available:9000}),
  now:()=>T0,
 });
 ex1.store.closed.push({id:'prev-loss',symbol:'SOLUSDT',direction:'LONG',closedAt:T0-30*60000,closeReason:'EMERGENCY_ROE_STOP',netUSD:-25,scalpScore:{score:75,grade:'A'}});
 ex1.arm();
 await ex1.scan();
 assert.equal(ex1.store.open.length,0);
 assert.equal(ex1.store.skips.at(-1).reason,'SYMBOL_LOSS_COOLDOWN');
 assert.match(ex1.store.skips.at(-1).detail,/최근 손실 후 90분 남음/);

 // 2) 2 same-KST-day losses (even >2h ago) -> blocked until KST midnight
 const v2=mockVenue();
 const ex2=new ScalpExecutor({
  config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false},
  client:v2.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):up4h(T0),
  priceOf:async()=>PX,markOf:async()=>PX,
  balance:async()=>({equity:10000,available:9000}),
  now:()=>T0,
 });
 ex2.store.closed.push(
  {id:'l1',symbol:'SOLUSDT',direction:'LONG',closedAt:T0-4*3600000,closeReason:'STOP',netUSD:-15},
  {id:'l2',symbol:'SOLUSDT',direction:'LONG',closedAt:T0-3*3600000,closeReason:'STOP',netUSD:-18},
 );
 ex2.arm();
 await ex2.scan();
 assert.equal(ex2.store.open.length,0);
 assert.equal(ex2.store.skips.at(-1).reason,'SYMBOL_LOSS_COOLDOWN');
 assert.match(ex2.store.skips.at(-1).detail,/당일 2회 손실/);

 // 3) CLOSED Telegram alert + testnetClosedHTML table display entry score/grade
 const tgClosed=scalpEventText({type:'CLOSED',symbol:'SOLUSDT',direction:'LONG',reason:'EARLY_TAKE_PROFIT',netUSD:32.5,roePct:12.4,tp:1,holdMs:18*60000,score:80,grade:'S'});
 assert.match(tgClosed,/80점\(S급\)/);
 setTestnetPage(0);
 const closedHtml=testnetClosedHTML({
  closed:[],
  scalp:{closed:[{id:'c1',symbol:'SOLUSDT',direction:'LONG',kind:'MOVE_REVERSAL',closedAt:T0,openedAt:T0-600000,netUSD:32.5,scalpScore:{score:80,grade:'S',summary:'80점(S급)'}}]},
 });
 assert.match(closedHtml,/80점 S급/);

 // 4) scoreSummary tracks passed / nearMiss (60) / low (<=55) and renders in scalpDetailsHTML
 ex1.store.skips.push(
  {at:T0-1000,symbol:'XUSDT',reason:'SCORE_BELOW_MINIMUM',score:60,grade:'C'},
  {at:T0-2000,symbol:'YUSDT',reason:'SCORE_BELOW_MINIMUM',score:45,grade:'D'},
 );
 const st1=ex1.status();
 assert.deepEqual(st1.scoreSummary,{minScore:65,nearFloor:60,passed:1,nearMiss:1,low:1});
 const det1=scalpDetailsHTML(st1);
 assert.match(det1,/점수 분포: 통과\(65점\+\) <b>1건<\/b> · 턱걸이 차단\(60점대\) <b>1건<\/b> · 하위 차단\(55점 이하\) <b>1건<\/b>/);
});

test('Combo B / C7 profit-max suite: Post-Only maker entry, disabled 15m fallback, and +16% ROE 25% partial TP / 75% runner',async()=>{
 const cfg=scalpExecConfig({});
 assert.equal(cfg.riskPct,0.75);
 assert.equal(cfg.minProfitRoePct,16);
 assert.equal(cfg.partialTakeFrac,0.25);
 assert.equal(cfg.earlyFallbackMin,0);
 assert.equal(cfg.profitOnlyMaxHoldMin,240);
 assert.equal(cfg.maxScaleInAdds,2);
 assert.equal(cfg.makerEntry,true);

 let now=T0,mark=PX;
 const v=mockVenue(PX,{fillMaker:true});
 const ex=new ScalpExecutor({
  config:{...cfg,scaleIn:true,stopLossEnabled:false},
  client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):up4h(now),
  priceOf:async()=>mark,markOf:async()=>mark,
  balance:async()=>({equity:3000,available:2900}),
  now:()=>now,
 });
 ex.arm();
 await ex.scan();
 assert.equal(ex.store.open.length,1);
 const p=ex.store.open[0];
 assert.equal(p.executionMode,'MAKER','default Post-Only maker entry fills as MAKER');
 const opened=ex.store.events.find(e=>e.type==='OPENED');
 assert.match(scalpEventText(opened),/메이커 체결/);
 const initialSize=p.size;

 // Advance 25 minutes with +2% ROE: must NOT prematurely close (15m fallback is disabled!)
 now+=25*60000;
 mark=+(p.avg*1.0035).toFixed(4);
 v.client.positions=async()=>[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(v.amt),avgPrice:String(p.avg),markPrice:String(mark),unrealizedProfit:String((mark-p.avg)*v.amt)}];
 await ex.reconcile();
 assert.equal(ex.store.open.length,1,'must not exit at +2% ROE after 25m when earlyFallbackMin=0');
 assert.equal(v.calls.filter(c=>c.type==='LIMIT'&&c.timeInForce==='IOC'&&c.reduceOnly==='true').length,0);

 // Rally to +18.5% gross (~+16.9% Net ROE at 10x): must lock in 25% partial TP and keep 75% runner!
 now+=60000;
 mark=+(p.avg*1.0185).toFixed(4);
 await ex.reconcile();
 const partialEvt=ex.store.events.find(e=>e.type==='PARTIAL_TAKE_PROFIT');
 assert.ok(partialEvt,'+16% Net ROE triggers 25% partial take-profit');
 assert.equal(partialEvt.takePct,25);
 assert.ok(Math.abs(partialEvt.qty-initialSize*0.25)<0.05,`expected ~25% partial qty: ${partialEvt.qty} vs ${initialSize}`);
 assert.match(scalpEventText(partialEvt),/25% 부분 익절 확정/);

 // Verify UI rules reflect C7 defaults accurately
 const ui=scalpDetailsHTML(ex.status());
 assert.match(ui,/물림 240분 컷/);
 assert.match(ui,/Post-Only 메이커 우선 진입/);
 assert.match(ui,/25% 확정 \+ 잔여 75% 러너 트레일링/);
 assert.match(ui,/반등확인 비중\(20%\+ 1\.35배 · 미만 0\.8배\)/);
 assert.match(ui,/조기 본전컷 없음/);
 assert.match(ui,/거래량 2배 · RSI 30\/70 · 꼬리 35%\+/);
});

test('B7 relaxed pre-filters capture high-scoring setups with 2.4x volume & 40% wick behind the 100-point score gate',async()=>{
 const cfg=scalpExecConfig({});
 assert.equal(cfg.settings.climaxVolume,2);
 assert.equal(cfg.settings.rsiExtreme,30);
 assert.equal(cfg.settings.wickShare,0.35);
 assert.equal(cfg.settings.maxRetracedBeforeEntry,0.35);

 // 5.5% drop with 2.4x climax volume (previously hard-rejected by vol<3x) -> now enters with S/A score!
 const rows=crash({move:5.5,volume:2.4,wick:0.65});
 const close=Number(rows.at(-1)[4]);
 const candles5m=[...rows,[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']];
 const v=mockVenue(close,{fillMaker:true});
 const ex=new ScalpExecutor({
  config:{...cfg,scaleIn:false,stopLossEnabled:true},
  client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?candles5m:[]):up4h(T0),
  priceOf:async()=>close,markOf:async()=>close,
  balance:async()=>({equity:3000,available:2900}),
  now:()=>T0,
 });
 ex.arm();
 await ex.scan();
 assert.equal(ex.store.open.length,1,'2.4x volume 5.5% aligned reversal passes B7 detector + >=65 score gate');
 assert.ok(ex.store.open[0].scalpScore.score>=70);
 assert.equal(ex.store.open[0].evidence.climaxVolumeRatio,2.4);
});

test('120-coin default universe and scalpDetailsHTML hides unused retracement targets when SCALP_STOP_LOSS=off',()=>{
 const cfg=scalpExecConfig({});
 assert.equal(cfg.universeSize,120);

 const base={
  mode:'TESTNET',credentials:true,armed:true,
  settings:{...cfg,...SCALP_EXEC_SETTINGS,minScore:65,repeatedScaleIn:true},
  stats:{bySide:{},byKind:{},byGrade:{}},
 };
 const offHtml=scalpDetailsHTML({...base,settings:{...base.settings,stopLossEnabled:false}});
 assert.doesNotMatch(offHtml,/목표 38\.2%\/50%\/61\.8% 되돌림/);

 const onHtml=scalpDetailsHTML({...base,settings:{...base.settings,stopLossEnabled:true}});
 assert.match(onHtml,/목표 38\.2%\/50%\/61\.8% 되돌림 \(40\/35\/25%\)/);
});

test('C7 confirmed-bounce sizing (1.35x >=20%, 0.8x <20%), +16% / 25% partial TP defaults, and one-click 수급/CVD buttons',async()=>{
 const {scalpBounceMultiplier,SCALP_MIN_PROFIT_ROE_PCT,SCALP_PARTIAL_TAKE_FRAC}=await import('../scalp_executor.mjs');
 const {venuePositionsHTML}=await import('../public/live_control.js');
 const cfg=scalpExecConfig({});
 assert.equal(SCALP_MIN_PROFIT_ROE_PCT,16);
 assert.equal(SCALP_PARTIAL_TAKE_FRAC,0.25);
 assert.equal(cfg.bounceSizing,true);
 assert.equal(cfg.bounceThresholdPct,20);
 assert.equal(cfg.bounceHighMult,1.35);
 assert.equal(cfg.bounceLowMult,0.8);

 const hi=scalpBounceMultiplier(24.5,cfg);
 assert.equal(hi.confirmed,true);
 assert.equal(hi.mult,1.35);

 const lo=scalpBounceMultiplier(14.2,cfg);
 assert.equal(lo.confirmed,false);
 assert.equal(lo.mult,0.8);

 const off=scalpBounceMultiplier(14.2,{...cfg,bounceSizing:false});
 assert.equal(off.active,false);
 assert.equal(off.mult,1);

 // One-click 수급/CVD button rendered on both Real venue positions and Testnet scalp cards
 const vp=venuePositionsHTML({
  mode:'LIVE',credentials:true,
  venuePositions:[{symbol:'SOLUSDT',direction:'LONG',origin:'manual',size:10,avg:180,mark:185,leverage:10,margin:180,unrealized:50,roePct:27.8}],
  positions:[],
 },[]);
 assert.match(vp,/data-open-orderflow="SOLUSDT"/);
 assert.match(vp,/>수급\/CVD</);

 const card=scalpPositionCardHTML({symbol:'ETHUSDT',direction:'SHORT',leverage:10,size:1,avg:3000,mark:2950,status:'OPEN',scalpScore:{score:75,grade:'A',sizeMult:1.35}});
 assert.match(card,/data-open-orderflow="ETHUSDT"/);
 assert.match(card,/75점 A급 · 1\.35x/);
});

test('gentle forward score tier sizing (0.75/1.0/1.2/1.4x, fixed initial cap), Telegram notice, and 1B UI rules banner',async()=>{
 const {scalpScoreTierMultiplier,SCALP_REPEAT_SCALE_IN}=await import('../scalp_executor.mjs');
 const cfg=scalpExecConfig({});
 assert.equal(cfg.scoreTierSizing,true);
 assert.equal(cfg.defensiveAddRoePct,40);
 assert.equal(cfg.emergencyStopRoePct,75);
 assert.deepEqual(SCALP_REPEAT_SCALE_IN.stepRs.slice(0,2),[1.0,1.5]);
 assert.deepEqual(SCALP_REPEAT_SCALE_IN.qtyMultipliers.slice(0,2),[0.75,0.75]);

 assert.deepEqual(scalpScoreTierMultiplier(65,cfg),{active:true,tier:'B',mult:0.75});
 assert.deepEqual(scalpScoreTierMultiplier(72,cfg),{active:true,tier:'A',mult:1.0});
 assert.deepEqual(scalpScoreTierMultiplier(77,cfg),{active:true,tier:'A+',mult:1.2});
 assert.deepEqual(scalpScoreTierMultiplier(85,cfg),{active:true,tier:'S',mult:1.4});
 assert.deepEqual(scalpScoreTierMultiplier(85,{...cfg,scoreTierSizing:false}),{active:false,tier:null,mult:1});

 const openTg=scalpEventText({type:'OPENED',symbol:'HUSDT',direction:'SHORT',leverage:10,entry:0.1,stop:0.105,stopLossEnabled:false,targets:[0.095],parts:[100],riskUSD:25,movePct:5.2,volumeX:3.4,score:75,grade:'A',sizeMult:1.35,scoreTierMult:1.2});
 assert.match(openTg,/점수 75점\(A급 · 비중 1\.35x · 점수배수 1\.2x\)/);

 const html=scalpDetailsHTML({
  mode:'TESTNET',credentials:true,armed:true,stats:{},
  settings:{
   sides:['LONG','SHORT'],minMovePct:5,zoneMinMovePct:2.5,climaxVolume:2.5,stopLossEnabled:false,repeatedScaleIn:true,
   profitOnlyMaxHoldMin:240,defensiveAddRoePct:40,emergencyStopRoePct:75,maxScaleInAdds:2,
   scaleInSteps:[1,1.5],scaleInMults:[0.75,0.75],minScore:65,scoreTierSizing:true,scoreUnifiedMove:true,
   riskPct:0.75,leverage:10,dailyLossPct:3,maxDriftPct:0.4,
  },
 });
 assert.match(html,/방어추매 -40% · 최후손절 -75%/);
 assert.match(html,/1R→1\.5R · 0\.75x\/0\.75x/);
 assert.match(html,/점수배수 65~69 0\.75x \/ 70~74 1x \/ 75~79 1\.2x \/ 80\+ 1\.4x \(초기캡 고정\)/);
});






