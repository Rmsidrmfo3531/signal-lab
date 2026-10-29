// Standalone ZIP diagnostic: public GET only. No .env, account, user ledger,
// application server, Git executable or credentials are read by this command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {diagnoseOrangeXPublic} from './diagnose-orangex-public.mjs';
import {evaluateOrangeXReadiness} from '../orangex_readiness.mjs';

const KIND='ORANGEX_WINDOWS_ONECLICK';
const SOURCES=new Set(['REAL_PUBLIC_OBSERVATION_SUMMARY','SYNTHETIC_TEST']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeVersion=value=>typeof value==='string'&&/^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,40})?$/.test(value)?value.replace(/^v/,''):null;
const safePlatform=value=>['win32','linux','darwin','aix','freebsd','openbsd','sunos','android'].includes(value)?value:'UNRECOGNIZED';
const safeArch=value=>['x64','arm64','ia32','arm','ppc64','riscv64','s390x','loong64'].includes(value)?value:'UNRECOGNIZED';
const fail=code=>Object.assign(Error(code),{code});

// This is a local executable check, not an exchange request. Drain errors and
// return only an allowlisted version; stderr may contain private proxy details.
export function checkCurlEnvironment({spawnProcess=spawn,platform=process.platform,timeoutMs=3000}={}){
 const executable=platform==='win32'?'curl.exe':'curl';
 return new Promise(resolve=>{
  let child,timer,done=false,output='',processError=null;
  const finish=code=>{
   if(done)return;done=true;clearTimeout(timer);
   const match=/^curl (\d{1,3}\.\d{1,3}\.\d{1,3})\b/m.exec(output);
   resolve({executable,available:code===0&&match!==null,version:code===0?match?.[1]??null:null,
    errorCode:code===0&&match?'NONE':processError??(code===0?'CURL_VERSION_UNRECOGNIZED':'CURL_CHECK_FAILED')});
  };
  try{
   child=spawnProcess(executable,['--disable','--version'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',chunk=>{if(output.length<4096)output+=String(chunk).slice(0,4096-output.length)});
   child.stderr.on('data',()=>{});
   child.on('error',error=>{processError=error?.code==='ENOENT'?'CURL_NOT_FOUND':'CURL_CHECK_FAILED'});
   child.on('close',finish);
   timer=setTimeout(()=>{processError='CURL_CHECK_TIMEOUT';child.kill();},timeoutMs);
  }catch{processError='CURL_CHECK_FAILED';finish(null)}
 });
}

function environment(runtime,curl){
 const nodeVersion=safeVersion(runtime.nodeVersion),nodeMajor=nodeVersion===null?null:Number(nodeVersion.split('.')[0]);
 return {nodeVersion,nodeMajor,nodeSupported:nodeMajor!==null&&nodeMajor>=22,
  platform:safePlatform(runtime.platform),architecture:safeArch(runtime.arch),
  launchMode:'STANDALONE_ZIP_NO_GIT',curl,
  proxyAndCertificates:'INHERITED_BY_CURL_WITHOUT_INSPECTION',
  credentialsRequired:false,gitRequired:false,applicationStarted:false};
}
function systemProtectedDirectories(){
 const values=[process.env.SIGNAL_LAB_DATA_DIR];
 values.push(process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'SignalLab'):
  path.join(os.homedir(),'.signal-lab'));
 return values.filter(value=>typeof value==='string'&&value.trim()).map(value=>path.resolve(value));
}
const inside=(candidate,parent)=>{const relative=path.relative(parent,candidate);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)};
function saveReport(report,{tempRoot,protectedDirectories=[]}){
 const canonical=fs.realpathSync(tempRoot);
 if(!fs.statSync(canonical).isDirectory())throw fail('DIAGNOSTIC_TEMP_UNAVAILABLE');
 const directory=path.join(canonical,'SignalLab-OrangeX-Diagnostics');
 for(const parent of [...systemProtectedDirectories(),...protectedDirectories]){
  const resolved=path.resolve(parent),actual=fs.existsSync(resolved)?fs.realpathSync(resolved):resolved;
  if(inside(directory,resolved)||inside(directory,actual))throw fail('DIAGNOSTIC_USER_DATA_PATH_FORBIDDEN');
 }
 let stat;try{stat=fs.lstatSync(directory)}catch(error){if(error.code!=='ENOENT')throw error}
 if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw fail('DIAGNOSTIC_UNSAFE_OUTPUT_DIRECTORY');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const stamp=report.checkedAt.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),suffix=randomBytes(10).toString('hex'),
  file=path.join(directory,`orangex-public-${stamp}-${suffix}.json`),temp=file+'.tmp';
 let fd=null;
 try{
  fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
  if(fs.existsSync(file))throw fail('DIAGNOSTIC_REPORT_ALREADY_EXISTS');
  fs.renameSync(temp,file);return file;
 }finally{if(fd!==null)fs.closeSync(fd);try{fs.unlinkSync(temp)}catch(error){if(error.code!=='ENOENT')throw error}}
}

function unavailableDiagnostic(code,at){
 return {kind:'ORANGEX_PUBLIC_DIAGNOSTIC',mode:'READ_ONLY',checkedAt:at,status:'INCOMPLETE',exitCode:2,
  requests:[],markets:[],listingDiscovery:[],http200Count:0,officialSpecificationVerified:false,
  accountChecked:false,ordersSubmitted:false,paperEnabled:false,errorCode:code};
}

/** probe/runtime/output injections are deliberately test-only. A caller cannot
 * label mocked observations as an actual public connection result. */
export async function runOrangeXWindowsDiagnostic({probe,now=()=>Date.now(),dataSource='REAL_PUBLIC_OBSERVATION_SUMMARY',
 tempRoot=os.tmpdir(),runtime,curlCheck,includeUnverified=true,protectedDirectories=[]}={}){
 if(!SOURCES.has(dataSource)||typeof now!=='function'||typeof includeUnverified!=='boolean'||
  typeof tempRoot!=='string'||!tempRoot.trim()||!Array.isArray(protectedDirectories)||protectedDirectories.some(value=>typeof value!=='string'))throw fail('INVALID_ONECLICK_OPTIONS');
 if(dataSource!=='SYNTHETIC_TEST'&&(probe!==undefined||runtime!==undefined||curlCheck!==undefined||tempRoot!==os.tmpdir()||protectedDirectories.length))
  throw fail('MOCK_INJECTION_REQUIRES_SYNTHETIC_TEST');
 const at=now();if(!Number.isSafeInteger(at)||at<1e12||at>=8640000000000000)throw fail('INVALID_DIAGNOSTIC_CLOCK');
 const checkedAt=new Date(at).toISOString(),runtimeValue=runtime??{nodeVersion:process.versions.node,platform:process.platform,arch:process.arch};
 if(!plain(runtimeValue))throw fail('INVALID_RUNTIME_OBSERVATION');
 let env=environment(runtimeValue,{available:false,version:null,errorCode:'NOT_CHECKED'}),diagnostic;
 if(!env.nodeSupported)diagnostic=unavailableDiagnostic('NODE_22_REQUIRED',checkedAt);
 else{
  let curl;try{curl=await(curlCheck??checkCurlEnvironment)({platform:runtimeValue.platform})}catch{curl={available:false,version:null,errorCode:'CURL_CHECK_FAILED'}}
  env=environment(runtimeValue,{executable:runtimeValue.platform==='win32'?'curl.exe':'curl',available:curl?.available===true,
   version:safeVersion(curl?.version),errorCode:['NONE','CURL_NOT_FOUND','CURL_CHECK_FAILED','CURL_VERSION_UNRECOGNIZED','CURL_CHECK_TIMEOUT'].includes(curl?.errorCode)?curl.errorCode:'CURL_CHECK_FAILED'});
  if(!env.curl.available)diagnostic=unavailableDiagnostic(env.curl.errorCode,checkedAt);
  else{
   try{diagnostic=await diagnoseOrangeXPublic({...(probe?{probe}:{}),now,
    currencies:['BTC','ETH','SPOT',...(includeUnverified?['PERPETUAL']:[])],comparisonMode:true})}
   catch{diagnostic=unavailableDiagnostic('PUBLIC_DIAGNOSTIC_FAILED',checkedAt)}
  }
 }
 const synthetic=dataSource==='SYNTHETIC_TEST';
 const evidence={...diagnostic,dataSource,syntheticTest:synthetic};
 let readiness;try{readiness=evaluateOrangeXReadiness(evidence,{now:now()})}
 catch{readiness={kind:'ORANGEX_OPERATIONAL_READINESS',status:'NOT_READY',checks:[],errorCode:'READINESS_EVALUATION_UNAVAILABLE',realDataAutoEntryEnabled:false,liveOrdersEnabled:false}}
 const report={kind:KIND,version:1,mode:'READ_ONLY',checkedAt,completedAt:new Date(now()).toISOString(),
  dataSource,syntheticTest:synthetic,evidenceForm:'ALLOWLISTED_SUMMARY_NOT_RAW_RESPONSE',rawHttpBodiesIncluded:false,
  actualRequestsRun:!synthetic&&diagnostic.requests.length>0,environment:env,
  status:diagnostic.exitCode===0?'PUBLIC_OBSERVATIONS_COMPLETED':'DIAGNOSTIC_INCOMPLETE',
  exitCode:diagnostic.exitCode,diagnostic,readiness,
  realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,liveOrdersEnabled:false,
  accountChecked:false,ordersSubmitted:false,
  note:synthetic?'합성 테스트 결과입니다. 실제 OrangeX 접속·원문 응답·계약 검증 결과가 아닙니다.':
   '공개 GET 응답의 허용 필드 요약입니다. 원문 응답·헤더는 포함하지 않으며 합성값으로 보충하지 않습니다. 실제 접속 관측과 공식 의미·단위·독립 출처 검증은 다릅니다. 거래 준비 상태는 별도이며 실제 데이터 자동 진입은 OFF입니다.'};
 const file=saveReport(report,{tempRoot,protectedDirectories});return {report,file,exitCode:report.exitCode};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==2)throw fail('INVALID_ONECLICK_OPTIONS');
  const {report,file,exitCode}=await runOrangeXWindowsDiagnostic();
  console.log('OrangeX 공개 GET 진단을 마쳤습니다. 운영 모드는 READ_ONLY, 실제 데이터 자동 진입은 OFF입니다.');
  console.log(`공개 관측 상태: ${report.status} / 운영 준비 상태: ${report.readiness.status}`);
  console.log(`JSON 보고서: ${file}`);console.log('공유할 때는 이 JSON만 사용하고 .env·키·토큰·거래 기록은 첨부하지 마세요.');
  process.exitCode=exitCode;
 }catch{
  console.error('공개 진단 또는 JSON 저장을 완료하지 못했습니다. Node.js 22 이상과 임시 폴더 쓰기 권한을 확인하세요. 기존 기록은 수정하지 않습니다.');
  process.exitCode=3;
 }
}
