// Portfolio backtest engine (research only: no network, no keys, no orders).
//
// One shared account trades many symbols on 5-minute candles at once. Unlike simulateTrade
// (backtest.mjs, one trade at a time, fixed size), this engine keeps:
//  - the account balance: realized PnL, fees and funding change it, and the next position is
//    sized from it (the sizing function gets the balance at that moment);
//  - concurrent positions, with a total and a per-direction cap, and a daily loss limit;
//  - split fills: the first entry, then resting adds (nearest first) that fill when touched;
//  - partial exits: targets close their share of the position (default 40 / 35 / 25 %);
//  - taker fees and slippage on every fill, funding every 8 hours (00/08/16 UTC) on the open
//    notional, always charged (conservative: the sign of the real rate is not known);
//  - cross-margin liquidation of the whole account: if equity at the worst price of a candle
//    (every open position at its own worst price at the same time) falls to the maintenance
//    margin, everything is closed at those prices and trading stops.
//
// Order of events inside one 5m candle (conservative, every step assumes the worse path):
//  1. time stop at the open;
//  2. a candle that opens beyond the stop closes at the open (gap);
//  3. adds the candle touched fill (the price went against the position first);
//  4. the stop: if touched, everything closes at the stop and targets in the same candle are ignored;
//  5. targets (only when the stop was not touched and no add filled in this candle);
//  6. funding, if the candle crosses a funding time;
//  7. liquidation check at the worst price.
// After the first target the stop moves to the average entry from the next candle on (optional).

export const PORTFOLIO_COSTS=Object.freeze({takerRate:.0006,slippageBps:2,fundingRate:.0001,maintenanceRate:.005,assumption:'EXPLICIT_RESEARCH_ASSUMPTIONS'});
export const FUNDING_MS=8*3600000;
const M5=300000;
const DEFAULT_FRACTIONS=Object.freeze([.4,.35,.25]);

/** A new position. adds: [{price,quantity}] nearest first. Quantities in base asset. */
// targetsFromAveragePct: [pct, ...] — targets follow the average entry (re-set after every add),
// e.g. [0.56] = take the whole position 0.56 % beyond the average (TRADER_REPLICA).
export function openPosition({id,symbol,direction,entryRef,stop,targets=[],quantity,adds=[],openAt,costs=PORTFOLIO_COSTS,fractions=DEFAULT_FRACTIONS,breakeven=true,maxHoldMs=null,meta={},targetsFromAveragePct=null}){
 const dir=direction==='LONG'?1:-1,slip=costs.slippageBps/10000;
 const fill=entryRef*(1+dir*slip);
 if(targetsFromAveragePct?.length){targets=targetsFromAveragePct.map(x=>fill*(1+dir*x/100));fractions=targetsFromAveragePct.length===1?[1]:fractions}
 return {id,symbol,direction,dir,stop,targets:[...targets],tpFromAvg:targetsFromAveragePct?.length?[...targetsFromAveragePct]:null,fractions:[...fractions],breakeven,maxHoldMs,openAt,meta,costs,
  qty:quantity,avg:fill,firstQty:quantity,peakQty:quantity,cost:quantity*fill,
  pending:adds.map(a=>({price:a.price,quantity:a.quantity,filled:false})),addsFilled:0,
  tpDone:targets.map(()=>false),tpQty:fractions.map(f=>quantity*f),beArmed:false,
  realized:0,fees:quantity*fill*costs.takerRate,funding:0,worstUnrealized:0,
  status:'OPEN',exitReason:null,exitAt:null,lastFundingSlot:Math.floor(openAt/FUNDING_MS),events:[{type:'ENTRY',at:openAt,price:fill,qty:quantity}]};
}

const exitFill=(p,price)=>price*(1-p.dir*p.costs.slippageBps/10000);
const addFill=(p,price)=>price*(1+p.dir*p.costs.slippageBps/10000);
function close(p,price,q,at,type){
 const f=exitFill(p,price);p.realized+=p.dir*(f-p.avg)*q;p.fees+=q*f*p.costs.takerRate;p.qty-=q;
 p.events.push({type,at,price:f,qty:q});
 if(p.qty<=1e-12){p.qty=0;p.status='CLOSED';p.exitAt=at}
}
/** Net result so far (realized - fees - funding). */
export const positionNet=p=>p.realized-p.fees-p.funding;
/** Unrealized PnL at a price (no exit costs). */
export const unrealizedAt=(p,price)=>p.status==='OPEN'?p.dir*(price-p.avg)*p.qty:0;
/** The price in candle c that is worst for the position. */
export const worstPrice=(p,c)=>p.dir===1?c.l:c.h;

/** Advance one position by one candle c ({t,o,h,l,c}) of barMs (default 5m). Returns the position (mutated). */
export function stepPosition(p,c,barMs=M5){
 if(p.status!=='OPEN')return p;
 const dir=p.dir;
 if(p.beArmed&&p.breakeven){if(dir*(p.avg-p.stop)>0)p.stop=p.avg;p.beArmed=false}
 // 1. Time stop.
 if(p.maxHoldMs&&c.t-p.openAt>=p.maxHoldMs){close(p,c.o,p.qty,c.t,'TIME_STOP');p.exitReason='TIME_STOP';return p}
 // 2. Gap beyond the stop.
 if(dir*(c.o-p.stop)<=0){close(p,c.o,p.qty,c.t,'STOP_GAP');p.exitReason=p.tpDone[0]?'BREAKEVEN_STOP':'STOP';return p}
 // 3. Adds (only before the first target), nearest first, never beyond the stop.
 let addedNow=false;
 if(!p.tpDone[0])for(const a of p.pending){
  if(a.filled)continue;
  const touched=dir===1?c.l<=a.price:c.h>=a.price;if(!touched)break;
  if(dir*(a.price-p.stop)<=0)break;
  const ref=dir===1?Math.min(a.price,c.o):Math.max(a.price,c.o),f=addFill(p,ref);
  p.avg=(p.avg*p.qty+f*a.quantity)/(p.qty+a.quantity);p.qty+=a.quantity;p.cost+=f*a.quantity;p.fees+=a.quantity*f*p.costs.takerRate;
  a.filled=true;addedNow=true;p.addsFilled++;p.peakQty=Math.max(p.peakQty,p.qty);p.tpQty=p.fractions.map(fr=>p.qty*fr);
  if(p.tpFromAvg)p.targets=p.tpFromAvg.map(x=>p.avg*(1+dir*x/100));
  p.events.push({type:'ADD',at:c.t,price:f,qty:a.quantity});
 }
 // Worst open result in this candle, never beyond the stop (the stop closes the position there).
 const wp=dir===1?Math.max(worstPrice(p,c),p.stop):Math.min(worstPrice(p,c),p.stop);
 p.worstUnrealized=Math.min(p.worstUnrealized,unrealizedAt(p,wp)+p.realized-p.fees-p.funding);
 // 4. Stop (wins over targets in the same candle).
 if(dir===1?c.l<=p.stop:c.h>=p.stop){close(p,p.stop,p.qty,c.t,'STOP');p.exitReason=p.tpDone[0]?'BREAKEVEN_STOP':'STOP';return p}
 // 5. Targets in order — not in a candle where an add filled (the order of its high and low is not
 //    known; assuming the add came first and the price then came back would flatter the result).
 if(!addedNow)for(let k=0;k<p.targets.length;k++){
  if(p.tpDone[k])continue;
  const hit=dir===1?c.h>=p.targets[k]:c.l<=p.targets[k];if(!hit)break;
  const last=k===p.targets.length-1,q=last?p.qty:Math.min(p.tpQty[k],p.qty);
  close(p,p.targets[k],q,c.t,'TP'+(k+1));p.tpDone[k]=true;if(k===0)p.beArmed=true;
  if(p.status==='CLOSED'){p.exitReason='ALL_TARGETS';return p}
 }
 // 6. Funding at each 00/08/16 UTC the candle reaches (its close).
 const slot=Math.floor((c.t+barMs)/FUNDING_MS); // reached at the candle close
 if(slot>p.lastFundingSlot){const n=slot-p.lastFundingSlot,fee=Math.abs(p.qty*c.c)*p.costs.fundingRate*n;p.funding+=fee;p.lastFundingSlot=slot;p.events.push({type:'FUNDING',at:c.t,usd:fee})}
 return p;
}

/**
 * Run a shared-account portfolio.
 *  candles: {SYMBOL: [{t,o,h,l,c}, ...]} candles of barMs (5m default; 1h works, coarser), ascending.
 *  signals: [{symbol, at (entry candle open time), direction, ...}] in any order.
 *  plan(signal, account) -> null (skip, with account.skip(reason)) or
 *    {entryRef, stop, targets, quantity, adds, riskUSD, maxHoldMs?, fractions?, meta?}
 *    riskUSD = the loss at the stop with every add filled (for the open-risk check).
 *  limits: {maxOpen, maxPerDirection, dailyLossPct, openRiskPct, oneBySymbol}
 */
export function runPortfolio({candles,signals,plan,startBalance=1000,limits={},costs=PORTFOLIO_COSTS,breakeven=true,barMs=M5}){
 const L={maxOpen:0,maxPerDirection:0,dailyLossPct:0,openRiskPct:0,oneBySymbol:true,...limits};
 const bySymbolIndex={},sigs=[...signals].sort((a,b)=>a.at-b.at);
 const times=[...new Set(Object.values(candles).flatMap(list=>list.map(c=>c.t)))].sort((a,b)=>a-b);
 for(const [s,list] of Object.entries(candles))bySymbolIndex[s]=new Map(list.map((c,i)=>[c.t,i]));
 let cash=startBalance,peakEquity=startBalance,maxDD=0,maxDDPct=0,worstEquity=startBalance,liquidated=null,seq=0,sigIdx=0;
 const open=[],closed=[],skipped={};
 const skip=r=>{skipped[r]=(skipped[r]||0)+1};
 const dayOf=t=>Math.floor(t/86400000);
 const dayNet={};
 for(const t of times){
  // Advance open positions on their own candle at t.
  for(const p of open){const i=bySymbolIndex[p.symbol].get(t);if(i===undefined)continue;stepPosition(p,candles[p.symbol][i],barMs)}
  for(let k=open.length-1;k>=0;k--){const p=open[k];if(p.status==='CLOSED'){const net=positionNet(p);cash+=net;const d=dayOf(p.exitAt);dayNet[d]=(dayNet[d]||0)+net;closed.push(p);open.splice(k,1)}}
  // Account at the worst price of this candle (cross margin).
  let worstUnreal=0,maint=0,markUnreal=0;
  for(const p of open){const i=bySymbolIndex[p.symbol].get(t);const c=i===undefined?null:candles[p.symbol][i];if(!c)continue;
   worstUnreal+=unrealizedAt(p,worstPrice(p,c))-p.fees-p.funding+p.realized;markUnreal+=unrealizedAt(p,c.c)-p.fees-p.funding+p.realized;maint+=p.qty*c.c*costs.maintenanceRate}
  const worstEq=cash+worstUnreal;worstEquity=Math.min(worstEquity,worstEq);
  if(open.length&&worstEq<=maint){
   for(const p of open){const i=bySymbolIndex[p.symbol].get(t),c=candles[p.symbol][i];close(p,c?worstPrice(p,c):p.avg,p.qty,t,'LIQUIDATION');p.exitReason='LIQUIDATION';cash+=positionNet(p);closed.push(p)}
   open.length=0;liquidated={at:t,equity:Math.max(0,cash)};cash=Math.max(0,cash);break;
  }
  var eq=cash+markUnreal;peakEquity=Math.max(peakEquity,eq);const dd=peakEquity-Math.min(eq,worstEq);if(dd>maxDD){maxDD=dd;maxDDPct=dd/peakEquity*100}
  // New entries whose entry candle opens at t.
  while(sigIdx<sigs.length&&sigs[sigIdx].at<t)sigIdx++,skip('NO_CANDLE');
  for(;sigIdx<sigs.length&&sigs[sigIdx].at===t;sigIdx++){
   const s=sigs[sigIdx];if(!bySymbolIndex[s.symbol]?.has(t)){skip('NO_CANDLE');continue}
   if(L.oneBySymbol&&open.some(p=>p.symbol===s.symbol)){skip('SYMBOL_BUSY');continue}
   if(L.maxOpen>0&&open.length>=L.maxOpen){skip('MAX_OPEN');continue}
   if(L.maxPerDirection>0&&open.filter(p=>p.direction===s.direction).length>=L.maxPerDirection){skip('MAX_PER_DIRECTION');continue}
   const balance=cash;
   if(L.dailyLossPct>0&&-(dayNet[dayOf(t)]||0)>=balance*L.dailyLossPct/100){skip('DAILY_LOSS_LIMIT');continue}
   const pl=plan(s,{balance,equity:eq,open:open.length,skip});if(!pl)continue;
   const openRisk=open.reduce((n,p)=>n+(p.meta.riskUSD||0),0);
   if(L.openRiskPct>0&&openRisk+(pl.riskUSD||0)>balance*L.openRiskPct/100){skip('OPEN_RISK_LIMIT');continue}
   const p=openPosition({id:++seq,symbol:s.symbol,direction:s.direction,entryRef:pl.entryRef,stop:pl.stop,targets:pl.targets,quantity:pl.quantity,adds:pl.adds||[],
    openAt:t,costs,fractions:pl.fractions,targetsFromAveragePct:pl.targetsFromAveragePct??null,breakeven:pl.breakeven??breakeven,maxHoldMs:pl.maxHoldMs??null,meta:{...s,...(pl.meta||{}),riskUSD:pl.riskUSD||0,balanceAtEntry:balance}});
   // The entry candle itself is replayed (entry at its open).
   stepPosition(p,candles[s.symbol][bySymbolIndex[s.symbol].get(t)],barMs);
   if(p.status==='CLOSED'){const net=positionNet(p);cash+=net;dayNet[dayOf(p.exitAt)]=(dayNet[dayOf(p.exitAt)]||0)+net;closed.push(p)}else open.push(p);
  }
 }
 // Still open at the end: closed at the last close.
 for(const p of open){const list=candles[p.symbol],c=list.at(-1);close(p,c.c,p.qty,c.t,'END');p.exitReason='OPEN_AT_END';cash+=positionNet(p);closed.push(p)}
 return {startBalance,finalBalance:cash,liquidated,maxDrawdownUSD:maxDD,maxDrawdownPct:maxDDPct,worstEquity,trades:closed.map(tradeRow),skipped};
}

export function tradeRow(p){
 return {id:p.id,symbol:p.symbol,direction:p.direction,openAt:p.openAt,exitAt:p.exitAt,exitReason:p.exitReason,addsFilled:p.addsFilled,
  peakQty:p.peakQty,averageEntry:p.avg,netUSD:positionNet(p),feesUSD:p.fees,fundingUSD:p.funding,worstOpenUSD:p.worstUnrealized,
  tp:p.tpDone.filter(Boolean).length,riskUSD:p.meta.riskUSD||0,balanceAtEntry:p.meta.balanceAtEntry,meta:p.meta};
}

/** Comparison metrics for a portfolio result. */
export function portfolioMetrics(r){
 const t=[...r.trades].sort((a,b)=>a.exitAt-b.exitAt),n=t.length,wins=t.filter(x=>x.netUSD>0);
 const gross=wins.reduce((s,x)=>s+x.netUSD,0),loss=-t.filter(x=>x.netUSD<=0).reduce((s,x)=>s+x.netUSD,0);
 const byAdds={};for(const x of t){const k=Math.min(x.addsFilled,5)+(x.addsFilled>=5?'+':'');(byAdds[k]??={n:0,netUSD:0});byAdds[k].n++;byAdds[k].netUSD+=x.netUSD}
 return {trades:n,netUSD:r.finalBalance-r.startBalance,returnPct:(r.finalBalance/r.startBalance-1)*100,winRatePct:n?wins.length/n*100:null,
  profitFactor:loss>0?gross/loss:null,expectancyUSD:n?(r.finalBalance-r.startBalance)/n:null,maxDrawdownPct:r.maxDrawdownPct,maxDrawdownUSD:r.maxDrawdownUSD,
  worstOpenUSD:n?Math.min(...t.map(x=>x.worstOpenUSD)):0,worstTradeUSD:n?Math.min(...t.map(x=>x.netUSD)):0,
  feesUSD:t.reduce((s,x)=>s+x.feesUSD,0),fundingUSD:t.reduce((s,x)=>s+x.fundingUSD,0),liquidated:!!r.liquidated,byAdds,skipped:r.skipped};
}
