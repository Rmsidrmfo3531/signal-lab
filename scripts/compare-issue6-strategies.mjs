// Read an explicitly selected research JSON. Never loads .env or user stores.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {compareIssue6Strategies} from '../strategy_validation.mjs';

export function strategyComparisonOptions(args=[]){
 if(args.length!==2||args[0]!=='--input'||typeof args[1]!=='string'||!args[1]||args[1].startsWith('--'))throw Error('RESEARCH_JSON_INPUT_REQUIRED');
 return {file:args[1]};
}
export function compareIssue6File(file){
 const fd=fs.openSync(file,'r');let bytes;
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>32*1024*1024)throw Error('RESEARCH_JSON_FILE_LIMIT');
  bytes=fs.readFileSync(fd);if(bytes.length>32*1024*1024)throw Error('RESEARCH_JSON_FILE_LIMIT');
 }finally{fs.closeSync(fd)}
 return {...compareIssue6Strategies(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))),
  sourceSHA256:createHash('sha256').update(bytes).digest('hex'),inputUnchanged:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(compareIssue6File(strategyComparisonOptions(process.argv.slice(2)).file),null,2))}
 catch{console.error('비교 검증 실패. --input 과거 캔들·체결·명시적 모의 원장 JSON을 확인하세요. 사용자 기록은 변경하지 않습니다.');process.exitCode=2}
}
