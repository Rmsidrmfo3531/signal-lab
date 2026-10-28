// Offline JSON replay. Does not load .env, open a socket or read a user ledger.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runOrangeXPaperReplay} from '../orangex_paper_replay.mjs';
import {OrangeXPaperReplayStore} from '../orangex_paper_replay_store.mjs';
import {analyzeOrangeXPaperPerformance,auditOrangeXPaperAccounting} from '../orangex_paper_performance.mjs';

export function replayOptions(args=[]){
 const options={};
 for(let index=0;index<args.length;index++){
  const key={'--input':'inputFile','--output-dir':'directory'}[args[index]];
  if(!key||options[key]||!args[index+1]||args[index+1].startsWith('--'))throw Error('INVALID_REPLAY_OPTIONS');
  options[key]=args[++index];
 }
 if(!options.inputFile)throw Error('EXPLICIT_REPLAY_INPUT_REQUIRED');return options;
}
export function replayReport(input,{directory}={}){
 const result=runOrangeXPaperReplay(input);
 if(result.snapshot){
  result.performance=analyzeOrangeXPaperPerformance(result.snapshot,{now:result.endAt});
  result.accountingAudit=auditOrangeXPaperAccounting(result.snapshot,{now:result.endAt});
 }else{result.performance=null;result.accountingAudit=null}
 if(directory)new OrangeXPaperReplayStore({directory}).write(result);
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const {inputFile,...options}=replayOptions(process.argv.slice(2)),stat=fs.statSync(inputFile);
  if(!stat.isFile()||stat.size>24*1024*1024)throw Error('INVALID_REPLAY_INPUT_FILE');
  const input=JSON.parse(fs.readFileSync(inputFile,'utf8').replace(/^\uFEFF/,''));
  console.log(JSON.stringify(replayReport(input,options),null,2));
 }catch{
  console.error('재생 실패. 입력 출처·확정봉·시각 순서·출력 경로를 확인하세요. 기존 기록은 덮어쓰지 않습니다.');
  console.error('사용법: node scripts/orangex-paper-replay.mjs --input <JSON> [--output-dir <새 실험 폴더>]');process.exitCode=1;
 }
}
