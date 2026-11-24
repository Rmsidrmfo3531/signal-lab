// Review of the 1-point scalp score curves (score-continuous, 2026-11-25): consumers of the score that still assumed the
// 5-point steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreScalpSetup} from '../scalp_reversal.mjs';
import {simulateScalpSignals} from '../scalp_simulator.mjs';

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
