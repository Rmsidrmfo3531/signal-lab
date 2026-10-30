// Offline evidence validation only. Does not fetch, load .env or change data.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {evaluateOrangeXReadiness} from '../orangex_readiness.mjs';
import {normalizeOrangeXEvidence} from '../orangex_evidence_review.mjs';
export function readinessOptions(args=[]){
 if(args.length!==2||args[0]!=='--input'||typeof args[1]!=='string'||!args[1]||args[1].startsWith('--'))throw Error('READINESS_INPUT_REQUIRED');
 return {file:args[1]};
}
export function checkOrangeXReadinessFile(file,{now=Date.now()}={}){
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size>4*1024*1024)throw Error('INVALID_READINESS_FILE');
 const input=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 return evaluateOrangeXReadiness(normalizeOrangeXEvidence(input),{now});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const {file}=readinessOptions(process.argv.slice(2)),report=checkOrangeXReadinessFile(file);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='READY'?0:1;
 }catch{console.error('준비 상태 검사 실패. --input <공개 진단 JSON>을 확인하세요. 파일·설정은 변경하지 않습니다.');process.exitCode=2}
}
