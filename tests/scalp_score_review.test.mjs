// Review of the 1-point scalp score curves (score-continuous, 2026-11-25): consumers of the score that still assumed the
// 5-point steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreScalpSetup,scalpScoreGrade} from '../scalp_reversal.mjs';
import {simulateScalpSignals} from '../scalp_simulator.mjs';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig,scalpScoreTierMultiplier,parseScalpScoreTiers,SCALP_SCORE_TIERS} from '../scalp_executor.mjs';

test('score tier edges: defaults 80/75/70, SCALP_SCORE_TIERS overrides, invalid input keeps the defaults',()=>{
 const d=scalpExecConfig({});
 assert.deepEqual(d.scoreTiers,{S:80,'A+':75,A:70});
 assert.equal(d.topScore,80);assert.equal(d.highScore,70);assert.equal(d.minScore,65);
 const tier=(s,c=d)=>{const t=scalpScoreTierMultiplier(s,c);return `${t.tier}${t.mult}`};
 assert.deepEqual([64,65,69,70,74,75,79,80,100].map(s=>tier(s)),['B0.75','B0.75','B0.75','A1','A1','A+1.2','A+1.2','S1.4','S1.4']);
 const c=scalpExecConfig({SCALP_SCORE_TIERS:'86,81,76',SCALP_MIN_SCORE:'71'});
 assert.deepEqual(c.scoreTiers,{S:86,'A+':81,A:76});
 assert.equal(c.topScore,86,'grade S follows tier S');
 assert.equal(c.highScore,76,'grade A follows tier A when SCALP_HIGH_SCORE is not set');
 assert.equal(c.minScore,71);
 assert.deepEqual([71,75,76,80,81,85,86].map(s=>tier(s,c)),['B0.75','B0.75','A1','A1','A+1.2','A+1.2','S1.4']);
 assert.equal(scalpExecConfig({SCALP_SCORE_TIERS:'86,81,76',SCALP_HIGH_SCORE:'72'}).highScore,72,'an explicit SCALP_HIGH_SCORE wins');
 for(const bad of ['70,75,80','80,75','80,75,70,65','80,75,x','80,75,0','101,75,70','80.5,75,70'])
  assert.deepEqual(parseScalpScoreTiers(bad),{...SCALP_SCORE_TIERS},bad);
 assert.deepEqual(parseScalpScoreTiers(' 90 / 85 / 85 '),{S:90,'A+':85,A:85},'equal edges allowed (empty A tier)');
 // A malformed object passed straight in falls back to the defaults instead of NaN comparisons.
 assert.equal(scalpScoreTierMultiplier(78,{scoreTiers:{S:'x'}}).tier,'A+');
 // The grade of the score follows the same edges.
 const r=scoreScalpSetup({direction:'SHORT',evidence:{movePct:5.2,moveAtr:3.5,retracedPct:20,climaxVolumeRatio:6,rsiPeak:85},trend4h:'range',btcTrend4h:'range',netRR:1.4,config:c});
 assert.equal(r.score,85);assert.equal(r.grade,'A');assert.equal(r.topScore,86);
 assert.equal(scalpScoreGrade(86,c),'S');assert.equal(scalpScoreGrade(70,c),'C');assert.equal(scalpScoreGrade(71,c),'B');
 // Status carries the edges for the screen.
 const S=new ScalpExecutor({config:c}).status().settings;
 assert.deepEqual(S.scoreTiers,{S:86,'A+':81,A:76});assert.equal(S.topScore,86);assert.equal(S.minScore,71);
 assert.deepEqual(S.scoreTierMults,{S:1.4,'A+':1.2,A:1,B:0.75});
 // The opt-in live scalp inherits the same score settings (one SCALP_MIN_SCORE / SCALP_SCORE_TIERS for both).
 const L=scalpLiveExecConfig({SCALP_SCORE_TIERS:'86,81,76',SCALP_MIN_SCORE:'71'});
 assert.equal(L.mode,'OFF');assert.equal(L.minScore,71);assert.deepEqual(L.scoreTiers,{S:86,'A+':81,A:76});
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
