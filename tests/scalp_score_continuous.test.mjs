// 1-point scalp score curves (user 2026-11-25 "테스트넷 점수 조건을 더 세분화시켜줘 5점 단위말고 1점 단위로"):
// each item is linear between the old step edges, rounded to a whole point; max per item, total 100, minScore 65,
// grades and size multipliers unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreScalpSetup,scoreCurve,SCALP_SCORE_CURVES,SCALP_SCORE_WEIGHTS,SCALP_SCORE_DEFAULTS,SCALP_REJECTION_FLOOR} from '../scalp_reversal.mjs';

const item=(key,evidence,extra={})=>scoreScalpSetup({direction:'LONG',evidence,...extra}).breakdown[key];

test('movePct: 2%->0, 2.5%->5, 3.5%->15, 5%->25, linear between, capped at 25',()=>{
 for(const [v,p] of [[0,0],[1.9,0],[2.0,0],[2.25,3],[2.5,5],[2.74,7],[3.0,10],[3.3,13],[3.5,15],[4.0,18],[4.25,20],[4.7,23],[5.0,25],[7,25],[40,25]])
  assert.equal(item('movePct',{movePct:v}),p,`movePct ${v}`);
});

test('moveAtr: 2x->0 up to 3x->15, plateau to 4.5x, 6x->10, 9x->5 and 5 beyond (no 0 cliff)',()=>{
 for(const [v,p] of [[1,0],[2,0],[2.5,8],[2.9,14],[3,15],[3.8,15],[4.5,15],[5.0,13],[5.25,13],[5.4,12],[6,10],[7.5,8],[9,5],[12,5],[31.5,5]])
  assert.equal(item('moveAtr',{moveAtr:v}),p,`moveAtr ${v}`);
});

test('retracedPct: 0%->0 up to 15%->10, plateau to 30%, down to 0 at 45%; rejection candle floor 5',()=>{
 for(const [v,p] of [[-3,0],[0,0],[3,2],[7.5,5],[12,8],[15,10],[22,10],[30,10],[33,8],[37.5,5],[42,2],[45,0],[60,0]])
  assert.equal(item('retracedPct',{retracedPct:v}),p,`retraced ${v}`);
 for(const rejection of ['WICK','CLOSE_BEYOND_PREVIOUS']){
  assert.equal(item('retracedPct',{retracedPct:2,rejection}),SCALP_REJECTION_FLOOR,`${rejection} floor`);
  assert.equal(item('retracedPct',{retracedPct:50,rejection}),5);
  assert.equal(item('retracedPct',{retracedPct:12,rejection}),8,'floor does not cap a higher value');
  assert.equal(item('retracedPct',{rejection}),5,'no retraced value: the floor alone');
 }
 assert.equal(item('retracedPct',{retracedPct:2,rejection:'NONE'}),1);
});

test('climaxVolume 2x->0 .. 5x->5, netRR 0.8->0 .. 1.4->5',()=>{
 for(const [v,p] of [[1,0],[2,0],[2.6,1],[3,2],[3.5,3],[4.4,4],[5,5],[9,5]])assert.equal(item('climaxVolume',{climaxVolumeRatio:v}),p,`vol ${v}`);
 for(const [v,p] of [[0.5,0],[0.8,0],[0.9,1],[1.0,2],[1.1,3],[1.2,3],[1.3,4],[1.4,5],[3,5]])
  assert.equal(scoreScalpSetup({netRR:v}).breakdown.netRR,p,`rr ${v}`);
});

test('rsiExtreme: LONG 30->0 .. 18->5, SHORT 70->0 .. 82->5 (mirror)',()=>{
 for(const [v,p] of [[45,0],[30,0],[27,1],[24,3],[22,3],[20,4],[18,5],[5,5]])
  assert.equal(scoreScalpSetup({direction:'LONG',evidence:{rsiPeak:v}}).breakdown.rsiExtreme,p,`long rsi ${v}`);
 for(const [v,p] of [[55,0],[70,0],[73,1],[76,3],[78,3],[80,4],[82,5],[95,5]])
  assert.equal(scoreScalpSetup({direction:'SHORT',evidence:{rsiPeak:v}}).breakdown.rsiExtreme,p,`short rsi ${v}`);
});

test('missing values score 0 (a missing LONG rsiPeak is not RSI 0) and never throw',()=>{
 const empty=scoreScalpSetup({direction:'LONG',evidence:{movePct:null,moveAtr:undefined,retracedPct:'',climaxVolumeRatio:null,rsiPeak:null},netRR:null});
 assert.deepEqual(empty.breakdown,{movePct:0,trend4h:10,btcTrend4h:10,moveAtr:0,retracedPct:0,climaxVolume:0,netRR:0,rsiExtreme:0});
 assert.equal(scoreScalpSetup({evidence:{movePct:'abc',rsiPeak:NaN}}).breakdown.movePct,0);
 assert.equal(scoreScalpSetup({evidence:{movePct:'4.25'}}).breakdown.movePct,20,'numeric strings still count');
});

test('trend items keep 3 levels (fourHourTrend has no strength value)',()=>{
 const t=(dir,coin,btc)=>{const b=scoreScalpSetup({direction:dir,trend4h:coin,btcTrend4h:btc}).breakdown;return [b.trend4h,b.btcTrend4h]};
 assert.deepEqual(t('LONG','up','up'),[20,15]);
 assert.deepEqual(t('LONG','range',null),[10,10]);
 assert.deepEqual(t('LONG','down','down'),[0,0]);
 assert.deepEqual(t('SHORT','down','down'),[20,15]);
 assert.deepEqual(t('SHORT','up','up'),[0,0]);
});

test('every item is a whole number within its max; total <= 100 over a grid of inputs',()=>{
 const W=SCALP_SCORE_WEIGHTS;let n=0,max=0;
 for(const dir of ['LONG','SHORT'])for(const movePct of [1.7,2.3,2.9,3.6,4.4,5.1,9])for(const moveAtr of [1.5,2.7,3.3,4.9,6.6,8.3,20])
  for(const retracedPct of [0,4.4,13.3,21,31.1,40.7,55])for(const climaxVolumeRatio of [1.5,2.9,4.1,6])for(const rsiPeak of [10,19.3,26.6,50,73.3,80.9,92])
   for(const netRR of [0.7,1.07,1.33,2])for(const rejection of ['NONE','WICK']){
    const r=scoreScalpSetup({direction:dir,evidence:{movePct,moveAtr,retracedPct,climaxVolumeRatio,rsiPeak,rejection},trend4h:'up',btcTrend4h:'up',netRR});
    for(const [k,v] of Object.entries(r.breakdown)){assert.ok(Number.isInteger(v)&&v>=0&&v<=W[k],`${k}=${v}`)}
    assert.equal(r.score,Object.values(r.breakdown).reduce((a,b)=>a+b,0));
    assert.ok(r.score<=100);max=Math.max(max,r.score);n++;
   }
 assert.ok(n>10000);assert.equal(max,100,'the full 100 is still reachable');
});

test('scoreCurve: linear between anchors, flat outside, null for non-numbers',()=>{
 assert.equal(scoreCurve(2.75,SCALP_SCORE_CURVES.movePct),7.5);
 assert.equal(scoreCurve(1,SCALP_SCORE_CURVES.movePct),0);
 assert.equal(scoreCurve(99,SCALP_SCORE_CURVES.moveAtr),5);
 assert.equal(scoreCurve(null,SCALP_SCORE_CURVES.netRR),null);
 assert.equal(scoreCurve('x',SCALP_SCORE_CURVES.netRR),null);
 // x.5 rounds up (Math.round), float noise does not flip it: 2.75% -> 7.5 -> 8.
 assert.equal(item('movePct',{movePct:2.75}),8);
 assert.equal(item('moveAtr',{moveAtr:7.5}),8,'7.5 points -> 8');
});

test('gate unchanged: minScore 65, grades and size multipliers on the new totals',()=>{
 assert.equal(SCALP_SCORE_DEFAULTS.minScore,65);assert.equal(SCALP_SCORE_DEFAULTS.highScore,70);
 assert.equal(SCALP_SCORE_DEFAULTS.topScore,80);assert.equal(SCALP_SCORE_DEFAULTS.highSizeMult,1.25);
 // 64 / 65 / 69 / 70 / 79 / 80 built from the curves: base = move 25 + range 10 + range 10 + vol 5 + rsi 5 = 55.
 const at=(atr,retracedPct,rr)=>scoreScalpSetup({direction:'SHORT',evidence:{movePct:5.2,moveAtr:atr,retracedPct,climaxVolumeRatio:6,rsiPeak:85},trend4h:'range',btcTrend4h:'range',netRR:rr});
 const s64=at(9,6,0.8);assert.equal(s64.score,64);assert.equal(s64.pass,false);assert.equal(s64.grade,'C');assert.equal(s64.sizeMult,0);
 const s65=at(9,7.5,0.8);assert.equal(s65.score,65);assert.equal(s65.pass,true);assert.equal(s65.grade,'B');assert.equal(s65.sizeMult,1);
 const s69=at(7.5,9,0.8);assert.equal(s69.score,69);assert.equal(s69.grade,'B');assert.equal(s69.sizeMult,1);
 const s70=at(7.5,9,0.9);assert.equal(s70.score,70);assert.equal(s70.grade,'A');assert.equal(s70.sizeMult,1.25);
 const s79=at(6,20,1.3);assert.equal(s79.score,79);assert.equal(s79.grade,'A');
 const s80=at(6,20,1.4);assert.equal(s80.score,80);assert.equal(s80.grade,'S');assert.equal(s80.sizeMult,1.25);
 assert.match(s64.summary,/^64점\(C급\) · 급변25·4H10·BTC10·ATR5·반등4·거래량5·RR0·RSI5$/);
 assert.equal(s64.shortBreakdown,'급변25·4H10·BTC10·ATR5·반등4·거래량5·RR0·RSI5');
});
