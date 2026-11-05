// Diagnostic report includes connection status and public market connectivity only.
// It NEVER includes .env secrets, Telegram tokens, or the user's trade records.
import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir} from './persistence.mjs';

const dataDir=resolveDataDir();
fs.mkdirSync(dataDir,{recursive:true});
const lines=[];
const log=s=>{lines.push(s);console.log(s)};
const stamp=()=>new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
let port=3000;
const envPath=path.join(dataDir,'.env');
if(fs.existsSync(envPath)){
 for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){
  const m=line.match(/^\s*PORT\s*=\s*(\d+)/);if(m){port=Number(m[1]);break}
 }
}
async function inspect(name,url,limit=9000){
 const started=Date.now();
 try{
  const r=await fetch(url,{signal:AbortSignal.timeout(limit),headers:{Accept:'application/json'}});
  let msg=`${name}: HTTP ${r.status} (${Date.now()-started}ms)`;
  if(r.ok){const body=await r.json();
   if(name==='Binance 선물')msg+=` · 상장 데이터 ${Array.isArray(body?.symbols)?body.symbols.length+'건':'형식 확인 필요'}`;
   else if(name==='내부 스캐너'){
    msg+=` · 버전 ${body.version} · 조회모드 ${body.scanMode} · 기술분석 대상 ${body.researchCount||0} · Binance PERP ${body.activeCount||0}`;
    log(`   자동스캔 순환=${body.cycle||0}, 최근 성공=${body.scanSuccess||0}, 실패=${body.scanFailed||0}, 누적 검사=${body.scannedSinceBoot||0}`);
    log(`   최근 스캔=${body.lastScan?new Date(body.lastScan).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'없음'}, BinanceWS=${body.ws}, 봉WS=${body.liveWS}`);
    if(body.marketError)log(`   상장 연결 오류=${String(body.marketError).slice(0,250)}`);
    if(body.lastScanFailures?.length)log(`   캔들 조회 실패=${body.lastScanFailures.slice(0,4).join(' | ').slice(0,350)}`);
   }
  }
  log(msg);
  return r.ok;
 }catch(e){log(`${name}: 실패 (${Date.now()-started}ms): ${String(e.message||e).slice(0,180)}`);return false}
}
log(`Signal Lab Binance 스캐너 진단 · ${stamp()}`);
log('API 토큰, 개인 포지션·거래 내역은 보고서에 포함하지 않습니다.');
log('로컬 서버 연결 확인:');
const local=await inspect('내부 스캐너',`http://127.0.0.1:${port}/api/status`,3500);
if(!local)log('→ 우선 start.bat으로 서버를 실행하고 127.0.0.1 포트 연결을 확인하세요.');
log('공식 공용 데이터 API 연결 확인:');
await inspect('Binance 선물','https://fapi.binance.com/fapi/v1/exchangeInfo');
log('진단 완료. 시그널 0개는 엄격 필터 때문일 수도 있으므로 위 스캔 성공/실패 및 연결 상태를 먼저 확인하세요.');
const out=path.join(dataDir,'scanner_diagnostics.txt');
fs.writeFileSync(out,lines.join('\r\n')+'\r\n','utf8');
log(`결과 파일: ${out}`);
