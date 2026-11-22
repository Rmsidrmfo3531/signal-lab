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

function mockVenue(fillAt=PX){
 const calls=[];let amt=0,avg=0,id=1;
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(avg),unrealizedProfit:'0'}]:[],
  openOrders:async()=>({orders:[]}),getOrder:async()=>({order:null}),cancelOrder:async()=>({}),
  placeOrder:async(p)=>{calls.push(p);if(p.type==='MARKET'){const q=Number(p.quantity);avg=fillAt;amt=p.side==='SELL'?-q:q;return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(avg)}}}return {order:{orderId:String(id++),status:'NEW'}}}};
 return {client,calls};
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
   config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false,...extraCfg},
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
});
