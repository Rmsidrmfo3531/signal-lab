// Offline execution only: no application server, .env, fetch, WebSocket or API.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {OrangeXPaperService} from '../orangex_paper_service.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12;
export function runOrangeXPaperScenario(scenario,{directory,resume=false}={}){
 if(!plain(scenario)||scenario.kind!=='ORANGEX_PAPER_SCENARIO'||scenario.dataSource!=='SYNTHETIC_FIXTURE'||
  !Array.isArray(scenario.events)||!scenario.events.length||scenario.events.length>10000||typeof directory!=='string'||!directory.trim())
  throw Error('INVALID_OFFLINE_SCENARIO');
 let previous=0;
 for(const event of scenario.events){
  if(!plain(event)||!stamp(event.at)||event.at<previous||
   !['SIGNAL','MARKET','FUNDING','CLOSE','CANCEL','CONFIGURE'].includes(event.type))throw Error('INVALID_OFFLINE_SCENARIO_EVENT');
  if(event.type==='MARKET'&&event.market?.dataSource!=='SYNTHETIC_FIXTURE'||
   event.type==='FUNDING'&&event.funding?.dataSource!=='SYNTHETIC_FIXTURE')throw Error('ACTUAL_DATA_INPUT_DISABLED');
  previous=event.at;
 }
 let now=scenario.events[0].at;
 const service=new OrangeXPaperService({directory,now:()=>now,writable:true});
 try{
  const snapshot=service.snapshot();
  if(snapshot.recordsUnavailable)throw Error('OFFLINE_RECORDS_UNAVAILABLE');
  if(snapshot.storage.exists){
   if(!resume)throw Error('OFFLINE_RECORDS_ALREADY_EXIST_USE_RESUME');
   const stored=service.engine.exportState();
   for(const [key,value]of Object.entries(scenario.settings??{}))
    if(stored.settings[key]!==value)throw Error('RESUME_CONFIGURATION_MISMATCH');
   for(const contract of scenario.contracts??[]){
    const saved=stored.contracts[contract.instrumentName];
    if(!saved||Object.entries(contract).some(([key,value])=>saved[key]!==value))throw Error('RESUME_CONTRACT_MISMATCH');
   }
   if(stamp(stored.updatedAt)&&now<stored.updatedAt)throw Error('RESUME_CLOCK_MOVED_BACKWARDS');
  }else{
   if(!plain(scenario.settings)||!Array.isArray(scenario.contracts)||!scenario.contracts.length)throw Error('OFFLINE_CONFIGURATION_REQUIRED');
   service.configure(scenario.settings);
   for(const contract of scenario.contracts)service.setContract(contract);
  }
  const results=[];
  for(const event of scenario.events){
   now=event.at;let result;
   if(event.type==='SIGNAL')result=service.submitSignal(event.signal,{dataSource:'SYNTHETIC_FIXTURE',
    orderType:event.orderType??'MARKET',limitPrice:event.limitPrice});
   if(event.type==='MARKET')result=service.onMarket(event.market);
   if(event.type==='FUNDING')result=service.applyFunding(event.funding);
   if(event.type==='CLOSE')result=service.closePosition(event.key);
   if(event.type==='CANCEL')result=service.cancelOrder(event.key);
   if(event.type==='CONFIGURE')result=service.configure(event.settings);
   results.push({type:event.type,at:event.at,result});
  }
  return {kind:'ORANGEX_PAPER_SCENARIO_RESULT',mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',
   realDataAutoEntryEnabled:false,liveOrdersEnabled:false,results,snapshot:service.snapshot()};
 }finally{service.close()}
}

export function offlineOptions(args=[]){
 const options={resume:false};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--resume'&&!options.resume){options.resume=true;continue}
  const key={'--scenario':'scenarioFile','--data-dir':'directory'}[args[i]];
  if(!key||options[key]||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_OFFLINE_OPTIONS');
  options[key]=args[++i];
 }
 if(!options.scenarioFile||!options.directory)throw Error('EXPLICIT_SCENARIO_AND_DATA_DIRECTORY_REQUIRED');
 return options;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const {scenarioFile,...options}=offlineOptions(process.argv.slice(2)),stat=fs.statSync(scenarioFile);
  if(!stat.isFile()||stat.size>2*1024*1024)throw Error('INVALID_SCENARIO_FILE');
  const scenario=JSON.parse(fs.readFileSync(scenarioFile,'utf8').replace(/^\uFEFF/,''));
  console.log(JSON.stringify(runOrangeXPaperScenario(scenario,options),null,2));
 }catch{
  console.error('오프라인 PAPER 실행 실패. 합성 시나리오와 별도 저장 경로·기존 파일·검증 사유를 확인하세요. 기존 기록은 초기화하지 않습니다.');
  console.error('사용법: node scripts/orangex-paper-offline.mjs --scenario <합성 JSON> --data-dir <별도 orangex-paper 폴더> [--resume]');
  process.exitCode=1;
 }
}
