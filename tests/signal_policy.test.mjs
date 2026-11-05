import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolveSignalScorePolicy} from '../signal_policy.mjs';

test('default and configured final score thresholds remain explicitly unvalidated and never approve LIVE',()=>{
 for(const [env,expected,source] of [[{},90,'DEFAULT'],[{SIGNAL_FINAL_MIN_SCORE:'95'},95,'CONFIGURED'],[{SIGNAL_FINAL_MIN_SCORE:'100'},100,'CONFIGURED']]){
  const result=resolveSignalScorePolicy(env);
  assert.equal(result.finalMinScore,expected);assert.equal(result.source,source);
  for(const key of ['validationStatus','performanceValidation','outOfSampleValidation','walkForwardValidation'])assert.equal(result[key],'UNVERIFIED');
  assert.equal(result.liveApproval,false);assert.equal(result.scoreIsWinProbability,false);
 }
 for(const raw of ['89','0','101','NaN','90.5','90xyz','-1',true])assert.throws(()=>resolveSignalScorePolicy({SIGNAL_FINAL_MIN_SCORE:raw}),/90~100/);
});

test('after loading settings the quality and analysis modules share the configured threshold through a live binding',()=>{
 const moduleURL=new URL('../signal_policy.mjs',import.meta.url).href,qualityURL=new URL('../quality.mjs',import.meta.url).href;
 const code=`import {configureSignalScorePolicy,getSignalScorePolicy} from ${JSON.stringify(moduleURL)};
 import {STRICT_MIN_SCORE} from ${JSON.stringify(qualityURL)};
 if(STRICT_MIN_SCORE!==90)process.exit(11);
 configureSignalScorePolicy({SIGNAL_FINAL_MIN_SCORE:'96'});
 if(STRICT_MIN_SCORE!==96||getSignalScorePolicy().liveApproval!==false)process.exit(12);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,SIGNAL_FINAL_MIN_SCORE:''}});
 assert.equal(result.status,0,result.stderr);
});
