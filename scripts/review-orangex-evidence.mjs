// Public diagnostic JSON only; no .env, network, mode changes or output files.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {reviewOrangeXEvidence} from '../orangex_evidence_review.mjs';
export function evidenceReviewOptions(args=[]){
 if(args.length!==2||args[0]!=='--input'||typeof args[1]!=='string'||!args[1]||args[1].startsWith('--'))throw Error('PUBLIC_JSON_INPUT_REQUIRED');
 return {file:args[1]};
}
export function reviewOrangeXEvidenceFile(file,{now=Date.now()}={}){
 const fd=fs.openSync(file,'r');let bytes;
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4*1024*1024)throw Error('INVALID_PUBLIC_JSON_FILE');
  bytes=fs.readFileSync(fd);if(bytes.length>4*1024*1024)throw Error('PUBLIC_JSON_TOO_LARGE');
 }finally{fs.closeSync(fd)}
 return reviewOrangeXEvidence(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),{now,sourceSHA256:createHash('sha256').update(bytes).digest('hex')});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=reviewOrangeXEvidenceFile(evidenceReviewOptions(process.argv.slice(2)).file);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='READY'?0:1;
 }catch{console.error('공개 진단 JSON 검토 실패. --input 파일과 자료 형식을 확인하세요. 입력·사용자 기록은 변경하지 않습니다.');process.exitCode=2}
}
