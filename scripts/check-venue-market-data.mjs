// Opt-in live check of the execution venues' PUBLIC market data (BingX, Gate.io).
// GET only, no API key, never reads .env or trade records, never sends orders.
// Usage: npm run test:venues            (default BTCUSDT,ETHUSDT)
//        npm run test:venues -- SOLUSDT,XRPUSDT
import {VenueQuoteService,parseVenueSymbols} from '../venue_service.mjs';

const symbols=parseVenueSymbols(process.argv[2]||'BTCUSDT,ETHUSDT');
if(!symbols.length){console.error('종목 형식 오류: 예) BTCUSDT,ETHUSDT');process.exit(2)}
const started=Date.now(),snapshot=await new VenueQuoteService().snapshot(symbols);
const venue=(row,name)=>{const v=row.venues[name];
 return {listed:Boolean(v.contract),tradable:v.contract?.tradable??null,contractReasons:v.contract?.reasons??[],
  bookOk:v.book?.ok??false,bid:v.book?.bid??null,ask:v.book?.ask??null,spreadBps:v.book?.spreadBps!=null?Number(v.book.spreadBps.toFixed(2)):null,
  ageMs:v.book?.ageMs??null,bookReasons:v.book?.reasons??[],error:v.error};
};
const report={checkedAt:new Date().toISOString(),durationMs:Date.now()-started,mode:snapshot.mode,ordersEnabled:snapshot.ordersEnabled,
 venues:snapshot.venues,rows:snapshot.rows.map(r=>({symbol:r.symbol,BINGX:venue(r,'BINGX'),GATEIO:venue(r,'GATEIO'),
  crossVenueMidBps:r.crossVenueMidBps!=null?Number(r.crossVenueMidBps.toFixed(2)):null}))};
console.log(JSON.stringify(report,null,2));
const passed=report.rows.length>0&&report.rows.every(r=>r.BINGX.bookOk&&r.GATEIO.bookOk);
console.log(passed?'\n결과: BingX·Gate.io 공개 시세 정상 수신':'\n결과: 일부 시세 수신 실패 — 위 error/bookReasons 확인 (네트워크·지역 제한·종목 미상장 가능)');
process.exitCode=passed?0:1;
