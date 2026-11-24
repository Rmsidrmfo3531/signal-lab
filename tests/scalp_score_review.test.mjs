// Review of the 1-point scalp score curves (score-continuous, 2026-11-25): consumers of the score that still assumed the
// 5-point steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreScalpSetup,scalpScoreGrade} from '../scalp_reversal.mjs';
import {simulateScalpSignals} from '../scalp_simulator.mjs';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig,scalpScoreTierMultiplier,parseScalpScoreTiers,SCALP_SCORE_TIERS} from '../scalp_executor.mjs';

test('screen labels follow the gate and grade edges and 1-point totals (no 5-point "55점 이하" / "B급 (65)")',async()=>{
 const {scalpDetailsHTML}=await import('../public/live_control.js');
 const {scoreTier,scoreItemsHTML,reasonInfo}=await import('../public/scalp_reasons.js');
 const html=(env,skips=[])=>{const ex=new ScalpExecutor({config:{...scalpExecConfig(env),management:'CURRENT'}});ex.store.skips.push(...skips);return scalpDetailsHTML(ex.status())};
 const skips=[{at:1,symbol:'XUSDT',reason:'SCORE_BELOW_MINIMUM',score:67},{at:2,symbol:'YUSDT',reason:'SCORE_BELOW_MINIMUM',score:62}];
 const d=html({},skips);
 assert.match(d,/점수배수 70~74 0\.75x \/ 75~79 0\.9x \/ 80~84 1x \/ 85~89 1\.2x \/ 90\+ 1\.4x/);
 assert.match(d,/턱걸이 차단\(65~69점\) <b>1건<\/b> · 하위 차단\(64점 이하\) <b>1건<\/b>/,'62 is below 65, not "60점 이하"');
 for(const l of ['S급 \\(90\\+\\)','A\\+급 \\(85~89\\)','A급 \\(80~84\\)','B\\+급 \\(75~79\\)','B급 \\(70~74\\)'])assert.match(d,new RegExp(l));
 assert.match(reasonInfo('SCORE_BELOW_MINIMUM',scalpExecConfig({})).desc,/기준 70점\(B급\).*70~74 0\.75x/);
 // Gate 77: B is empty and B+ starts at the gate.
 const g77=html({SCALP_MIN_SCORE:'77'},skips);
 assert.match(g77,/점수배수 77~79 0\.9x \/ 80~84 1x \/ 85~89 1\.2x \/ 90\+ 1\.4x/);
 assert.match(g77,/턱걸이 차단\(72~76점\)/);
 assert.match(g77,/B\+급 \(77~79\)/);assert.doesNotMatch(g77,/B급 \(/);
 // Edges moved with SCALP_SCORE_TIERS.
 const t=html({SCALP_SCORE_TIERS:'76,82,88,94'});
 assert.match(t,/점수배수 70~75 0\.75x \/ 76~81 0\.9x \/ 82~87 1x \/ 88~93 1\.2x \/ 94\+ 1\.4x/);
 assert.match(t,/S급 \(94\+\)/);assert.match(t,/B급 \(70~75\)/);
 // Record grade labels and colour classes.
 assert.deepEqual([90,85,80,75,70,69,49].map(x=>scoreTier(x)),['S','A+','A','B+','B','C','D']);
 const S={minScore:77,scoreTiers:{'B+':76,A:82,'A+':88,S:94}};
 assert.equal(scoreTier(76,S),'C','below the gate');assert.equal(scoreTier(77,S),'B+');assert.equal(scoreTier(94,S),'S');
 assert.match(scoreItemsHTML({score:78,minScore:70}),/rz-g-Bp rz-pass">합계 <b>78<\/b> B\+급 · 통과/);
});

test('grade edges: defaults 75/80/85/90 above the 70 gate, SCALP_SCORE_TIERS overrides, invalid input keeps the defaults',()=>{
 const d=scalpExecConfig({});
 assert.deepEqual(d.scoreTiers,{'B+':75,A:80,'A+':85,S:90});
 assert.equal(d.highScore,80);assert.equal(d.minScore,70);
 const tier=(s,c=d)=>{const t=scalpScoreTierMultiplier(s,c);return `${t.tier}${t.mult}`};
 assert.deepEqual([70,74,75,79,80,84,85,89,90,100].map(s=>tier(s)),['B0.75','B0.75','B+0.9','B+0.9','A1','A1','A+1.2','A+1.2','S1.4','S1.4']);
 const c=scalpExecConfig({SCALP_SCORE_TIERS:'76,82,88,94',SCALP_MIN_SCORE:'72'});
 assert.deepEqual(c.scoreTiers,{'B+':76,A:82,'A+':88,S:94});
 assert.equal(c.highScore,82,'highScore (legacy sizing) follows grade A when SCALP_HIGH_SCORE is not set');
 assert.equal(c.minScore,72);
 assert.deepEqual([72,75,76,81,82,87,88,93,94].map(s=>tier(s,c)),['B0.75','B0.75','B+0.9','B+0.9','A1','A1','A+1.2','A+1.2','S1.4']);
 assert.equal(scalpExecConfig({SCALP_SCORE_TIERS:'76,82,88,94',SCALP_HIGH_SCORE:'78'}).highScore,78,'an explicit SCALP_HIGH_SCORE wins');
 for(const bad of ['90,85,80,75','75,80,85','75,80,85,90,95','75,80,x,90','0,80,85,90','75,80,85,101','75.5,80,85,90'])
  assert.deepEqual(parseScalpScoreTiers(bad),{...SCALP_SCORE_TIERS},bad);
 assert.deepEqual(parseScalpScoreTiers(' 75 / 80 / 80 / 90 '),{'B+':75,A:80,'A+':80,S:90},'equal edges allowed (empty A grade)');
 // A malformed object passed straight in falls back to the defaults instead of NaN comparisons.
 assert.equal(scalpScoreTierMultiplier(86,{scoreTiers:{S:'x'}}).tier,'A+');
 // One grade rule: score, size tier and stats.
 const r=scoreScalpSetup({direction:'SHORT',evidence:{movePct:5.2,moveAtr:3.5,retracedPct:20,climaxVolumeRatio:6,rsiPeak:85},trend4h:'range',btcTrend4h:'range',netRR:1.4,config:c});
 assert.equal(r.score,85);assert.equal(r.grade,'A');assert.deepEqual(r.scoreTiers,c.scoreTiers);
 assert.equal(scalpScoreGrade(94,c),'S');assert.equal(scalpScoreGrade(71,c),'C');assert.equal(scalpScoreGrade(72,c),'B');assert.equal(scalpScoreGrade(40,c),'D');
 // Status carries the edges for the screen.
 const S=new ScalpExecutor({config:c}).status().settings;
 assert.deepEqual(S.scoreTiers,{'B+':76,A:82,'A+':88,S:94});assert.equal(S.minScore,72);
 assert.deepEqual(S.scoreTierMults,{B:0.75,'B+':0.9,A:1,'A+':1.2,S:1.4});
 // The opt-in live scalp inherits the same score settings (one SCALP_MIN_SCORE / SCALP_SCORE_TIERS for both).
 const L=scalpLiveExecConfig({SCALP_SCORE_TIERS:'76,82,88,94',SCALP_MIN_SCORE:'72'});
 assert.equal(L.mode,'OFF');assert.equal(L.minScore,72);assert.deepEqual(L.scoreTiers,{'B+':76,A:82,'A+':88,S:94});
 assert.equal(scalpLiveExecConfig({}).minScore,70);
});

test('simulator re-scores recorded signals on the current curves (+ recorded OI/CVD bonus), not the saved 5-point total',()=>{
 const now=Date.parse('2026-11-25T06:00:00Z');
 const common={direction:'SHORT',kind:'MOVE_REVERSAL',trend4h:'range',btcTrend4h:null,withTrend:true,plan:{netRR:0.9}};
 const evA={movePct:5.2,moveAtr:7.5,retracedPct:20,climaxVolumeRatio:6,rsiPeak:76,rejection:'NONE'};
 const evB={...evA,movePct:4.2,rsiPeak:74};
 // Saved totals are what the 5-point steps gave at the time: A 65 (25+10+10+5+10+5+0+0), B 55 (15+10+10+5+10+5+0+0).
 assert.equal(scoreScalpSetup({...common,evidence:evA,netRR:0.9}).score,72);
 assert.equal(scoreScalpSetup({...common,evidence:evB,netRR:0.9}).score,66);
 const signals=[
  {...common,at:now-100000,barAt:now-120000,symbol:'AUSDT',evidence:evA,entered:true,reason:null,score:{score:65,grade:'B',minScore:65}},
  {...common,at:now-200000,barAt:now-220000,symbol:'BUSDT',evidence:evB,entered:false,reason:'SCORE_BELOW_MINIMUM',score:{score:55,grade:'C',minScore:65}},
  {...common,at:now-300000,barAt:now-320000,symbol:'CUSDT',evidence:evB,entered:false,reason:'SCORE_BELOW_MINIMUM',score:{score:60,grade:'C',minScore:65,oiBonus:5}},
  // No recorded inputs: the saved total is all there is.
  {at:now-400000,barAt:now-420000,symbol:'DUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:true,reason:null,withTrend:true,score:{score:80,grade:'S'},plan:{netRR:1.3}},
 ];
 const trades=[{symbol:'AUSDT',direction:'SHORT',barAt:now-120000,kind:'MOVE_REVERSAL',evidence:evA,trend4h:'range',withTrend:true,plan:{tp1NetR:0.9},exit:{at:now-50000},pnl:{netUSD:7,r:0.7}}];
 const run=minScore=>simulateScalpSignals({signals,trades,params:{days:7,minMovePct:2.5,trendMode:'off',zoneSignals:true,minNetRR:0,minScore},now,includePresets:false});

 const g70=run(70);
 assert.equal(g70.signalSummary.filteredOut,0,'A scores 72 now: a 70 gate keeps it (the saved 65 would drop it)');
 assert.equal(g70.simulated.trades,1);
 assert.equal(g70.simulated.unlockedByReason.SCORE_BELOW_MINIMUM,1,'C = 66 + recorded OI bonus 5 = 71 passes; B = 66 does not');
 const g65=run(65);
 assert.equal(g65.simulated.unlockedByReason.SCORE_BELOW_MINIMUM,2,'B 66 and C 71 both pass a 65 gate');
 assert.equal(run(73).signalSummary.filteredOut,1,'A (72) drops at 73');
 // D has no evidence: the saved 80 decides.
 assert.equal(run(80).signalSummary.filteredOut,1);
 assert.equal(run(81).signalSummary.filteredOut,2);
});
