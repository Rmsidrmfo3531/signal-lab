// Opt-in live smoke check: public GET requests only. Never reads .env/store or sends orders.
// Run separately from the deterministic offline suite: node scripts/check-market-data.mjs
import {analyze} from '../engine.mjs';
import {intersectPerpetualMarkets} from '../markets.mjs';
const destinations={
 binanceListings:'https://fapi.binance.com/fapi/v1/exchangeInfo',
 binance24h:'https://fapi.binance.com/fapi/v1/ticker/24hr',
 binance1h:'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=150',
 binance4h:'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=110',
 variationalListings:'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats'
};
const payloads={},checks=await Promise.all(Object.entries(destinations).map(async([name,url])=>{
 try{
  const response=await fetch(url,{method:'GET',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});
  if(!response.ok)return {name,passed:false,status:response.status};
  const data=await response.json();
  const count=name==='binanceListings'?data?.symbols?.length:name==='variationalListings'?data?.listings?.length:Array.isArray(data)?data.length:null;
  if(!Number.isInteger(count)||count===0)return {name,passed:false,reason:'공용 응답 구조 또는 데이터 개수 확인 필요'};
  payloads[name]=data;
  return {name,passed:true,status:response.status,records:count};
 }catch(error){
  // Report error type/code only; proxy configuration and credentials are never printed.
  return {name,passed:false,errorType:error?.name||'Error',errorCode:error?.cause?.code||(typeof error?.code==='string'?error.code:null)};
 }
}));
let analysis=null,commonContracts=null;
if(checks.every(check=>check.passed)){
 const common=intersectPerpetualMarkets(payloads.binanceListings,payloads.binance24h,payloads.variationalListings);
 commonContracts=common.markets.length;
 const btc=payloads.binance24h.find(row=>row.symbol==='BTCUSDT');
 const result=analyze('BTCUSDT',payloads.binance1h,payloads.binance4h,[],Number(btc?.lastPrice),{quoteVolume:Number(btc?.quoteVolume)});
 analysis={symbol:'BTCUSDT',status:result.status,pattern:result.pattern??null,score:result.score??null,
  technicalQualified:result.technicalQualified===true,dataValid:result.dataValidation?.valid??result.status!=='insufficient'};
}
const connected=checks.every(check=>check.passed);
const validationPassed=connected&&commonContracts>0&&analysis?.dataValid===true;
console.log(JSON.stringify({kind:'REAL_PUBLIC_DATA_READ_ONLY',status:!connected?'blocked':validationPassed?'passed':'failed',validationPassed,checkedAt:new Date().toISOString(),checks,commonContracts,analysis,
 note:'가상 시세 테스트와 별도인 실제 공용 REST 점검. WebSocket·계정 권한·실제 주문·모의 진입 검증은 포함하지 않음.'},null,2));
process.exitCode=!connected?2:validationPassed?0:1;
