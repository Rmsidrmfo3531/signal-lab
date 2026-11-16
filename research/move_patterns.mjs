// Pump / dump event study (research only, no orders; user 2026-11-16: "급등·급락 차트 패턴을 전체적으로 분석").
//   node research/move_patterns.mjs <cacheDir> [minMovePct=5] [out.json]
// cacheDir: candles saved by scripts/backtest.mjs (<SYMBOL>_5m.json, Binance kline rows). One symbol in memory
// at a time. For every fast move (>= minMovePct within 30 minutes on 5m closes) it records what came before
// (squeeze, volume build-up, position in the 24h / 7d range, trend, earlier moves, hour) and what came after
// (extension, retrace at 30m/1h/4h/24h, new extreme, round trip), labels the outcome, and scores two plain
// trades on every event: FADE (enter at the first opposite 5m close, stop beyond the extreme, target 38.2 %
// retrace) and FOLLOW (enter at the event close, stop at 50 % of the move, target 1R). Costs 0.12 % round trip.
import fs from 'node:fs';import path from 'node:path';

const [cache,minArg='5',outFile]=process.argv.slice(2);
if(!cache){console.error('사용법: node research/move_patterns.mjs <cacheDir> [최소 움직임%] [out.json]');process.exit(1)}
const MIN=Number(minArg)||5,M5=300000,WIN=6,COST=0.0012,COOL=24; // 30-minute window, one event per 2 hours per coin
const read=f=>{try{return JSON.parse(fs.readFileSync(path.join(cache,f),'utf8'))}catch{return null}};
const files=fs.readdirSync(cache).filter(f=>f.endsWith('_5m.json'));
const rows=r=>r.map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]})).filter(x=>Number.isFinite(x.c)&&x.c>0);
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const kstHour=t=>new Date(t+9*3600000).getUTCHours();
function atr(b,i,n=14){let s=0,k=0;for(let j=Math.max(1,i-n+1);j<=i;j++){s+=Math.max(b[j].h-b[j].l,Math.abs(b[j].h-b[j-1].c),Math.abs(b[j].l-b[j-1].c));k++}return k?s/k:null}
function ema(vals,n){const k=2/(n+1);let e=vals[0];for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e}

const events=[];
for(const f of files){
 const symbol=f.replace('_5m.json',''),raw=read(f);if(!raw?.length)continue;const b=rows(raw);
 let last=-Infinity;
 for(let i=300;i<b.length-290;i++){
  if(i-last<COOL)continue;
  // The move: the largest |close - extreme| over the last WIN bars, ending on this close.
  let lo=Infinity,hi=-Infinity,loI=i,hiI=i;for(let j=i-WIN;j<=i;j++){if(b[j].l<lo){lo=b[j].l;loI=j}if(b[j].h>hi){hi=b[j].h;hiI=j}}
  const up=(b[i].c-lo)/lo*100,down=(hi-b[i].c)/hi*100;
  let dir=null;if(up>=MIN&&loI<i&&up>=down)dir='PUMP';else if(down>=MIN&&hiI<i)dir='DUMP';if(!dir)continue;
  // The event ends at its extreme: keep extending while the next bars push further within 3 bars.
  let end=i;for(let j=i+1;j<=Math.min(b.length-1,i+3);j++){if(dir==='PUMP'?b[j].h>b[end].h:b[j].l<b[end].l)end=j}
  const start=dir==='PUMP'?loI:hiI,base=dir==='PUMP'?lo:hi,ext=dir==='PUMP'?b[end].h:b[end].l,move=Math.abs(ext-base),sgn=dir==='PUMP'?1:-1;
  if(end+289>=b.length)continue;last=end;
  // Before
  const pre=b.slice(Math.max(0,start-288),start),pre12=b.slice(Math.max(0,start-12),start),pre7d=b.slice(Math.max(0,start-2016),start);
  const volBase=mean(pre.map(x=>x.v)),volBuild=volBase?mean(pre12.map(x=>x.v))/volBase:null,climax=volBase?Math.max(...b.slice(start,end+1).map(x=>x.v))/volBase:null;
  const a0=atr(b,start-1),aPrev=mean(Array.from({length:12},(_,k)=>atr(b,start-1-24*k)).filter(Boolean));
  const squeeze=a0&&aPrev?a0/aPrev:null; // < 1: quieter than the day before
  const h24=Math.max(...pre.map(x=>x.h)),l24=Math.min(...pre.map(x=>x.l)),h7=Math.max(...pre7d.map(x=>x.h)),l7=Math.min(...pre7d.map(x=>x.l));
  const breakout=dir==='PUMP'?(ext>h24?(ext>h7?'7일 신고가':'24시간 신고가'):'범위 안'):(ext<l24?(ext<l7?'7일 신저가':'24시간 신저가'):'범위 안');
  const c1h=[];for(let j=start-1;j>=Math.max(0,start-12*200);j-=12)c1h.unshift(b[j].c);
  const trend=c1h.length>60?(ema(c1h.slice(-60),20)>ema(c1h.slice(-60),50)?'1시간 상승 추세':'1시간 하락 추세'):'추세 미상';
  const with_trend=(dir==='PUMP')===(trend==='1시간 상승 추세')?'추세 방향':'추세 반대';
  let prior=0;for(const e of events)if(e.symbol===symbol&&start-e._end<=288)prior++;
  // After (from the extreme)
  const after=n=>b.slice(end+1,end+1+n);
  const retr=n=>{const a=after(n);const back=dir==='PUMP'?(ext-Math.min(...a.map(x=>x.l))):(Math.max(...a.map(x=>x.h))-ext);return back/move*100};
  const extend=n=>{const a=after(n);const more=dir==='PUMP'?(Math.max(...a.map(x=>x.h))-ext):(ext-Math.min(...a.map(x=>x.l)));return Math.max(0,more)/move*100};
  const close4h=(after(48).at(-1).c-ext)/move*100*-sgn; // % of the move given back at 4h (close)
  const r1=retr(12),r4=retr(48),x4=extend(48),x24=extend(288);
  const outcome=retr(48)>=100?'전부 되돌림(왕복)':r1>=61.8&&extend(12)<10?'빠른 되돌림(V자)':x4>=50?'계속 진행(계단식)':close4h<38.2?'자리 유지(횡보)':'느린 되돌림';
  // FADE: first opposite close after the extreme, stop beyond the extreme (+0.25 ATR), target 38.2 % retrace, 2 h limit.
  const fade=(()=>{let k=end+1;while(k<=end+6&&(dir==='PUMP'?b[k].c>=b[k].o:b[k].c<=b[k].o))k++;if(k>end+6)return null;
   const entry=b[k].c,aa=atr(b,k)||move*0.1,stop=dir==='PUMP'?Math.max(...b.slice(end,k+1).map(x=>x.h))+0.25*aa:Math.min(...b.slice(end,k+1).map(x=>x.l))-0.25*aa;
   const target=ext-sgn*0.382*move,risk=Math.abs(stop-entry);if(!(risk>0)||(dir==='PUMP'?target>=entry:target<=entry))return null;
   for(let j=k+1;j<=k+24&&j<b.length;j++){const x=b[j];const hitS=dir==='PUMP'?x.h>=stop:x.l<=stop,hitT=dir==='PUMP'?x.l<=target:x.h>=target;
    if(hitS)return -1-COST*entry/risk;if(hitT)return Math.abs(entry-target)/risk-COST*entry/risk}
   const exit=b[Math.min(b.length-1,k+24)].c;return (dir==='PUMP'?entry-exit:exit-entry)/risk-COST*entry/risk})();
  // FOLLOW: enter at the event's end close, stop at half the move back, target 1R, 4 h limit.
  const follow=(()=>{const entry=b[end].c,stop=ext-sgn*0.5*move,risk=Math.abs(entry-stop);if(!(risk>0))return null;const target=entry+sgn*risk;
   for(let j=end+1;j<=end+48;j++){const x=b[j];const hitS=dir==='PUMP'?x.l<=stop:x.h>=stop,hitT=dir==='PUMP'?x.h>=target:x.l<=target;
    if(hitS)return -1-COST*entry/risk;if(hitT)return 1-COST*entry/risk}
   const exit=b[end+48].c;return (dir==='PUMP'?exit-entry:entry-exit)/risk-COST*entry/risk})();
  events.push({symbol,dir,at:b[start].t,_end:end,movePct:+(move/base*100).toFixed(2),bars:end-start+1,hourKst:kstHour(b[start].t),
   volBuild:volBuild&&+volBuild.toFixed(2),climax:climax&&+climax.toFixed(1),squeeze:squeeze&&+squeeze.toFixed(2),breakout,trend,withTrend:with_trend,priorMoves24h:prior,
   retrace1h:+r1.toFixed(1),retrace4h:+r4.toFixed(1),extend4h:+x4.toFixed(1),extend24h:+x24.toFixed(1),outcome,fadeR:fade==null?null:+fade.toFixed(3),followR:follow==null?null:+follow.toFixed(3)});
 }
 process.stderr.write(`${symbol} 완료 (${events.length})\n`);
}

// ---- report
const f1=x=>x==null||!Number.isFinite(x)?'-':x.toFixed(2);
const stat=list=>{const fr=list.map(e=>e.fadeR).filter(x=>x!=null),fo=list.map(e=>e.followR).filter(x=>x!=null);
 const oc={};for(const e of list)oc[e.outcome]=(oc[e.outcome]||0)+1;
 return {n:list.length,fadeN:fr.length,fadeAvgR:mean(fr),fadeWin:fr.length?fr.filter(x=>x>0).length/fr.length*100:null,followN:fo.length,followAvgR:mean(fo),followWin:fo.length?fo.filter(x=>x>0).length/fo.length*100:null,
  retrace1h:mean(list.map(e=>e.retrace1h)),extend4h:mean(list.map(e=>e.extend4h)),outcomes:Object.fromEntries(Object.entries(oc).map(([k,v])=>[k,+(v/list.length*100).toFixed(1)]))}};
const line=(name,s)=>`${name.padEnd(22)} ${String(s.n).padStart(5)}건 | 되받아치기 ${f1(s.fadeAvgR)}R (승 ${f1(s.fadeWin)}%) | 따라가기 ${f1(s.followAvgR)}R (승 ${f1(s.followWin)}%) | 1시간 되돌림 ${f1(s.retrace1h)}% · 4시간 추가 진행 ${f1(s.extend4h)}%`;
const group=(list,key,order)=>{const g={};for(const e of list){const k=typeof key==='function'?key(e):e[key];(g[k]??=[]).push(e)}return (order||Object.keys(g).sort()).filter(k=>g[k]).map(k=>[k,g[k]])};
const bucket=(x,cuts,labels)=>{if(x==null)return '미상';for(let i=0;i<cuts.length;i++)if(x<cuts[i])return labels[i];return labels.at(-1)};
const out={minMovePct:MIN,events:events.length,symbols:files.length,from:events.length?new Date(Math.min(...events.map(e=>e.at))).toISOString():null,sections:{}};
console.log(`# 급등·급락 패턴 분석: ${files.length}종목, ${MIN}% 이상(30분 안) 움직임 ${events.length}건`);
console.log('되받아치기 = 첫 반대 캔들 마감에 반대로 진입·손절은 끝점 너머·목표 38.2% 되돌림(2시간). 따라가기 = 움직임 끝에 같은 방향 진입·손절은 움직임 절반·목표 1R(4시간). R은 수수료 0.12% 뺀 값.');
for(const dir of ['PUMP','DUMP']){
 const L=events.filter(e=>e.dir===dir);if(!L.length)continue;const title=dir==='PUMP'?'급등':'급락';const sec={};
 console.log(`\n## ${title} ${L.length}건`);const all=stat(L);sec.all=all;console.log(line('전체',all));
 console.log('  결과 유형 비율:',Object.entries(all.outcomes).map(([k,v])=>`${k} ${v}%`).join(' · '));
 const views={
  '움직임 폭':e=>bucket(e.movePct,[6,8,12],['5~6%','6~8%','8~12%','12% 이상']),
  '걸린 시간':e=>bucket(e.bars,[3,5,8],['10분 이내','10~20분','20~35분','35분 이상']),
  '직전 거래량 증가':e=>bucket(e.volBuild,[1,2,4],['평소 이하','1~2배','2~4배','4배 이상']),
  '움직임 중 최대 거래량':e=>bucket(e.climax,[3,6,12],['3배 미만','3~6배','6~12배','12배 이상']),
  '직전 변동성(수축=1 미만)':e=>bucket(e.squeeze,[0.7,1,1.5],['크게 수축','수축','보통','확대']),
  '고점·저점 돌파':'breakout','1시간 추세':'withTrend',
  '24시간 안 앞선 큰 움직임':e=>e.priorMoves24h===0?'처음':e.priorMoves24h===1?'두 번째':'세 번 이상',
  '시간대(KST)':e=>bucket(e.hourKst,[3,9,15,21],['00~03시','03~09시','09~15시','15~21시','21~24시'])};
 for(const [name,key] of Object.entries(views)){console.log(`\n### ${title} · ${name}`);sec[name]={};for(const [k,list] of group(L,key)){const s=stat(list);sec[name][k]=s;console.log(line(k,s))}}
 out.sections[dir]=sec;
}
// The best and worst combinations with at least 30 events, for each plain trade.
const combos=[];
const keyOf=e=>`${e.dir==='PUMP'?'급등':'급락'} · ${bucket(e.movePct,[8],['8% 미만','8% 이상'])} · ${e.breakout} · ${e.withTrend} · 거래량 ${bucket(e.climax,[6],['6배 미만','6배 이상'])}`;
for(const [k,list] of group(events,keyOf)){if(list.length<30)continue;combos.push({k,...stat(list)})}
console.log('\n## 조합별 (30건 이상) — 되받아치기 기대값 높은 순');
for(const c of [...combos].sort((a,b)=>(b.fadeAvgR??-9)-(a.fadeAvgR??-9)).slice(0,10))console.log(line(c.k,c));
console.log('\n## 조합별 (30건 이상) — 따라가기 기대값 높은 순');
for(const c of [...combos].sort((a,b)=>(b.followAvgR??-9)-(a.followAvgR??-9)).slice(0,10))console.log(line(c.k,c));
out.combos=combos;
console.log('\n[주의] 과거 결과입니다. 5분봉 안의 순서는 보수적으로(손절 먼저) 처리했고, 30건 미만 구간은 우연일 가능성이 큽니다.');
if(outFile)fs.writeFileSync(outFile,JSON.stringify({...out,eventsList:events.map(({_end,...e})=>e)}));
