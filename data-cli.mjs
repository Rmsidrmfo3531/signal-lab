import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareData,resolveDataDir,readStore,backupStore,importLegacy,atomicWriteStore,isLocked} from './persistence.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const [command,arg,flag]=process.argv.slice(2);
try{
 const dir=resolveDataDir();
 if(command==='path'){console.log(dir)}
 else if(command==='backup'){
  const storage=prepareData(root);const file=backupStore(storage.storePath);
  if(!file)throw Error('기록 파일이 없습니다. 사이트를 한 번 실행하세요.');
  console.log('백업 완료:',file);
 }else if(command==='import'){
  if(!arg)throw Error('가져올 이전 버전 폴더를 지정하세요.');
  if(isLocked(dir))throw Error('기록 가져오기 전 Signal Lab 서버를 종료하세요.');
  const result=importLegacy(arg,dir,{replace:flag==='--replace'});
  console.log('기록 가져오기 완료:',JSON.stringify(result,null,2));
 }else if(command==='restore'){
  if(!arg)throw Error('복원할 백업 store-*.json 경로를 지정하세요.');
  if(isLocked(dir))throw Error('복원 전 Signal Lab 서버를 종료하세요.');
  const src=path.resolve(arg),record=readStore(src);
  if(!record)throw Error('백업 파일을 찾지 못했습니다.');
  const dataPath=path.join(dir,'store.json');fs.mkdirSync(dir,{recursive:true});
  const previous=backupStore(dataPath);
  atomicWriteStore(dataPath,record);
  console.log('복원 완료. 이전 데이터 백업:',previous||'(없음)');
 }else{
  console.log('사용법: node data-cli.mjs path | backup | import "이전 버전 폴더" | restore "백업 JSON 경로"');
  process.exitCode=2;
 }
}catch(e){console.error('[DATA ERROR]',e.message);process.exitCode=1}
