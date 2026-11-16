// "Follow" scalp study (research only, no orders; user 2026-11-17 "1, 2, 3번 모두 적용해봐"): the trader-entry study
// found the one positive group was entering WITH the last hour's move (1h later +1.07 %, 73 entries). This replays
// simple rules on Binance 5m candles to see whether that holds as a standalone strategy, split in time halves.
//   node research/follow_scan.mjs [days=60] [outDir=follow-scan] [SYMBOL,SYMBOL,...]
// Rules (signal on a closed 5m candle, entry at the next open, one trade per coin at a time, 2 h cool-down):
//   FOLLOW   the last hour moved lo~hi % (close vs open 12 bars ago) and the last candle closed the same way -> trade with it
//   ROLLOVER the last 4 hours moved >= 5 % one way and the last hour >= 1 % back -> trade the new direction
//            (the trader's "숏 추종": up 10 % over 4 h, then down 2.8 % in the hour before the short)
// Exits: stop s % from entry, target R x s %, 4 h time exit; same candle -> stop first. Costs 0.12 % round trip.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';

const M5=300000,COST=.12,HOLD=48,COOL=24,sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const CONFIGS=(()=>{const out=[];
 for(const rule of ['FOLLOW','ROLLOVER'])for(const band of rule==='FOLLOW'?[[1,3],[3,5],[5,10]]:[[1,99]])for(const stop of [1,1.5,2])for(const r of [1,1.5,2])
  out.push({rule,lo:band[0],hi:band[1],stop,r,key:`${rule==='FOLLOW'?'추종 1h '+band[0]+'~'+band[1]+'%':'4h 5%+ 뒤 1h 1%+ 반전'} · 손절 ${stop}% · 목표 ${r}R`});
 return out})();

/** Signals of one rule on 5m rows {t,o,h,l,c}: [{i, side}] (i = the signal candle). */
export function signals(b,cfg){
 const out=[];let last=-Infinity;
 for(let i=48;i<b.length-1;i++){
  if(i-last<COOL)continue;
  const h1=(b[i].c/b[i-11].o-1)*100,h4=(b[i].c/b[i-47].o-1)*100,bar=Math.sign(b[i].c-b[i].o);let side=null;
  if(cfg.rule==='FOLLOW'){const a=Math.abs(h1);if(a>=cfg.lo&&a<cfg.hi&&bar===Math.sign(h1))side=h1>0?'LONG':'SHORT'}
  else if(h4>=5&&h1<=-1&&bar<0)side='SHORT';else if(h4<=-5&&h1>=1&&bar>0)side='LONG';
  if(side){out.push({i,side});last=i}
 }
 return out;
}
/** One trade from the signal at i: result in R after costs, or null at the end of the data. */
export function simulate(b,i,side,{stop,r}){
 const s=side==='LONG'?1:-1,e=b[i+1].o,sl=e*(1-s*stop/100),tp=e*(1+s*stop*r/100),cost=COST/stop;
 for(let k=i+1;k<Math.min(b.length,i+1+HOLD);k++){
  const x=b[k];if(s>0?x.l<=sl:x.h>=sl)return {R:-1-cost,exit:'STOP',k};if(s>0?x.h>=tp:x.l<=tp)return {R:r-cost,exit:'TARGET',k};
 }
 const k=i+HOLD;if(k>=b.length)return null;return {R:s*(b[k].c/e-1)*100/stop-cost,exit:'TIME',k};
}
export function stats(list){
 const n=list.length,w=list.filter(x=>x.R>0),g=w.reduce((a,x)=>a+x.R,0),l=-list.filter(x=>x.R<0).reduce((a,x)=>a+x.R,0);
 return {n,win:n?w.length/n*100:null,pf:l?g/l:(g?Infinity:null),avgR:n?(g-l)/n:null,sumR:g-l};
}
const fmt=s=>`${String(s.n).padStart(5)}건 승률 ${s.win==null?'—':s.win.toFixed(1).padStart(5)}% PF ${s.pf==null?'—':Number.isFinite(s.pf)?s.pf.toFixed(2):'∞'} 평균 ${s.avgR==null?'—':s.avgR.toFixed(3)}R 합계 ${s.sumR.toFixed(1)}R`;

async function getJSON(url){for(let a=1;a<=3;a++){try{const r=await fetch(url);if(r.status===429||r.status===418){await sleep(30000);continue}if(!r.ok)return null;return await r.json()}catch{await sleep(1500*a)}}return null}
async function m5(symbol,start,end,cacheDir){
 const file=path.join(cacheDir,`${symbol}_5m.json`);try{const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.start<=start&&c.end>=end-M5*12)return c.rows}catch{}
 const rows=[];let from=start;
 while(from<end){const batch=await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${from}&limit=1500`);
  if(!Array.isArray(batch)||!batch.length)break;for(const x of batch)if(+x[6]<Date.now())rows.push({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4]});
  from=+batch.at(-1)[0]+M5;await sleep(200);if(batch.length<1500)break}
 fs.writeFileSync(file,JSON.stringify({start,end,rows}));return rows;
}
const DEFAULT=['SOLUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','NEARUSDT','ZECUSDT','WIFUSDT','1000PEPEUSDT','ENAUSDT','TIAUSDT','SEIUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','TAOUSDT','HYPEUSDT','FARTCOINUSDT','VIRTUALUSDT','ONDOUSDT','WLDUSDT','TRUMPUSDT','PENGUUSDT','KAITOUSDT','BERAUSDT','ONEUSDT','BANKUSDT'];

export async function main(argv=process.argv.slice(2)){
 const days=Math.max(7,Math.min(180,Number(argv[0])||60)),outDir=argv[1]||'follow-scan';fs.mkdirSync(outDir,{recursive:true});
 let symbols=argv[2]?argv[2].split(',').map(s=>s.trim().toUpperCase()).filter(Boolean):DEFAULT;
 try{const t=JSON.parse(fs.readFileSync(path.join('research','data','trader_entries.json'),'utf8'));const c={};for(const e of t)if(!/^(BTC|ETH)USDT$/.test(e.symbol))c[e.symbol]=(c[e.symbol]||0)+1;
  if(!argv[2])symbols=[...new Set([...symbols,...Object.entries(c).filter(([,n])=>n>=3).map(([s])=>s)])]}catch{}
 const end=Math.floor(Date.now()/M5)*M5,start=end-days*86400000,mid=start+(end-start)/2;
 const res=new Map(CONFIGS.map(c=>[c.key,[]]));const used=[],missing=[];
 for(const [k,sym] of symbols.entries()){
  const b=await m5(sym,start,end,outDir);if(b.length<2000){missing.push(sym);continue}used.push(sym);
  for(const cfg of CONFIGS){let busy=-1;for(const {i,side} of signals(b,cfg)){if(i<=busy)continue;const t=simulate(b,i,side,cfg);if(!t)continue;busy=t.k;res.get(cfg.key).push({sym,side,at:b[i].t,R:t.R,exit:t.exit})}}
  console.log(`${k+1}/${symbols.length} ${sym} ${b.length}봉`);
 }
 const L=['추종 단타 백테스트 (Binance 5분봉, 연구용)','='.repeat(70),`기간 ${days}일 · 종목 ${used.length}개 · 비용 왕복 0.12% · 4시간 시간 청산 · 같은 봉이면 손절 먼저`,
  '앞 절반으로 고른 설정이 뒤 절반에서도 플러스여야 우연이 아닙니다.',''];
 const rows=CONFIGS.map(c=>{const all=res.get(c.key);return {c,all:stats(all),a:stats(all.filter(x=>x.at<mid)),b:stats(all.filter(x=>x.at>=mid)),L:stats(all.filter(x=>x.side==='LONG')),S:stats(all.filter(x=>x.side==='SHORT'))}});
 for(const rule of ['FOLLOW','ROLLOVER']){L.push(`[${rule==='FOLLOW'?'추종: 직전 1시간 방향으로 진입':'반전 추종: 4시간 큰 움직임 뒤 1시간 되돌림 방향'}]`);
  for(const x of rows.filter(x=>x.c.rule===rule))L.push(`  ${x.c.key.padEnd(34)} 전체 ${fmt(x.all)} | 앞 ${x.a.avgR==null?'—':x.a.avgR.toFixed(3)}R 뒤 ${x.b.avgR==null?'—':x.b.avgR.toFixed(3)}R | 롱 ${x.L.avgR==null?'—':x.L.avgR.toFixed(3)}R 숏 ${x.S.avgR==null?'—':x.S.avgR.toFixed(3)}R`);L.push('')}
 const pick=rows.filter(x=>x.a.n>=30).sort((p,q)=>q.a.avgR-p.a.avgR)[0];
 if(pick)L.push(`# 앞 절반 기준 선택: ${pick.c.key}`,`  앞 절반       ${fmt(pick.a)}`,`  뒤 절반(확인) ${fmt(pick.b)}`,`  롱 ${fmt(pick.L)}`,`  숏 ${fmt(pick.S)}`);
 if(missing.length)L.push('',`데이터 없음(Binance 미상장 등): ${missing.join(', ')}`);
 const text=L.join('\n');fs.writeFileSync(path.join(outDir,'report.txt'),text);console.log(text);console.log(`저장: ${path.join(outDir,'report.txt')}`);
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(e);process.exit(1)});
