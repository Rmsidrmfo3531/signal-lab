// Explicit public-only connectivity check. Never loads .env, user records,
// private account credentials or a broker order transport.
import {OrangeXReadOnlyAdapter} from '../orangex.mjs';
import {pathToFileURL} from 'node:url';

// Importable reporting logic has no network or credential side effects.
export function publicCheckReport(result,instruments){
 const byName=new Map(result.markets.map(row=>[row.instrumentName,row]));
 const details=result.includePublicDetails===true||result.publicDetailsEnabled===true;
 const errors=result.errors.map(({code,message,instrumentName,category,httpStatus,transportCode,responseSource,endpoint})=>
  ({code,message,instrumentName,category,httpStatus,transportCode,responseSource,endpoint}));
 const requests=instruments.map(instrumentName=>{
  const book=byName.get(instrumentName),error=errors.find(row=>row.instrumentName===instrumentName);
  const hasBook=book&&book.bookObserved!==false&&Number.isFinite(book.bid)&&book.bid>0&&Number.isFinite(book.ask)&&book.ask>book.bid;
  return {symbol:instrumentName.split('-')[0],instrumentName,listingStatus:book?.listingStatus??'UNVERIFIED',
   listingObserved:book?.listingObserved===true,active:typeof book?.active==='boolean'?book.active:null,
   bookStatus:hasBook?(book.fresh?'OBSERVED':'STALE_OR_UNDATED'):'FAILED',
   bid:book?.bid??null,ask:book?.ask??null,spreadBps:book?.spreadBps??null,priceAt:book?.priceAt??null,fresh:book?.fresh===true,
   markPrice:book?.markPrice??null,markPriceAt:book?.markPriceAt??null,markPriceFresh:book?.markPriceFresh===true,
   contractFields:book?.contractFields??{},precision:book?.precision??null,feeUnits:'UNVERIFIED',
   diagnostic:error??null,stageErrors:errors.filter(row=>row.instrumentName===instrumentName||row.endpoint==='instruments')};
 });
 const valid=requests.length>0&&requests.every(row=>row.bookStatus==='OBSERVED'&&
  (!details||row.listingObserved&&row.active===true&&row.markPriceFresh))&&(!details||errors.length===0);
 const transportFailure=errors.some(row=>['DNS','TLS','TIMEOUT','NETWORK'].includes(row.category));
 const httpFailure=errors.some(row=>['HTTP','AUTH','API'].includes(row.category));
 const dataFailure=errors.some(row=>row.category==='SCHEMA');
 const observed=requests.filter(row=>row.bookStatus!=='FAILED');
 const status=valid?'observed':observed.length&&observed.length<requests.length?'partial':
  transportFailure?'transport_error':httpFailure?'http_error':dataFailure?'schema_error':
   details&&requests.every(row=>row.bookStatus==='OBSERVED')?'market_validation_failed':observed.length?'stale_data':'unverified';
 return {kind:'REAL_PUBLIC_READ_ONLY',status,exitCode:valid?0:transportFailure?2:1,checkedAt:result.checkedAt,
  officialSpecificationVerified:false,accountChecked:false,ordersSubmitted:false,publicDetailsEnabled:details,
  listingCurrency:result.listingCurrency??null,listingCurrencyVerified:false,
  requested:[...instruments],requests,observed:result.markets.filter(row=>row.bookObserved!==false&&Number.isFinite(row.bid)&&row.bid>0&&Number.isFinite(row.ask)&&row.ask>row.bid).map(({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})=>
   ({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})),errors,
  note:'공개 GET 관측입니다. 필수 매개변수 이름은 사용자 제공 조건을 반영했으며 통화·수량·수수료 의미는 미검증입니다. HTTP 응답만으로 공식 명세·주문 가능을 승인하지 않습니다. 프록시 CONNECT 거부와 원 서버 오류를 구분합니다.'};
}

async function main(){
 const adapter=new OrangeXReadOnlyAdapter({enabled:true,mode:'READ_ONLY',includePublicDetails:true,listingCurrency:'USDT',timeoutMs:4000,maxRetries:0});
 const report=publicCheckReport(await adapter.refresh(),adapter.instruments);
 console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
