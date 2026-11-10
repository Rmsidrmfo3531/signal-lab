// Opt-in live check of the execution venues' PUBLIC market data (BingX, Gate.io).
// GET only, no API key, never reads .env or trade records, never sends orders.
// Usage: npm run test:venues            (default BTCUSDT,ETHUSDT)
//        npm run test:venues -- SOLUSDT,XRPUSDT
//        npm run test:venues -- ETHUSDT --raw   (also prints the venues' raw contract fields)
import {VenueQuoteService,parseVenueSymbols} from '../venue_service.mjs';

const args=process.argv.slice(2),raw=args.includes('--raw'),symbols=parseVenueSymbols(args.find(a=>!a.startsWith('--'))||'BTCUSDT,ETHUSDT');
if(!symbols.length){console.error('종목 형식 오류: 예) BTCUSDT,ETHUSDT');process.exit(2)}
const service=new VenueQuoteService(),started=Date.now(),snapshot=await service.snapshot(symbols);
const venue=(row,name)=>{const v=row.venues[name];
 return {listed:Boolean(v.contract),tradable:v.contract?.tradable??null,contractReasons:v.contract?.reasons??[],
  bookOk:v.book?.ok??false,bid:v.book?.bid??null,ask:v.book?.ask??null,spreadBps:v.book?.spreadBps!=null?Number(v.book.spreadBps.toFixed(2)):null,
  ageMs:v.book?.ageMs??null,bookReasons:v.book?.reasons??[],error:v.error};
};
const report={checkedAt:new Date().toISOString(),durationMs:Date.now()-started,mode:snapshot.mode,ordersEnabled:snapshot.ordersEnabled,
 venues:snapshot.venues,rows:snapshot.rows.map(r=>({symbol:r.symbol,BINGX:venue(r,'BINGX'),GATEIO:venue(r,'GATEIO'),
  crossVenueMidBps:r.crossVenueMidBps!=null?Number(r.crossVenueMidBps.toFixed(2)):null}))};
if(raw)report.rawContracts=Object.fromEntries(symbols.map(symbol=>[symbol,{BINGX:service.clients.BINGX.rawContracts?.get(symbol)??null,GATEIO:service.clients.GATEIO.rawContracts?.get(symbol)??null}]));
console.log(JSON.stringify(report,null,2));
// PC clock vs venue clock. The app corrects for it, but a large gap means Windows time sync is off.
for(const [venue,s] of Object.entries(snapshot.venues)){const off=s.clockOffsetMs;if(Number.isFinite(off))console.log(`${venue} 시계 차이: ${off>0?'거래소가':'PC가'} ${Math.abs(off/1000).toFixed(1)}초 빠름${Math.abs(off)>2000?' → Windows 설정 > 시간 및 언어 > 날짜 및 시간 > [지금 동기화] 권장':''}`)}
const passed=report.rows.length>0&&report.rows.every(r=>r.BINGX.bookOk&&r.GATEIO.bookOk);
console.log(passed?'\n결과: BingX·Gate.io 공개 시세 정상 수신':'\n결과: 일부 시세 수신 실패 — 위 error/bookReasons 확인 (네트워크·지역 제한·종목 미상장 가능)');
process.exitCode=passed?0:1;
