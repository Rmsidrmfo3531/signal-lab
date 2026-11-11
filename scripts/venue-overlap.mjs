// How many Binance USDT perpetuals can actually be traded on BingX / Gate.io.
// Public GET only, no API key. Usage: node scripts/venue-overlap.mjs  (or venue_overlap.bat)
// Names are matched exactly (BTCUSDT = BTC-USDT = BTC_USDT). A coin listed under a different
// name (e.g. 1000PEPEUSDT on Binance, PEPE_USDT on Gate.io) is NOT matched on purpose:
// the contract sizes differ, so the app never trades it as the same coin.
import fs from 'node:fs';
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(url+' HTTP '+r.status);return r.json()};
const [info,tickers,gate,bingx,gateTickers,bingxTickers]=await Promise.all([
 get('https://fapi.binance.com/fapi/v1/exchangeInfo'),get('https://fapi.binance.com/fapi/v1/ticker/24hr'),
 get('https://api.gateio.ws/api/v4/futures/usdt/contracts'),get('https://open-api.bingx.com/openApi/swap/v2/quote/contracts'),
 get('https://api.gateio.ws/api/v4/futures/usdt/tickers').catch(()=>[]),get('https://open-api.bingx.com/openApi/swap/v2/quote/ticker').catch(()=>({data:[]}))]);
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
// The reverse: listed on BingX / Gate.io but not on Binance (no Binance chart, so the app skips them).
const binanceSet=new Set(binance),venueVol=new Map();
for(const t of Array.isArray(gateTickers)?gateTickers:[]){const k=String(t.contract).replace('_','');venueVol.set(k,Math.max(venueVol.get(k)||0,Number(t.volume_24h_quote)||0))}
for(const t of bingxTickers?.data||[]){const k=String(t.symbol).replace('-','');venueVol.set(k,Math.max(venueVol.get(k)||0,Number(t.quoteVolume)||0))}
const venueOnly=[...new Set([...gateSet,...bingxSet])].filter(x=>x.endsWith('USDT')&&!binanceSet.has(x))
 .map(symbol=>({symbol,volume:venueVol.get(symbol)||0,gate:gateSet.has(symbol),bingx:bingxSet.has(symbol)})).sort((a,b)=>b.volume-a.volume);
// Stocks, ETFs, indexes and commodities are not coins. BingX marks them with an NC prefix;
// for Gate.io this is a list of known tickers, so a few may slip through (check the list).
const NON_CRYPTO=new Set(['XAU','XAG','XPT','XPD','CL','BZ','NG','COPPER','COPP','UKOIL','USOIL','US30','US100','US500','US400','DXI','VXI','SPCX',
 'NVDA','INTC','AMD','AAPL','TSLA','AMZN','MSFT','META','GOOGL','GOOG','NFLX','ORCL','AVGO','PLTR','MSTR','COIN','HOOD','CRCL','NBIS','CRWV','AAOI','AXTI',
 'MU','MUU','TSM','ARM','SMCI','BABA','GME','AMC','QQQ','SPY','IWM','TQQQ','SQQQ','SOXL','SOXS','SAMSUNG','SKHYNIX','SKHY','KORU','SNDK','CXMT','ZHIPU',
 'OPENAI','SNXX','CIRCLE','RDDT','UBER','SHOP','SNOW','IBM','DIS','JPM','BAC','V','MA','WMT','KO','PEP','NKE','XOM','CVX','LLY','UNH','HYUNDAI','LG','KRX',
 'ANTHROPIC','SPACEX','XIAOMI','TENCENT','NIO','LI','XPEV','BIDU','JD','PDD','EWJ','EWY','FXI','GLD','SLV','USO','TLT','UVXY','VIX']);
const isCoin=symbol=>{const base=symbol.replace(/USDT$/,'');return !/^NC/.test(base)&&!NON_CRYPTO.has(base)};
const coins=venueOnly.filter(r=>isCoin(r.symbol)),others=venueOnly.filter(r=>!isCoin(r.symbol));
const band=(lo,hi)=>coins.filter(r=>r.volume>=lo&&r.volume<hi).length,m=x=>x*1e6;
lines.push('',`BingX·Gate.io에만 있는 종목 ${venueOnly.length}개 = 코인 ${coins.length}개 + 주식·원자재·지수 ${others.length}개 (바이낸스 차트 없음 → 지금은 분석하지 않음)`,
 `코인 ${coins.length}개의 24h 거래대금 분포: 5M$ 이상 ${band(m(5),Infinity)} · 1~5M$ ${band(m(1),m(5))} · 0.1~1M$ ${band(m(.1),m(1))} · 0.1M$ 미만 ${band(0,m(.1))}`,
 '','코인만 (거래대금 순, 최대 150개):',
 ...coins.slice(0,150).map((r,i)=>`  ${String(i+1).padStart(3)}. ${r.symbol.padEnd(20)} ${(r.volume/1e6).toFixed(2).padStart(8)}M$  ${[r.gate?'Gate.io':'',r.bingx?'BingX':''].filter(Boolean).join('·')}`),
 '','주식·원자재·지수 (거래대금 순, 최대 20개):',
 ...others.slice(0,20).map(r=>`  ${r.symbol.padEnd(24)} ${(r.volume/1e6).toFixed(1)}M$`));
console.log(lines.join('\n'));
fs.mkdirSync('backtest-results',{recursive:true});fs.writeFileSync('backtest-results/venue-overlap.txt',lines.join('\r\n'));
console.log('\n저장: backtest-results\\venue-overlap.txt');
