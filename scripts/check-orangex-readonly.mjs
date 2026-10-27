// Explicit public-only connectivity check. Never loads .env, user records,
// private account credentials or a broker order transport.
import {OrangeXReadOnlyAdapter} from '../orangex.mjs';
import {pathToFileURL} from 'node:url';

// Importable reporting logic has no network or credential side effects.
export function publicCheckReport(result,instruments){
 const byName=new Map(result.markets.map(row=>[row.instrumentName,row]));
 const errors=result.errors.map(({code,message,instrumentName,category,httpStatus,transportCode,responseSource})=>
  ({code,message,instrumentName,category,httpStatus,transportCode,responseSource}));
 const requests=instruments.map(instrumentName=>{
  const book=byName.get(instrumentName),error=errors.find(row=>row.instrumentName===instrumentName);
  return {symbol:instrumentName.split('-')[0],instrumentName,listingStatus:'UNVERIFIED',
   bookStatus:book?(book.fresh?'OBSERVED':'STALE_OR_UNDATED'):'FAILED',
   bid:book?.bid??null,ask:book?.ask??null,spreadBps:book?.spreadBps??null,priceAt:book?.priceAt??null,fresh:book?.fresh===true,
   diagnostic:error??null};
 });
 const valid=requests.length>0&&requests.every(row=>row.bookStatus==='OBSERVED');
 const transportFailure=errors.some(row=>['DNS','TLS','TIMEOUT','NETWORK'].includes(row.category));
 const httpFailure=errors.some(row=>['HTTP','AUTH','API'].includes(row.category));
 const dataFailure=errors.some(row=>row.category==='SCHEMA');
 const observed=requests.filter(row=>row.bookStatus!=='FAILED');
 const status=valid?'observed':observed.length&&observed.length<requests.length?'partial':
  transportFailure?'transport_error':httpFailure?'http_error':dataFailure?'schema_error':observed.length?'stale_data':'unverified';
 return {kind:'REAL_PUBLIC_READ_ONLY',status,exitCode:valid?0:transportFailure?2:1,checkedAt:result.checkedAt,
  officialSpecificationVerified:false,accountChecked:false,ordersSubmitted:false,
  requested:[...instruments],requests,observed:result.markets.map(({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})=>
   ({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})),errors,
  note:'공개 SDK 참조 조회 후보입니다. 호가 수신만으로 상장·공식 명세·체결 가능을 확인하지 않습니다. HTTP 응답과 프록시 CONNECT 거부는 별도 증거 없이는 같은 원인으로 판정하지 않습니다.'};
}

async function main(){
 const adapter=new OrangeXReadOnlyAdapter({enabled:true,mode:'READ_ONLY',timeoutMs:4000,maxRetries:0});
 const report=publicCheckReport(await adapter.refresh(),adapter.instruments);
 console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
