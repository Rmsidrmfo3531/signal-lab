// TRADER_LADDER: copy-trader style position management for the TESTNET reversal scalp (scalp_executor.mjs).
// User 2026-11-24 21:33 "매매의 방식을 카피 트레이더처럼, 별개로 종목을 찾는 건 우리의 조건대로 하는 거야",
// 21:35 "추매는 1배 1배 2배 4배 8배 16배 등으로 일반적으로 매매를 하되, 강력하고 확실한 저항선에 걸릴 경우에는 물량을 더
// 넣어도 좋아", 21:35 "진행"; agreed with it: the per-symbol margin cap stays, and a full ladder that keeps going against us
// is closed at a final line ("(나) 마지막 선에서 정리"). Entry selection is unchanged; only the management differs.
// Parameters and their source (research/trader_style.md, measured from the copy trader's data or the fallback):
//  - ladder 1·1·2·4·8·16 units (user), unit = per-symbol margin cap / 32;
//  - add spacing max(1.5 %, 1 x ATR(1H) %) from the LAST fill (fallback: too few add prices in the data);
//  - take profit: the whole position at average + 0.6 % net of fees (amount: fallback, full close: measured 90 %);
//  - max hold 24 h (measured: 99.1 % of 895 holds <= 24 h, p99 21.6 h);
//  - final line -75 % ROE on the position margin (the existing emergency line; after the last step it is the user's (나)).
// Pure functions only (no orders, no I/O): the executor calls them and keeps the state on the position (p.ladder).
import {roundDecimalToStep} from './decimal_grid.mjs';

export const SCALP_MANAGEMENTS=Object.freeze({LADDER:'TRADER_LADDER',CURRENT:'CURRENT'});
export const TRADER_LADDER=Object.freeze({
 version:1,
 steps:Object.freeze([1,1,2,4,8,16]),
 totalUnits:32,
 spacingMinPct:1.5,spacingAtrMult:1,
 // A strong zone counts as the add level when it lies at least this share of the spacing away from the last fill.
 zoneMinFrac:.5,zoneTouchPct:.3,zoneMinRejections:3,zoneBoost:2,
 tpNetPct:.6,
 maxHoldMin:2880, // 48 h (user 2026-11-25 01:10 "48시간까지 해보자 또 생기면 상한없음으로"; measured trader 99 % ≤ 24 h)
 // Spacing cap so the next add comes before the emergency line: the price distance from the average to the next add
 // is at most ~1.94 spacings on this ladder, kept under 90 % of the final line: spacing <= 0.45 x line / leverage.
 spacingCapShare:.45,
 // A raised unit keeps 10 % over the venue minimum (a SHORT add at a higher price buys a little less per margin).
 minQtyHeadroom:1.1,
 source:Object.freeze({steps:'USER',spacing:'FALLBACK',tpNetPct:'FALLBACK',fullClose:'MEASURED',maxHoldMin:'USER',finalLine:'USER'})
});
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const sum=a=>a.reduce((s,v)=>s+v,0);
const dirOf=d=>d==='SHORT'?-1:1;
const grid=(v,step,mode)=>{try{return Number(roundDecimalToStep(v,step,mode))}catch{return null}};

/** SCALP_MANAGEMENT: TRADER_LADDER (default) | CURRENT (the management before 2026-11-24). */
export function scalpManagementOf(env=process.env){
 const raw=String(env?.SCALP_MANAGEMENT??'').trim().toUpperCase();
 return raw===SCALP_MANAGEMENTS.CURRENT?SCALP_MANAGEMENTS.CURRENT:SCALP_MANAGEMENTS.LADDER;
}

/** ATR(n) of closed candles [t,o,h,l,c,v,closeTime] as % of the last close (null when too few). */
export function atrPct(rows,{n=14,now=Infinity}={}){
 const c=(Array.isArray(rows)?rows:[]).filter(r=>Array.isArray(r)&&Number(r[6])<now).map(r=>({h:+r[2],l:+r[3],c:+r[4]})).filter(x=>x.h>0&&x.l>0&&x.c>0);
 if(c.length<n+1)return null;
 const tr=[];for(let i=c.length-n;i<c.length;i++){const p=c[i-1].c;tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-p),Math.abs(c[i].l-p)))}
 return sum(tr)/n/c.at(-1).c*100;
}

/** Add spacing %: max(min %, ATR(1H) % x mult), capped so an add comes before the final line at this leverage. */
export function ladderSpacing({atrPct:atr=null,leverage=10,finalLineRoePct=75,minPct=TRADER_LADDER.spacingMinPct,atrMult=TRADER_LADDER.spacingAtrMult}={}){
 const base=Math.max(minPct,Number.isFinite(Number(atr))&&atr>0?Number(atr)*atrMult:0);
 const lev=Math.max(1,Number(leverage)||1),cap=finalLineRoePct>0?TRADER_LADDER.spacingCapShare*finalLineRoePct/lev:Infinity;
 const spacingPct=Math.min(base,cap);
 return {spacingPct:+spacingPct.toFixed(4),basePct:+base.toFixed(4),capPct:Number.isFinite(cap)?+cap.toFixed(4):null,capped:spacingPct<base-1e-12,atrPct:Number.isFinite(Number(atr))?+Number(atr).toFixed(4):null};
}

/** The ladder for a new entry. unit = symbolCapUSD / 32 x sizeMult, held so the whole ladder fits min(symbolCap, room).
 * A unit under the venue minimum is raised to it and the ladder shortened from the END to stay within the cap;
 * fewer than two steps (entry + one add) cannot be placed: LADDER_BELOW_MINIMUM. */
export function planLadder({symbolCapUSD,roomUSD=Infinity,leverage,price,quantityStep,minQty=0,minNotional=0,sizeMult=1,steps=TRADER_LADDER.steps}){
 const fail=(reason,extra={})=>({ok:false,reason,...extra});
 const lev=pos(leverage),px=pos(price),step=pos(quantityStep),symCap=pos(symbolCapUSD);
 if(!lev||!px||!step)return fail('CONTRACT_GRID_INVALID');
 const capUSD=Math.min(symCap??0,Number.isFinite(Number(roomUSD))?Math.max(0,Number(roomUSD)):Infinity);
 if(!(capUSD>0))return fail('MARGIN_CAP');
 const mult=pos(sizeMult)??1;
 let units=[...steps],unit=symCap/TRADER_LADDER.totalUnits*mult,capped=false,raised=false;
 if(unit*sum(units)>capUSD+1e-9){unit=capUSD/sum(units);capped=true}
 const minQ=grid(Math.max(Number(minQty)||0,(Number(minNotional)||0)*1.02/px,step),quantityStep,'UP')||step;
 const minUnit=minQ*px/lev*TRADER_LADDER.minQtyHeadroom;
 if(unit<minUnit){unit=minUnit;raised=true;while(units.length&&unit*sum(units)>capUSD+1e-9)units.pop()}
 if(units.length<2)return fail('LADDER_BELOW_MINIMUM',{minUnitMarginUSD:+minUnit.toFixed(4),capUSD:+capUSD.toFixed(4)});
 const qty0=Math.max(minQ,grid(unit*lev/px*(1+1e-9),quantityStep,'DOWN')||0);
 return {ok:true,unitMarginUSD:+unit.toFixed(6),units,totalUnits:sum(units),totalMarginUSD:+(unit*sum(units)).toFixed(6),symbolCapUSD:symCap,capUSD:+capUSD.toFixed(6),
  sizeMult:mult,capped,raised,shortened:units.length<steps.length,qty0,minQty:minQ};
}

/** Step `index` doubled at a strong zone; the same units come off the LAST steps (never a filled one) so the total stays.
 * The last step cannot grow (nothing after it). Steps cut to 0 at the end are dropped. */
export function ladderZoneBoost(units,index){
 const u=[...units];let need=u[index]??0,taken=0;
 for(let j=u.length-1;j>index&&need>0;j--){const t=Math.min(u[j],need);u[j]-=t;need-=t;taken+=t}
 u[index]+=taken;while(u.length>index+1&&u.at(-1)===0)u.pop();
 return {units:u,boost:taken};
}

/** Worst case for the shared budget: every step filled and closed at the final line, plus fees on the full notional. */
export function ladderReserve({totalMarginUSD,leverage,finalLineRoePct=75,takerRate=.0006,reservePct=.0004}){
 const m=Number(totalMarginUSD)||0,lev=Math.max(1,Number(leverage)||1);
 return {marginUSD:+m.toFixed(6),riskUSD:+(m*(finalLineRoePct/100)+m*lev*(2*takerRate+reservePct)).toFixed(6)};
}

/** 4H candles that touched a zone and closed back on our side (LONG: low into the band, close above it; SHORT: the
 * mirror), counted once per touch (a run of touching candles is one). */
export function zoneRejections(rows,zone,direction,touchPct=TRADER_LADDER.zoneTouchPct){
 const lo=Number(zone?.low)*(1-touchPct/100),hi=Number(zone?.high)*(1+touchPct/100),d=dirOf(direction);
 if(!(lo>0&&hi>0))return 0;
 let n=0,prev=false;
 for(const r of Array.isArray(rows)?rows:[]){
  const h=+r[2],l=+r[3],c=+r[4];if(!(h>0&&l>0&&c>0)){prev=false;continue}
  const touch=d>0?l<=hi&&h>=lo:h>=lo&&l<=hi,rejected=d>0?c>Number(zone.high):c<Number(zone.low);
  if(touch&&rejected&&!prev)n++;
  prev=touch;
 }
 return n;
}

/** Strong zones ("강력하고 확실한 저항선"; the executor adds the 고래 매물대 of whale_zones.mjs as kind 'WHALE'). A 4H or 1D volume zone (backtest.mjs zoneBook, HVNs) is strong when
 *  - OVERLAP_4H_1D: a zone of the other timeframe lies within ±touchPct % of it, or
 *  - TOP_VOLUME_NODE: it is the timeframe's largest volume node (rank 1), or
 *  - REJECTIONS_3: 4H candles touched it and closed back on our side at least minRejections times.
 * Returns [{low, high, tf, rank, sharePct, rejections, why:[...]}]. */
export function strongZones({zones4h=null,zones1d=null,rows4h=null,direction='LONG',touchPct=TRADER_LADDER.zoneTouchPct,minRejections=TRADER_LADDER.zoneMinRejections}={}){
 const near=(a,b)=>{const t=touchPct/100;return Number(a.low)<=Number(b.high)*(1+t)&&Number(b.low)<=Number(a.high)*(1+t)};
 const out=[];
 for(const [tf,list,other] of [['4h',zones4h,zones1d],['1d',zones1d,zones4h]]){
  for(const z of Array.isArray(list)?list:[]){
   if(!(Number(z?.low)>0&&Number(z?.high)>0))continue;
   const why=[],rejections=zoneRejections(rows4h,z,direction,touchPct);
   if((Array.isArray(other)?other:[]).some(o=>Number(o?.low)>0&&near(z,o)))why.push('OVERLAP_4H_1D');
   if(Number(z.rank)===1)why.push('TOP_VOLUME_NODE');
   if(rejections>=minRejections)why.push('REJECTIONS_3');
   if(why.length)out.push({low:Number(z.low),high:Number(z.high),tf,kind:'VOLUME',rank:z.rank??null,sharePct:Number.isFinite(Number(z.sharePct))?+Number(z.sharePct).toFixed(2):null,rejections,why});
  }
 }
 return out;
}

/** Where the next add goes: the spacing level (lastFill -/+ spacing %), or a strong zone between the last fill (at least
 * zoneMinFrac x spacing away) and that level (the first one price reaches), or the spacing level itself when it lies in a
 * strong zone (±touchPct %). {level, spacingLevel, zone: null | {low, high, tf, why, at:'BETWEEN'|'AT_SPACING'}}. */
export function ladderNextAdd({direction,lastFill,spacingPct,zones=[],zoneMinFrac=TRADER_LADDER.zoneMinFrac,touchPct=TRADER_LADDER.zoneTouchPct}){
 const d=dirOf(direction),f=pos(lastFill),s=Number(spacingPct);
 if(!f||!(s>0))return null;
 const spacingLevel=f*(1-d*s/100),minLevel=f*(1-d*s*zoneMinFrac/100),t=touchPct/100;
 // kind: 'VOLUME' (4H / 1D, strongZones) or 'WHALE' (고래 매물대, whale_zones.mjs whaleLadderZones): recorded on the fill.
 const pick=z=>({low:z.low,high:z.high,tf:z.tf,kind:z.kind??'VOLUME',why:[...z.why],rank:z.rank??null,rejections:z.rejections??0,...(z.kind==='WHALE'?{side:z.side,netUSD:z.netUSD??null}:{})});
 const between=(Array.isArray(zones)?zones:[]).map(z=>({z,level:d>0?Number(z.high):Number(z.low)}))
  .filter(({level})=>level>0&&d*(minLevel-level)>=0&&d*(level-spacingLevel)>=0)
  .sort((a,b)=>d*(b.level-a.level));
 if(between.length)return {level:between[0].level,spacingLevel,zone:{...pick(between[0].z),at:'BETWEEN'}};
 const at=(Array.isArray(zones)?zones:[]).find(z=>spacingLevel>=Number(z.low)*(1-t)&&spacingLevel<=Number(z.high)*(1+t));
 return {level:spacingLevel,spacingLevel,zone:at?{...pick(at),at:'AT_SPACING'}:null};
}

/** Take-profit price: the average + tpNetPct % net of a taker fee both ways, spread / slippage and one funding (as
 * scalp_executor profitLimit), on the tick grid on the safe side (LONG up, SHORT down). */
export function ladderTpPrice({direction,avg,takerRate=.0006,tpNetPct=TRADER_LADDER.tpNetPct,reservePct=.0004,tickSize}){
 const d=dirOf(direction),a=pos(avg);if(!a)return null;
 const fee=Math.max(0,Number(takerRate)||0),raw=a*(1+d*(fee+reservePct+tpNetPct/100))/(1-d*fee);
 if(!(raw>0))return null;
 return pos(tickSize)?grid(raw,tickSize,d>0?'UP':'DOWN'):raw;
}

/** Net result of closing `qty` at `exit` from `avg`, after a taker fee on entry and exit (for the records). */
export function ladderNetPct({direction,avg,exit,takerRate=.0006}){
 const d=dirOf(direction),a=pos(avg),x=pos(exit);if(!a||!x)return null;
 return +((d*(x-a)-takerRate*(a+x))/a*100).toFixed(4);
}
