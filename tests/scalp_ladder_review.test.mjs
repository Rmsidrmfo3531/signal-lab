// TRADER_LADDER review 2026-11-24 (signal-reviewer): reproduction tests for the gaps found in the ladder management —
// a step given back while its PostOnly child may still rest (two fills for one step, past the per-symbol cap), the
// final line skipped while an add is pending, a take-profit answer lost before a partial fill (a phantom add), and
// open 4H candles counted as zone rejections. Fake BingX TESTNET client only: no network, no orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {makerChildIds} from '../maker_order.mjs';

const I=300000,H=3600000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({lastOpen=(BUCKET-1)*I}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-6/4;push(o,o+.05,c-.1,c,100*10*(i===3?1:.5));p=c}
 push(p,p+.15,p-.8,p+.1,800);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*H-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*H-1,'1']});
const hourly=now=>Array.from({length:40},(_,i)=>{const t=now-(40-i)*H-1000,c=94;return [t,String(c),String(c*1.002),String(c*.998),String(c),'1000',t+H-1,'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const contract=sym=>({symbol:sym,venueSymbol:sym.replace('USDT','-USDT'),tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true});
const VS='SOL-USDT';

/** One-way BingX TESTNET fake with resting PostOnly orders, cancel by client id, and switchable failures. */
function venue({dropAdd=false,iocPartialLost=false}={}){
 const st=new Map(),orders=new Map(),calls=[];let id=1;const net={down:false,downAfterPostOnly:false,getOrderDown:false};
 const S=vs=>{if(!st.has(vs))st.set(vs,{amt:0,avg:0,mark:0});return st.get(vs)};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const open=(s,side,q,px)=>{const sign=side==='SELL'?-1:1;s.avg=(s.avg*Math.abs(s.amt)+px*q)/(Math.abs(s.amt)+q);s.amt=+(s.amt+sign*q).toFixed(8)};
 const reduce=(s,q)=>{s.amt=s.amt>0?+Math.max(0,s.amt-q).toFixed(8):+Math.min(0,s.amt+q).toFixed(8)};
 const fail=()=>{if(net.down)throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 const find=({orderId,clientOrderId})=>[...orders.values()].find(o=>orderId!=null?o.orderId===String(orderId):o.clientOrderId===clientOrderId)??null;
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async vs=>{fail();return [...st.entries()].filter(([k,v])=>v.amt!==0&&(!vs||k===vs)).map(([k,v])=>({symbol:k,positionSide:'BOTH',positionAmt:String(v.amt),avgPrice:String(v.avg),markPrice:String(v.mark||v.avg),unrealizedProfit:String(((v.mark||v.avg)-v.avg)*v.amt)}))},
  openOrders:async()=>{fail();return {orders:[...orders.values()].filter(o=>o.status==='NEW')}},
  getOrder:async(s,q)=>{fail();if(net.getOrderDown)throw Object.assign(Error('down'),{code:'HTTP_503'});return {order:find(q)}},
  cancelOrder:async(s,oid,{clientOrderId}={})=>{fail();const o=find(oid!=null?{orderId:oid}:{clientOrderId});if(o&&o.status==='NEW')o.status='CANCELED';return {order:o}},
  placeOrder:async(p,{beforeSend}={})=>{
   const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});
   fail();calls.push(p);const s=S(p.symbol),q=Number(p.quantity);
   if(p.type==='MARKET'){
    if(dropAdd&&!p.reduceOnly&&/L\d+n\d+$/.test(p.clientOrderId||''))throw Object.assign(Error('no answer'),{code:'NETWORK_UNREACHABLE'});
    const px=s.mark||PX;if(p.reduceOnly)reduce(s,q);else open(s,p.side,q,px);
    return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(px)})};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='IOC'&&p.reduceOnly){
    const can=p.side==='SELL'?s.mark>=Number(p.price):s.mark<=Number(p.price);
    if(!can)return {order:add(p,{status:'EXPIRED',executedQty:'0'})};
    // The venue fills half and the answer is lost.
    if(iocPartialLost){const h=Math.floor(q/2*100)/100;reduce(s,h);add(p,{status:'EXPIRED',executedQty:String(h),avgPrice:String(p.price)});throw Object.assign(Error('no answer'),{code:'NETWORK_UNREACHABLE'})}
    reduce(s,q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(p.price)})};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='PostOnly'){const o=add(p,{status:'NEW',executedQty:'0'});if(net.downAfterPostOnly)net.down=true;return {order:o}}
   return {order:add(p)};
  }};
 // A resting PostOnly order filled later at its price (the market came back through it).
 const fillResting=cid=>{const o=find({clientOrderId:cid});if(!o||o.status!=='NEW')return false;open(S(o.symbol),o.side,Number(o.quantity),Number(o.price));o.status='FILLED';o.executedQty=o.quantity;o.avgPrice=o.price;return true};
 return {client,calls,st:S,orders,net,fillResting};
}
function make(v,{clock,config={}}={}){
 return new ScalpExecutor({config:{...scalpExecConfig({}),minScore:0,makerEntry:false,makerExit:false,dailyLossPct:20,makerWaitMs:0,makerPollMs:1,...config},client:v.client,
  contracts:async()=>new Map([['SOLUSDT',contract('SOLUSDT')]]),tickers:async()=>[{symbol:VS,quoteVolume:'90000000'}],
  candles:async(s,iv)=>iv==='5m'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:iv==='1h'?hourly(clock.t):up4h(clock.t),
  zoneCandles:async()=>[],priceOf:async()=>PX,markOf:async()=>PX,balance:async()=>({equity:10000,available:9000}),gate:()=>({ok:true}),isBusy:()=>false,now:()=>clock.t});
}
const setMark=(v,price)=>{v.st(VS).mark=price};
const below=x=>+(Math.floor(x*100)/100-.01).toFixed(2);
async function opened(opt={}){const v=venue(opt.venue),clock={t:T0},ex=make(v,{clock,config:opt.config});ex.arm();await ex.scan();return {v,clock,ex,p:ex.store.open[0]}}
const used=p=>p.ladder.fills.reduce((t,f)=>t+f.qty*f.price/p.leverage,0);

test('a step is never given back while its PostOnly child may rest: after an outage the child is cancelled first (one fill per step, cap kept)',async()=>{
 const {v,clock,ex,p}=await opened();
 // Steps 2-3 at market.
 for(let i=0;i<2;i++){setMark(v,below(p.ladder.lastFill*.975));clock.t+=10000;await ex.reconcile()}
 assert.equal(p.ladder.filled,3);
 // Step 4 (8 units, last step) with the maker entry: the PostOnly child rests and the network drops right after it is sent.
 ex.config.makerEntry=true;v.net.downAfterPostOnly=true;
 setMark(v,below(p.ladder.lastFill*.975));clock.t+=10000;await ex.reconcile();
 assert.ok(p.ladder.pending?.unknown,'pending with an unknown outcome');
 const firstCid=makerChildIds(p.ladder.pending.clientOrderId).limit;
 assert.equal(v.orders.size&&[...v.orders.values()].find(o=>o.clientOrderId===firstCid)?.status,'NEW');
 // Three minutes without the venue, then it answers again.
 v.net.downAfterPostOnly=false;
 for(let i=0;i<6;i++){clock.t+=30000;await ex.reconcile()}
 v.net.down=false;
 clock.t+=5000;await ex.reconcile();
 clock.t+=20000;await ex.reconcile();
 clock.t+=20000;await ex.reconcile();
 // The first child must be cancelled before any retry: it can no longer fill on top of the retry.
 const late=v.fillResting(firstCid);
 clock.t+=10000;await ex.reconcile();clock.t+=10000;await ex.reconcile();
 const q=ex.store.open[0]??p;
 assert.ok(used(q)<=q.ladder.capUSD+1,`ladder margin ${used(q).toFixed(2)} > cap ${q.ladder.capUSD} (filled ${q.ladder.filled}/${q.ladder.units.length})`);
 assert.ok(q.ladder.filled<=q.ladder.units.length,`filled ${q.ladder.filled} steps of ${q.ladder.units.length}`);
 assert.equal(late,false,'the first PostOnly child was still resting after the step was given back and retried');
});

test('while an add is pending the final line still closes the position (no 2-minute gap)',async()=>{
 const {v,clock,ex,p}=await opened({venue:{dropAdd:true}});
 const first=p.avg;
 setMark(v,below(first*.975));clock.t+=10000;await ex.reconcile();
 assert.ok(p.ladder.pending,'the add answer was lost: pending');
 // 30 s later the price is past the -75 % ROE line of the position (10x: 7.5 % under the average).
 setMark(v,+(first*(1-.08)).toFixed(2));clock.t+=30000;await ex.reconcile();
 const closes=v.calls.filter(c=>c.type==='MARKET'&&c.reduceOnly);
 assert.equal(closes.length,1,'closed at the final line while the add was pending');
 assert.equal(v.st(VS).amt,0);
 // The ledger closes once the add attempt is resolved, with the emergency reason.
 for(let i=0;i<8;i++){clock.t+=30000;await ex.reconcile()}
 assert.equal(ex.store.open.length,0);assert.equal(ex.store.closed[0].closeReason,'EMERGENCY_ROE_STOP');
 assert.equal(v.calls.filter(c=>c.type==='MARKET'&&!c.reduceOnly&&/L\d+n\d+$/.test(c.clientOrderId)).length,1,'no add retried after the close');
});

test('a take-profit answer lost after a partial fill: booked once, no phantom add',async()=>{
 const {v,clock,ex,p}=await opened({venue:{iocPartialLost:true}});
 setMark(v,below(p.avg*.975));clock.t+=10000;await ex.reconcile();assert.equal(p.ladder.filled,2);
 const size=p.size;
 setMark(v,+(p.avg*1.02).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.ok(p.ladder.exit,'TP answer lost: looked up next');
 // The IOC lookup works on the next checks (EXPIRED with half filled).
 setMark(v,+(p.avg*1.001).toFixed(2));clock.t+=10000;await ex.reconcile();clock.t+=10000;await ex.reconcile();
 assert.equal(ex.store.events.filter(e=>e.type==='LADDER_ADD').length,1,'only the real add (step 2): no late-fill phantom');
 assert.equal(p.ladder.filled,2);
 assert.ok(Math.abs(p.ladder.size-v.st(VS).amt)<1e-9,`ledger ${p.ladder.size} vs venue ${v.st(VS).amt}`);
 assert.ok(v.st(VS).amt<size);
});

test('a take-profit answer lost and its lookup failing: the final line still closes the position',async()=>{
 const {v,clock,ex,p}=await opened({venue:{iocPartialLost:true}});
 setMark(v,+(p.avg*1.02).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.ok(p.ladder.exit,'TP answer lost');
 v.net.getOrderDown=true;
 setMark(v,+(p.avg*(1-.08)).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(v.st(VS).amt,0,'closed at the line although the TP lookup fails');
 assert.equal(ex.store.events.filter(e=>e.type==='EMERGENCY_ROE_STOP').length,1);
});

test('zone rejections count only closed 4H candles',async()=>{
 const {v,clock,ex,p}=await opened();
 const f=p.ladder.lastFill,zone={low:+(f*.980).toFixed(2),high:+(f*.983).toFixed(2),rank:4,sharePct:2};
 const t4=Math.floor(clock.t/(4*H))*4*H;
 // Two closed rejections and one in the 4H candle still open (its "close" is the live price).
 const bar=(t,l,c)=>[t,String(c),String(c+.5),String(l),String(c),'1000',t+4*H-1,'1'];
 const rows=[bar(t4-16*H,zone.low,zone.high+1),bar(t4-12*H,zone.high+2,zone.high+3),bar(t4-8*H,zone.low,zone.high+1),bar(t4-4*H,zone.high+2,zone.high+3),bar(t4,zone.low,zone.high+1)];
 ex.zoneBookOf=async(sym,iv)=>{if(iv!=='4h')return null;ex.zoneCache.set(sym+'|4h',{rows,nextCloseAt:t4+4*H,tickSize:'0.01',usedAt:clock.t});return ()=>[zone]};
 setMark(v,+(f*.985).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.ok(p.ladder.zones,'zones read');
 assert.deepEqual(p.ladder.zones.list,[],JSON.stringify(p.ladder.zones.list));
});

test('no 4H / 1D zone read before the price is half a spacing from the last fill (the routine check never waits on it)',async()=>{
 const {v,clock,ex,p}=await opened();
 let reads=0;ex.zoneBookOf=async()=>{reads++;return null};
 setMark(v,+(p.ladder.lastFill*.993).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(reads,0);
 setMark(v,+(p.ladder.lastFill*.985).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(reads,2,'4H and 1D read once the add can come');
});
