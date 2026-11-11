// How many Binance USDT perpetuals can actually be traded on BingX / Gate.io.
// Public GET only, no API key. Usage: node scripts/venue-overlap.mjs  (or venue_overlap.bat)
// Names are matched exactly (BTCUSDT = BTC-USDT = BTC_USDT). A coin listed under a different
// name (e.g. 1000PEPEUSDT on Binance, PEPE_USDT on Gate.io) is NOT matched on purpose:
// the contract sizes differ, so the app never trades it as the same coin.
import fs from 'node:fs';
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(url+' HTTP '+r.status);return r.json()};
const [info,tickers,gate,bingx]=await Promise.all([
 get('https://fapi.binance.com/fapi/v1/exchangeInfo'),get('https://fapi.binance.com/fapi/v1/ticker/24hr'),
 get('https://api.gateio.ws/api/v4/futures/usdt/contracts'),get('https://open-api.bingx.com/openApi/swap/v2/quote/contracts')]);
const vol=new Map(tickers.map(t=>[t.symbol,Number(t.quoteVolume)]));
const binance=info.symbols.filter(s=>s.contractType==='PERPETUAL'&&s.status==='TRADING'&&s.quoteAsset==='USDT').map(s=>s.symbol);
const gateSet=new Set(gate.filter(c=>!c.in_delisting).map(c=>String(c.name).replace('_','')));
const bingxSet=new Set((bingx.data||[]).filter(c=>c.status===1||c.status===undefined).map(c=>String(c.symbol).replace('-','')));
const minVol=Number(process.env.MIN_DAILY_VOLUME_USDT||5000000);
const rows=binance.map(symbol=>({symbol,volume:vol.get(symbol)||0,gate:gateSet.has(symbol),bingx:bingxSet.has(symbol)})).sort((a,b)=>b.volume-a.volume);
const count=(list,f)=>list.filter(f).length,big=rows.filter(r=>r.volume>=minVol);
const lines=[`확인 시각 ${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} KST`,
 `바이낸스 USDT 무기한 ${rows.length}개 · Gate.io ${gateSet.size}개 · BingX ${bingxSet.size}개`,'',
 `[전체] 둘 중 한 곳이라도 거래 가능 ${count(rows,r=>r.gate||r.bingx)} / ${rows.length}  (둘 다 ${count(rows,r=>r.gate&&r.bingx)}, Gate만 ${count(rows,r=>r.gate&&!r.bingx)}, BingX만 ${count(rows,r=>!r.gate&&r.bingx)}, 둘 다 없음 ${count(rows,r=>!r.gate&&!r.bingx)})`,
 `[24h 거래대금 ${(minVol/1e6).toFixed(0)}M$ 이상] 거래 가능 ${count(big,r=>r.gate||r.bingx)} / ${big.length}`,'',
 '바이낸스에만 있는 종목 (거래대금 순, 최대 40개):',
 ...rows.filter(r=>!r.gate&&!r.bingx).slice(0,40).map(r=>`  ${r.symbol.padEnd(18)} ${(r.volume/1e6).toFixed(1)}M$`)];
console.log(lines.join('\n'));
fs.mkdirSync('backtest-results',{recursive:true});fs.writeFileSync('backtest-results/venue-overlap.txt',lines.join('\r\n'));
console.log('\n저장: backtest-results\\venue-overlap.txt');
