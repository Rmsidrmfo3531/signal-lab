// Post-Only (maker 0.02%) first order execution with bounded wait and safe MARKET fallback
// for any unfilled remainder (user 2026-11-23: cut taker 0.05% fee drain on BTC/ETH/alt entries).
// Never double-fills (audit C-1, 2026-11-23): after the cancel the PostOnly order must be read back in a
// terminal state (FILLED / CANCELED / EXPIRED ...) by its clientOrderId; only then is MARKET sent, for
// strictly the confirmed remaining quantity. A state that stays unknown throws MAKER_STATE_UNCONFIRMED
// and nothing is sent at market.
// Child clientOrderIds (audit C-2): limit = cid.slice(0,31)+'p', market = cid.slice(0,31)+'m', so a full
// 32-character id never makes the two orders share one clientOrderId.
import {roundDecimalToStep} from './decimal_grid.mjs';
import {forMode} from './bingx_position_mode.mjs';

const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const orderOf=d=>d?.order??d;
const defaultSleep=ms=>new Promise(r=>setTimeout(r,ms));
const TERMINAL=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED']);
const CONFIRM_TRIES=4;

/** The clientOrderIds of the PostOnly limit child and the MARKET remainder child of `clientOrderId`. */
export function makerChildIds(clientOrderId){
 const base=String(clientOrderId||'mk').slice(0,31);
 return {limit:base+'p',market:base+'m'};
}

/** Compute a passive Post-Only limit price 1 tick inside the passive side of markPrice. */
export function makerLimitPrice({side,markPrice,tickSize}){
 const mk=pos(markPrice);
 if(!mk)return null;
 const tick=pos(tickSize);
 const isBuy=String(side||'').toUpperCase()==='BUY';
 if(!tick)return mk;
 const base=Number(roundDecimalToStep(mk,tickSize,isBuy?'DOWN':'UP'));
 if(!(base>0))return null;
 // Place 1 tick passive if base equals markPrice so PostOnly is far less likely to be rejected on fast ticks.
 if(Math.abs(base-mk)<=tick*1e-6){
  const nudged=isBuy?base-tick:base+tick;
  if(nudged>0)return Number(roundDecimalToStep(nudged,tickSize,isBuy?'DOWN':'UP'));
 }
 return base;
}

function roundQtyDown(qty,step){
 if(!(qty>0))return 0;
 if(!pos(step))return Number(qty.toFixed(8));
 return Number(roundDecimalToStep(qty,step,'DOWN'))||0;
}

function isPostOnlyReject(error){
 const code=String(error?.code||'');
 const msg=String(error?.message||'');
 return /post.?only|gtx|immediately|would match|would take|cross|101400|101415|80014/i.test(code+' '+msg);
}

/**
 * Try a Post-Only LIMIT order for up to `waitMs`, cancel any unfilled remainder,
 * verify final filled qty via `getOrder`, and send MARKET strictly for the remainder.
 */
export async function placeMakerThenMarket({
 client,
 symbol,
 side,
 positionSide,
 quantity,
 quantityStep=null,
 minQuantity=0,
 tickSize=null,
 markPrice=null,
 hedge=false,
 clientOrderId,
 reduceOnly=false,
 extraParams={},
 waitMs=2500,
 pollMs=500,
 sleep=defaultSleep,
 beforeSend,
}){
 const qty=pos(quantity);
 if(!qty)throw Object.assign(Error('INVALID_QUANTITY'),{code:'INVALID_QUANTITY'});
 const baseParams=forMode({
  symbol,
  side,
  positionSide,
  ...(reduceOnly&&!hedge?{reduceOnly:'true'}:{}),
  ...extraParams,
 },hedge);

 const sendMarket=async(remQty,cid)=>{
  const res=orderOf(await client.placeOrder({...baseParams,type:'MARKET',quantity:String(remQty),clientOrderId:cid},{beforeSend}));
  const filled=pos(res?.executedQty)??remQty;
  return {res,orderId:res?.orderId!=null?String(res.orderId):null,filledQty:filled,avg:pos(res?.avgPrice),status:res?.status??'FILLED'};
 };

 const canMaker=Boolean(
  client&&typeof client.getOrder==='function'&&typeof client.cancelOrder==='function'
  &&pos(markPrice)&&pos(tickSize)
 );
 const limitPx=canMaker?makerLimitPrice({side,markPrice,tickSize}):null;
 if(!canMaker||!limitPx){
  const m=await sendMarket(qty,clientOrderId);
  return {executionMode:'MARKET',orderId:m.orderId,makerOrderId:null,marketOrderId:m.orderId,filledQty:m.filledQty,makerQty:0,marketQty:m.filledQty,avg:m.avg,status:m.status,receipt:m.res};
 }

 const {limit:makerCid,market:marketCid}=makerChildIds(clientOrderId);
 let makerRes=null;
 try{
  makerRes=orderOf(await client.placeOrder({
   ...baseParams,
   type:'LIMIT',
   timeInForce:'PostOnly',
   price:String(limitPx),
   quantity:String(qty),
   clientOrderId:makerCid,
  },{beforeSend}));
 }catch(e){
  if(e?.code==='ENTRY_NOT_SENT'||!isPostOnlyReject(e)){
   // If blocked by pre-send safety gate, network/rate-limit, or margin/auth/position-limit error, rethrow cleanly.
   if(e?.code==='ENTRY_NOT_SENT'||e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'||/101429|insufficient|margin|balance|auth|key|leverage|limit|circuit/i.test(String(e?.code||'')+' '+String(e?.message||'')))throw e;
  }
  const m=await sendMarket(qty,marketCid);
  return {executionMode:'MARKET',orderId:m.orderId,makerOrderId:null,marketOrderId:m.orderId,filledQty:m.filledQty,makerQty:0,marketQty:m.filledQty,avg:m.avg,status:m.status,receipt:m.res,makerFallbackReason:e?.code||'POST_ONLY_REJECTED'};
 }

 let makerId=makerRes?.orderId!=null?String(makerRes.orderId):null;
 let latest=makerRes;
 let status=String(latest?.status||'NEW').toUpperCase();
 const deadline=Date.now()+Math.max(0,Number(waitMs)||0);
 const poll=Math.max(50,Number(pollMs)||500);
 // Read the PostOnly order by its clientOrderId (works even when the placement answer had no orderId).
 const readMaker=async()=>{
  const fresh=orderOf(await client.getOrder(symbol,{clientOrderId:makerCid,...(makerId?{orderId:makerId}:{})}));
  if(fresh){
   latest=fresh;status=String(fresh.status||'').toUpperCase()||status;
   if(!makerId&&fresh.orderId!=null)makerId=String(fresh.orderId);
  }
  return fresh;
 };

 while(!TERMINAL.has(status)&&Date.now()<deadline){
  await sleep(Math.min(poll,Math.max(0,deadline-Date.now())));
  try{await readMaker()}catch{break}
 }

 if(!TERMINAL.has(status)){
  // Cancel, then confirm a terminal state before anything is sent at market (a cancel that failed or a read
  // that failed leaves the PostOnly order possibly resting: sending the remainder could double-fill).
  for(let attempt=0;attempt<CONFIRM_TRIES&&!TERMINAL.has(status);attempt++){
   if(attempt===0||attempt===2){try{await client.cancelOrder(symbol,makerId??undefined,{clientOrderId:makerCid})}catch{}}
   if(attempt>0)await sleep(poll);
   try{await readMaker()}catch{}
  }
 }
 const confirmedQty=num(latest?.executedQty);
 if(!TERMINAL.has(status)||(confirmedQty===null&&status!=='FILLED')){
  const detail=`PostOnly 주문 최종 상태 확인 불가(${status||'UNKNOWN'}, ${makerCid}) — 시장가 잔량을 보내지 않음`;
  throw Object.assign(Error(detail),{code:'MAKER_STATE_UNCONFIRMED',
   makerOrderId:makerId,makerClientOrderId:makerCid,lastStatus:status||null,lastExecutedQty:confirmedQty,detail});
 }

 const makerQty=Math.max(0,confirmedQty??(status==='FILLED'?qty:0));
 const makerAvg=pos(latest?.avgPrice)??limitPx;
 const minQ=pos(minQuantity)??0;
 const remRaw=Math.max(0,qty-makerQty);
 const remQty=roundQtyDown(remRaw,quantityStep);

 if(remQty<=0||(minQ>0&&remQty<minQ)){
  return {
   executionMode:'MAKER',
   orderId:makerId,
   makerOrderId:makerId,
   marketOrderId:null,
   filledQty:makerQty,
   makerQty,
   marketQty:0,
   avg:makerAvg,
   status:status||'FILLED',
   limitPrice:limitPx,
   receipt:latest,
  };
 }

 // Fallback MARKET strictly for the remaining unfilled quantity.
 const m=await sendMarket(remQty,marketCid);
 const totalFilled=makerQty+m.filledQty;
 const avg=makerQty>0&&m.avg&&makerAvg
  ?+((makerQty*makerAvg+m.filledQty*m.avg)/totalFilled).toFixed(10)
  :(m.avg??makerAvg);
 return {
  executionMode:makerQty>0?'HYBRID':'MARKET',
  orderId:m.orderId||makerId,
  makerOrderId:makerId,
  marketOrderId:m.orderId,
  filledQty:totalFilled,
  makerQty,
  marketQty:m.filledQty,
  avg,
  status:m.status,
  limitPrice:limitPx,
  receipt:m.res,
 };
}
