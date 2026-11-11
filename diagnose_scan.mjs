// Diagnostic report includes connection status and public market connectivity only.
// It NEVER includes .env secrets, Telegram tokens, or the user's trade records.
import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir} from './persistence.mjs';

const dataDir=resolveDataDir();
fs.mkdirSync(dataDir,{recursive:true});
// Copies for the user go to the program folder (where the .bat runs); tests point this elsewhere.
const reportDir=process.env.SIGNAL_LAB_REPORT_DIR||process.cwd();
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
    // Counts only (reason codes, no prices or positions): why technically passed setups still have no target plan.
    const f=body.scanFunnel||{};
    log(`   최근 분석 ${f.uniqueAnalyzed??'-'}종 · 패턴 발견 ${f.patternCount??'-'} · 기술검증 통과 ${f.technicalPassed??'-'} · 호가·목표가까지 통과(최종 신호) ${f.venuePassed??'-'}`);
    if(Array.isArray(f.topReasons)&&f.topReasons.length)log(`   탈락 사유 상위=${f.topReasons.slice(0,6).map(x=>typeof x==='string'?x:`${x.reason??x.label??''} ${x.count??''}`).join(' | ').slice(0,400)}`);
    const vo=body.venueOnly;
    if(vo)log(`   바이낸스 미상장 코인(Gate.io·BingX 차트)=${vo.enabled?vo.count+'종':'꺼짐'}`+(vo.minMarketCap?` · 시총 기준 ${(vo.minMarketCap/1e6).toFixed(1)}M$(${vo.marketCapSource==='REFERENCE'?'기준 코인 시총×비율':'최소값'})`:'')+(vo.threshold?` · 거래대금 ${(vo.threshold/1e6).toFixed(1)}M$ 이상 후보 ${vo.beforeMarketCap??'-'}종`:'')+(vo.droppedByMarketCap?` · 시총 제외 ${JSON.stringify(vo.droppedByMarketCap)}`:'')+(vo.error?` · 오류 ${String(vo.error).slice(0,120)}`:''));
    const m=x=>x==null?'시총?':(x/1e6).toFixed(1)+'M$';
    if(Array.isArray(vo?.kept)&&vo.kept.length)log(`     포함: `+vo.kept.map(c=>`${c.symbol}(시총 ${m(c.marketCap)}·거래 ${(c.quoteVolume/1e6).toFixed(1)}M$)`).join(', '));
    const why={MCAP_UNKNOWN:'시총 미확인',MCAP_TOO_SMALL:'시총 부족',VOLUME_TO_MCAP_TOO_HIGH:'거래대금 과다'};
    if(Array.isArray(vo?.droppedSample)&&vo.droppedSample.length)log(`     제외: `+vo.droppedSample.map(c=>`${c.symbol}(${why[c.reason]||c.reason}${c.marketCap?' '+m(c.marketCap):''}·거래 ${(c.quoteVolume/1e6).toFixed(1)}M$)`).join(', '));
    const plan=body.scanFunnel?.targetPlan;
    if(plan&&Number.isFinite(plan.technicalCandidates)){
     const blocked=Array.isArray(plan.blocked)?plan.blocked.slice(0,4).map(x=>`${x.reason} ${x.count}종`).join(' | ').slice(0,300):'';
     log(`   기술 검증 통과 ${plan.technicalCandidates}종 중 매물대 목표가 준비 ${plan.ready||0}종`+(blocked?` · 보류 사유=${blocked}`:''));
    }
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
// Full list of the symbols being checked, as a CSV next to the program (open it in Excel).
if(local){try{
 const r=await fetch(`http://127.0.0.1:${port}/api/scan/universe`,{signal:AbortSignal.timeout(5000)});
 if(r.ok){const u=await r.json(),esc=v=>v==null?'':String(v).replace(/[",\r\n]/g,' ');
  const csv=['번호,종목,차트,24h거래대금USD,시가총액USD,분석됨,최근패턴,점수',...u.rows.map((x,i)=>[i+1,x.symbol,x.chart,Math.round(x.quoteVolume||0),x.marketCap?Math.round(x.marketCap):'',x.analyzed?'Y':'',esc(x.pattern),x.score??''].join(','))].join('\r\n');
  const file=path.join(reportDir,'scan_universe.csv');fs.writeFileSync(file,'\ufeff'+csv+'\r\n','utf8');
  log(`검사 대상 전체 ${u.count}종 (바이낸스 ${u.binance} + 바이낸스 미상장 ${u.venueOnly}) → ${file}`);
 }
}catch(e){log('검사 대상 목록 저장 실패: '+String(e.message||e).slice(0,120))}}
log('공식 공용 데이터 API 연결 확인:');
await inspect('Binance 선물','https://fapi.binance.com/fapi/v1/exchangeInfo');
log('진단 완료. 시그널 0개는 엄격 필터 때문일 수도 있으므로 위 스캔 성공/실패 및 연결 상태를 먼저 확인하세요.');
const out=path.join(dataDir,'scanner_diagnostics.txt');
fs.writeFileSync(out,lines.join('\r\n')+'\r\n','utf8');
try{fs.writeFileSync(path.join(reportDir,'scanner_diagnostics.txt'),lines.join('\r\n')+'\r\n','utf8')}catch{}
log(`결과 파일: ${out} (프로그램 폴더에도 scanner_diagnostics.txt 저장)`);
