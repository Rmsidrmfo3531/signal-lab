// Reason glossary (public/scalp_reasons.js, user 2026-11-24 "진입 이유에 대한 설명을 어디에다가 정리해줬으면 해",
// "진입 이유 전부, 중복은 제외하고"): every reason code the testnet scalp can emit has one Korean entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {scoreTier,scoreItemClass,reasonHTML,REASON_CATEGORIES,REASON_CODES,REASON_ALIASES,SCORE_ITEMS,reasonInfo,reasonLabel,reasonCode,skipRowHTML,enteredRowHTML,skipDetailHTML,scoreItemsHTML,reasonGlossaryHTML} from '../public/scalp_reasons.js';
import {SCALP_SCORE_WEIGHTS,scoreScalpSetup} from '../scalp_reversal.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {scalpEventText,scalpReasonKo} from '../scalp_telegram.mjs';
import {formatScalpStatusReply} from '../account_alerts.mjs';

const src=f=>fs.readFileSync(fileURLToPath(new URL('../'+f,import.meta.url)),'utf8');
// Upper-case string literals in these files that are NOT reasons (states, order types, symbols, sources, event types).
// A new literal must be added either to the glossary or here, so a new reason code cannot be missed.
const NOT_REASONS=new Set(`AKEUSDT EVAAUSDT BTCUSDT USDT ALIGNED OPPOSED CONFIRMED_RANGE ARMED DISARMED ASIA EUROPE BASE_ASSET BINANCE_KLINES_ BINGX BOTH
 CANCELED CANCELLED CLOSED CLOSE_BEYOND_PREVIOUS CROSSED DOWN ENTERED ESTIMATE ESTIMATE_OTHER_SIDE EXCHANGE EXPIRED EXPLICIT_PAPER_ASSUMPTIONS FAILED FILLED
 FUNDING_FEE INSUFFICIENT_CANDLES LIMIT LIVE LONG SHORT MARK_PRICE MARKET MOVE_RETRACEMENT_50_62_79 MOVE_REVERSAL ZONE_REVERSAL NONE OPEN OPENED ORDER PENDING
 REALIZED REALIZED_AND_OPEN REALIZED_PNL RECONCILE REDUCE REJECTED RESIZE RETRACEMENT SCALE_IN SCALE_IN_ SCALP_REVERSAL SCALP_REVERSAL_ SCALP_PLAN_READY SCAN SELL SKIPPED
 STOP_MARKET SUBMITTING TAKE_PROFIT TAKE_PROFIT_MARKET TESTNET TRADING_FEE VENUE_BOOK VENUE_TICKER WATCH WICK WYCKOFF_STRUCTURE_OBSERVATION PUMP_ALERT READ_DEFERRED
 ORDER_IN_PROGRESS SCAN_FAILED
 STOP_FAILED STOP_PLACED STOP_TO_BREAKEVEN HARD_STOP_PLACED HARD_STOP_UPDATED REAL_MONEY_SCALP SCALE_IN_FILLED SCALE_IN_PENDING PARTIAL_EXIT PARTIAL_TAKE_PROFIT TARGET_FAILED TARGET_RECOVERED CANCEL_FAILED CLOSE_FAILED
 CLOSE_UNCONFIRMED EMERGENCY_CLOSE_FAILED ENTRY_NOT_FILLED ENTRY_RECOVERED RECONCILE_ERROR OTHER_SIDE_SEEN SCALP_STOP_REMOVED SCALP_STOP_CANCEL_PENDING
 SCALP_TARGET_CANCEL_PENDING MANUAL_CLOSE_CLEANUP POSITION_MODE_CHANGED POSITION_SIDE_MISMATCH POSITION_NOT_FOUND SYMBOL_BUSY TESTNET_CLOSE_ONLY
 TRADER_LADDER CURRENT USER FALLBACK MEASURED BETWEEN AT_SPACING COMPLETE STOPPED LADDER_ADD`.split(/\s+/).filter(Boolean));
// Event types and close-button refusals above are shown with their own Korean text elsewhere (scalp_telegram / the close dialog).
const envKeys=text=>new Set([...text.matchAll(/n\('([A-Z0-9_]+)'/g)].map(m=>m[1]));

test('every reason literal in scalp_reversal / scalp_executor / scalp_ladder / testnet_budget has a glossary entry',()=>{
 const missing=[];
 for(const f of ['scalp_reversal.mjs','scalp_executor.mjs','scalp_ladder.mjs','testnet_budget.mjs']){
  const text=src(f),env=envKeys(text);
  for(const [,code] of text.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)){
   if(NOT_REASONS.has(code)||env.has(code))continue;
   if(!reasonInfo(code))missing.push(`${f}: ${code}`);
  }
 }
 assert.deepEqual([...new Set(missing)],[]);
});

test('reason codes from the helpers the scalp calls (squeeze guard, maker entry, position mode, pump alerts) are covered',()=>{
 const missing=[];
 for(const f of ['orderflow.mjs','maker_order.mjs','bingx_position_mode.mjs','pump_alert.mjs']){
  for(const [,code] of src(f).matchAll(/(?:reason|code)\s*:\s*'([A-Z][A-Z0-9_]{3,})'|\|\|\s*'(?:PUMP_[A-Z_]+)'/g))if(code&&!reasonInfo(code))missing.push(`${f}: ${code}`);
 }
 for(const code of ['SHORT_SQUEEZE_GUARD','LONG_SQUEEZE_GUARD','MAKER_STATE_UNCONFIRMED','BINGX_POSITION_MODE_UNKNOWN','PUMP_EVALUATION_FAILED','ENTRY_NOT_SENT','POST_ONLY_REJECTED','MARKET_FAILED'])
  if(!reasonInfo(code))missing.push(code);
 assert.deepEqual(missing,[]);
});

test('each glossary entry: one category, a short label (<= 12 Korean chars), one sentence with the live thresholds',()=>{
 const ex=new ScalpExecutor({config:scalpExecConfig({})}),S=ex.status().settings;
 const cats=new Set(REASON_CATEGORIES.map(([k])=>k)),labels=new Map();
 for(const code of REASON_CODES){
  const i=reasonInfo(code,S);
  assert.ok(cats.has(i.cat),code);
  assert.ok(i.label.replace(/\s/g,'').length<=12,`${code} label too long: ${i.label}`);
  assert.ok(!/설정값/.test(i.desc),`${code} threshold missing in settings: ${i.desc}`);
  assert.match(i.desc,/[다요]\.$|\)\.$/,code);
  assert.ok(!labels.has(i.label),`duplicate label ${i.label}: ${labels.get(i.label)} / ${code}`);labels.set(i.label,code);
 }
 // Aliases are merged, never listed twice.
 for(const [a,to] of Object.entries(REASON_ALIASES)){assert.ok(!REASON_CODES.includes(a),a);assert.equal(reasonCode(a),to)}
 assert.equal(reasonLabel('BTC_PUMP_GUARD'),reasonLabel('BTC_DUMP_GUARD'));assert.equal(reasonLabel('BALANCE_STALE'),reasonLabel('NO_BALANCE'));
 // Thresholds follow the server env (not hard-coded).
 const S2=new ScalpExecutor({config:scalpExecConfig({SCALP_MIN_SCORE:'72',SCALP_DAILY_LOSS_PCT:'2'})}).status().settings;
 assert.match(reasonInfo('SCORE_BELOW_MINIMUM',S2).desc,/72점/);assert.match(reasonInfo('DAILY_LOSS_LIMIT',S2).desc,/2%/);
 assert.match(reasonInfo('NO_VOLUME_CLIMAX',{climaxVolume:2}).desc,/2배/);
 assert.match(reasonInfo('MOVE_ALREADY_RETRACED',{maxRetracedBeforeEntry:.35}).desc,/35%/);
 assert.match(reasonInfo('MOVE_ALREADY_RETRACED',{maxRetracedBeforeEntry:.3}).desc,/30%/);
 const g=reasonGlossaryHTML(S);for(const [,title] of REASON_CATEGORIES)assert.ok(g.includes(title),title);
 for(const code of REASON_CODES)assert.equal(g.split(`">${reasonLabel(code)}</dt>`).length-1,1,code);
});

test('score items match scoreScalpSetup (keys and max points)',()=>{
 const keys=SCORE_ITEMS.filter(([,, max])=>max!=null).map(([k])=>k);
 assert.deepEqual(keys,Object.keys(SCALP_SCORE_WEIGHTS));
 for(const [k,,max] of SCORE_ITEMS)if(max!=null)assert.equal(max,SCALP_SCORE_WEIGHTS[k],k);
 assert.deepEqual(Object.keys(scoreScalpSetup({}).breakdown),keys);
});

test('skip rows: Korean labels instead of codes, no repeated meaning, score as Korean items',()=>{
 const S={wickShare:.35,maxRetracedBeforeEntry:.35,minScore:65,retracements:[.382,.5,.618]};
 const pump=skipRowHTML({at:1,symbol:'ONUSDT',reason:'PUMP_NO_REVERSAL',direction:'SHORT',movePct:12.9,trigger:'PUMP_ALERT',detail:'NO_REJECTION_CANDLE,LAST_CANDLE_AGAINST,NO_REJECTION_CANDLE'},S);
 assert.doesNotMatch(pump,/NO_REJECTION_CANDLE|LAST_CANDLE_AGAINST|PUMP_NO_REVERSAL/);
 assert.equal(pump.split('>반전 봉 없음<').length-1,1);assert.match(pump,/마지막 봉 역방향/);assert.match(pump,/반전 조건 미충족/);
 assert.match(pump,/title="마지막 5분봉에 반전 꼬리\(봉 길이의 35% 이상\)/);
 assert.equal(pump.split('급변 알림').length-1,3,'the trigger badge once (label + title + data-tip), never inside the reason label');
 const acu=skipRowHTML({at:1,symbol:'ACUUSDT',reason:'PUMP_NO_REVERSAL',detail:'MOVE_ALREADY_RETRACED,TARGETS_BEHIND_ENTRY'},S);
 assert.match(acu,/이미 많이 되돌림/);assert.match(acu,/남은 목표 없음/);assert.match(acu,/35%/);
 // The detail repeating the main reason is dropped.
 assert.doesNotMatch(skipDetailHTML({reason:'HTTP_429',detail:'HTTP_429'}),/요청 과다/);
 const old=skipRowHTML({at:1,symbol:'ZECUSDT',reason:'SCORE_BELOW_MINIMUM',direction:'LONG',movePct:3,score:30,grade:'D',detail:'30점/65점 (D급 · 급변5·4H0·BTC0·ATR10·반등10·거래량5·RR0·RSI0)'},S);
 assert.doesNotMatch(old,/급변5·|\(D급 ·/);
 for(const t of ['급변 5','4H 추세 0','BTC 0','ATR 10','반등 10','거래량 5','손익비 0','RSI 0'])assert.ok(old.includes(t),t);
 assert.match(old,/<span class="rz-total rz-g-D rz-fail">합계 <b>30<\/b> D급 · 미달<\/span> <small>\(기준 65\)<\/small>/);assert.match(old,/최대 25점/);
 const rec=scoreScalpSetup({direction:'LONG',evidence:{movePct:3,moveAtr:3.2,retracedPct:20,climaxVolumeRatio:6,rsiPeak:20},netRR:1.3});
 const html=scoreItemsHTML({...rec,breakdown:rec.breakdown,oiBonus:5,score:rec.score+5});
 assert.match(html,/수급 \+5/);assert.match(html,new RegExp(`합계 <b>${rec.score+5}</b>`));
});

test('entered rows say why: kind / trigger, direction, score items, targets and stop',()=>{
 const S={minScore:65};
 const row=enteredRowHTML({type:'OPENED',at:1,symbol:'SOLUSDT',direction:'LONG',kind:'ZONE_REVERSAL',trigger:'PUMP_ALERT',movePct:4.1,entry:100,stop:97,stopLossEnabled:true,targets:[101,102,103],parts:[1,1,0],score:72,grade:'A',minScore:65,
  breakdown:{movePct:15,trend4h:10,btcTrend4h:10,moveAtr:15,retracedPct:10,climaxVolume:5,netRR:5,rsiExtreme:0}},S);
 for(const t of ['진입','매물대 반전','급변 알림','롱(급락 후 반등)','4.1% 움직임','진입 100','목표 101 / 102','손절 97','급변 15','합계 <b>72</b>'])assert.ok(row.includes(t),t);
 assert.doesNotMatch(row,/103/);
 assert.match(enteredRowHTML({type:'OPENED',at:1,symbol:'X',direction:'SHORT',entry:1,stopLossEnabled:false,targets:[]},S),/자동 손절 없음/);
});

test('Telegram and /scalp use the same Korean labels instead of codes',()=>{
 assert.equal(scalpReasonKo('PUMP_NOT_ON_BINGX'),reasonLabel('PUMP_NOT_ON_BINGX'));
 assert.equal(scalpReasonKo('NO_PROTECTIVE_STOP'),reasonLabel('NO_STOP'));
 const t=scalpEventText({type:'ENTRY_OUTCOME_UNKNOWN',symbol:'SOLUSDT',reason:'MAKER_STATE_UNCONFIRMED'});
 assert.doesNotMatch(t,/MAKER_STATE_UNCONFIRMED/);assert.match(t,/지정가 상태 불명/);
 assert.match(scalpEventText({type:'STOP_FAILED',symbol:'X',reason:'some network text'}),/some network text/);
 const r=formatScalpStatusReply({mode:'TESTNET',armed:true,blocked:'DAILY_LOSS_LIMIT'});
 assert.match(r,/진입 중지 \(하루 손실 한도\)/);assert.doesNotMatch(r,/DAILY_LOSS_LIMIT/);
});

test('colours: total by tier with the pass line in words, items by share of max and weight, labels by category',()=>{
 assert.deepEqual([80,75,70,65,64,50,49].map(scoreTier),['S','A+','A','B','C','C','D']);
 assert.equal(scoreItemClass(25,25),'rz-i rz-i-full rz-w-hi');assert.equal(scoreItemClass(10,15),'rz-i rz-i-part rz-w-mid');
 assert.equal(scoreItemClass(0,20),'rz-i rz-i-zero rz-w-hi');assert.equal(scoreItemClass(0,5),'rz-i rz-i-zero rz-w-lo');
 const pass=scoreItemsHTML({score:75,minScore:65,breakdown:{movePct:15,trend4h:20,btcTrend4h:10,moveAtr:15,retracedPct:10,climaxVolume:5,netRR:0,rsiExtreme:0}});
 assert.match(pass,/rz-total rz-g-Ap rz-pass">합계 <b>75<\/b> A\+급 · 통과/);
 assert.match(pass,/class="rz-i rz-i-full rz-w-hi"[^>]*>4H 추세 20</);assert.match(pass,/class="rz-i rz-i-part rz-w-hi"[^>]*>급변 15</);assert.match(pass,/class="rz-i rz-i-zero rz-w-lo"[^>]*>RSI 0</);
 for(const [code,cat] of [['NO_REJECTION_CANDLE','entry'],['SCORE_BELOW_MINIMUM','score'],['DAILY_LOSS_LIMIT','limit'],['PUMP_NO_REVERSAL','pump'],['HTTP_429','venue']])
  assert.match(reasonHTML(code),new RegExp(`class="rz rz-c-${cat}"`),code);
 const css=fs.readFileSync(fileURLToPath(new URL('../public/styles.css',import.meta.url)),'utf8');
 for(const c of ['rz-c-entry','rz-c-score','rz-c-limit','rz-c-pump','rz-c-venue','rz-i-zero.rz-w-hi','rz-total.rz-fail','rz-g-S','rz-g-D'])assert.ok(css.includes('.'+c),c);
 assert.match(css,/:root\[data-theme="light"\]\{--rz-entry/);
});
