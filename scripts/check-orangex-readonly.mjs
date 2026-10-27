// Explicit public-only connectivity check. Never loads .env, user records,
// private account credentials or a broker order transport.
import {OrangeXReadOnlyAdapter} from '../orangex.mjs';

const adapter=new OrangeXReadOnlyAdapter({enabled:true,mode:'READ_ONLY',timeoutMs:4000,maxRetries:0});
const result=await adapter.refresh();
const valid=result.markets.length===adapter.instruments.length&&result.markets.every(row=>row.fresh);
const dataFailure=result.errors.some(row=>row.code==='INVALID_RESPONSE');
console.log(JSON.stringify({kind:'REAL_PUBLIC_READ_ONLY',status:valid?'observed':dataFailure||result.connected?'failed':'blocked',
 checkedAt:result.checkedAt,officialSpecificationVerified:false,accountChecked:false,ordersSubmitted:false,
 requested:adapter.instruments,observed:result.markets.map(({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})=>
  ({instrumentName,bid,ask,spreadBps,priceAt,fresh,tradable})),
 errors:result.errors.map(({code,message,instrumentName})=>({code,message,instrumentName})),
 note:'공개 SDK 참조 프로토콜의 읽기 요청만 점검합니다. 성공하더라도 상장·주문 단위·공식 명세·실제 체결 검증을 의미하지 않습니다.'},null,2));
process.exitCode=valid?0:dataFailure||result.connected?1:2;
