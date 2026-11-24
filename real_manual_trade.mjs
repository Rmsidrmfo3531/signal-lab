// Real-account manual trading module (BingX USDT-M perpetual futures).
// Provides symbol spec lookup, pure order planning/validation, execution (market/limit + TP/SL),
// and open-order listing/cancellation. Never executes without explicit confirmation ('REAL_MANUAL_ORDER').
import {roundDecimalToStep} from './decimal_grid.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,forMode} from './bingx_position_mode.mjs';
import {resolveCopyContract} from './copy_executor.mjs';
import {bingxBalanceRows,balanceOf} from './exchange_pnl.mjs';
import {displaySymbol} from './public/symbol_display.js';
import {isCoinSymbol} from './venue_charts.mjs';
import {placeMakerThenMarket} from './maker_order.mjs';
import {venueRows,normalizeVenuePosition} from './venue_positions.mjs';

export const REAL_CHART_INTERVALS=Object.freeze(['1m','5m','15m','1h','4h','1d']);

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const err=(code,message,httpStatus=400)=>Object.assign(Error(message),{code,httpStatus});

/** Build full tradable BingX perpetual futures market list joined with 24h tickers and open positions. */
export function buildBingxMarketList({contracts,tickers=[],openPositions=[]}={}){
 const tMap=new Map();
 for(const t of Array.isArray(tickers)?tickers:[]){
  const vs=String(t?.symbol||'').toUpperCase();
  if(vs)tMap.set(vs,t);
 }
 const posMap=new Map();
 for(const p of Array.isArray(openPositions)?openPositions:[]){
  const k=displaySymbol(String(p?.symbol||p?.venueSymbol||'').replace(/[-_]/g,'').toUpperCase());
  if(!k)continue;
  const arr=posMap.get(k)||[];
  arr.push({direction:p.direction,size:pos(p.size??p.qty),avg:pos(p.avg),unrealized:num(p.unrealized),roePct:num(p.roePct),origin:p.origin||'copy'});
  posMap.set(k,arr);
 }
 const entries=contracts instanceof Map?[...contracts.values()]:Array.isArray(contracts)?contracts:[];
 const out=[];
 for(const c of entries){
  if(!c||c.tradable===false||!c.venueSymbol)continue;
  const t=tMap.get(String(c.venueSymbol).toUpperCase());
  const lastPrice=pos(t?.lastPrice);
  const changePct=num(t?.priceChangePercent);
  const rawQuote=num(t?.quoteVolume);
  const quoteVolume=rawQuote!=null?rawQuote:(pos(t?.volume)&&lastPrice?Number(t.volume)*lastPrice:0);
  const disp=displaySymbol(c.symbol);
  out.push({
   symbol:c.symbol,
   displaySymbol:disp,
   venueSymbol:c.venueSymbol,
   category:isCoinSymbol(c.symbol)?'FUTURES':'TRADFI',
   lastPrice,
   changePct,
   quoteVolume:Number.isFinite(quoteVolume)?+quoteVolume.toFixed(2):0,
   high24h:pos(t?.highPrice),
   low24h:pos(t?.lowPrice),
   tickSize:c.tickSize??null,
   quantityStep:c.quantityStep??null,
   minQuantityBase:pos(c.minQuantityBase)??0,
   minNotionalUSDT:pos(c.minNotionalUSDT)??0,
   holding:posMap.get(disp)||[],
  });
 }
 out.sort((a,b)=>(b.quoteVolume||0)-(a.quoteVolume||0)||a.displaySymbol.localeCompare(b.displaySymbol));
 return out;
}

export function normalizeManualSymbol(raw){
 const s=String(raw||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!s||s.length<2||s.length>30)return '';
 return s.endsWith('USDT')?s:`${s}USDT`;
}

function parseLeverageInfo(raw){
 const d=raw?.data??raw;
 const maxLong=pos(d?.maxLongLeverage??d?.maxLeverage);
 const maxShort=pos(d?.maxShortLeverage??d?.maxLeverage);
 const curLong=pos(d?.longLeverage??d?.leverage);
 const curShort=pos(d?.shortLeverage??d?.leverage);
 return {
  maxLeverage:{long:maxLong,short:maxShort},
  currentLeverage:{long:curLong,short:curShort},
 };
}

/** Pure order planner & validator for manual BingX futures orders. */
export function planRealManualOrder({
 side,orderType='MARKET',amountMode='MARGIN_USDT',amount,price=null,
 leverage,marginMode='CROSSED',tpPrice=null,slPrice=null,makerFirst=false,postOnly=false,
 contract,markPrice,availableUSD=null,maxLeverage=125,maxMarginUSD=null,
}={}){
 const dir=String(side||'').trim().toUpperCase();
 if(!['LONG','SHORT'].includes(dir))throw err('INVALID_SIDE','방향은 LONG 또는 SHORT만 지원합니다');
 const type=String(orderType||'MARKET').trim().toUpperCase();
 if(!['MARKET','LIMIT'].includes(type))throw err('INVALID_ORDER_TYPE','주문 방식은 MARKET(시장가) 또는 LIMIT(지정가)만 지원합니다');
 const mode=String(amountMode||'MARGIN_USDT').trim().toUpperCase();
 if(!['MARGIN_USDT','NOTIONAL_USDT','COIN'].includes(mode))throw err('INVALID_AMOUNT_MODE','수량 단위는 증거금(USDT), 주문금액(USDT), 코인 수량 중 하나여야 합니다');
 const mMode=String(marginMode||'CROSSED').trim().toUpperCase();
 if(!['CROSSED','ISOLATED'].includes(mMode))throw err('INVALID_MARGIN_MODE','마진 모드는 교차(CROSSED) 또는 격리(ISOLATED)만 지원합니다');
 const amt=pos(amount);
 if(!amt)throw err('INVALID_AMOUNT','주문 수량 또는 금액을 0보다 크게 입력하세요');
 if(!contract||!contract.venueSymbol)throw err('NO_BINGX_CONTRACT','BingX에서 거래 가능한 종목을 찾지 못했습니다',404);
 const maxLev=Math.max(1,Math.min(125,Math.floor(pos(maxLeverage)||125)));
 const lev=Math.round(Number(leverage));
 if(!Number.isFinite(lev)||lev<1||lev>maxLev)throw err('INVALID_LEVERAGE',`레버리지는 1 ~ ${maxLev}배 사이로 입력하세요`);

 const tick=contract.tickSize,step=contract.quantityStep;
 const mk=pos(markPrice);
 let limitPrice=null,execPrice=mk;
 if(type==='LIMIT'){
  const rawPx=pos(price);
  if(!rawPx)throw err('INVALID_PRICE','지정가 주문은 유효한 주문 가격을 입력해야 합니다');
  limitPrice=tick?Number(roundDecimalToStep(rawPx,tick,dir==='LONG'?'DOWN':'UP')):rawPx;
  if(!(limitPrice>0))throw err('INVALID_PRICE','지정가 주문 가격이 최소 호가 단위 미만입니다');
  execPrice=limitPrice;
 }else if(!(execPrice>0)){
  throw err('PRICE_UNVERIFIED','현재 시장가를 조회하지 못했습니다. 잠시 후 다시 시도하세요',502);
 }

 const rawQty=mode==='MARGIN_USDT'?(amt*lev/execPrice):mode==='NOTIONAL_USDT'?(amt/execPrice):amt;
 const qty=step?Number(roundDecimalToStep(rawQty,step,'DOWN')):Number(rawQty.toFixed(8));
 const minQ=pos(contract.minQuantityBase)??0;
 const minN=pos(contract.minNotionalUSDT)??0;
 if(!(qty>0)||qty<minQ){
  const minDisp=minQ?`${+minQ.toPrecision(6)}`:'최소 단위';
  throw err('QUANTITY_BELOW_MIN',`주문 수량(${qty||0})이 거래소 최소 수량(${minDisp}) 미만입니다`);
 }
 const notionalUSD=qty*execPrice;
 if(minN>0&&notionalUSD<minN){
  throw err('NOTIONAL_BELOW_MIN',`주문 명목가치($${notionalUSD.toFixed(2)})가 거래소 최소 금액($${minN}) 미만입니다 (증거금 기준 최소 $${(minN/lev).toFixed(2)} 이상 필요)`);
 }
 const marginUSD=notionalUSD/lev;
 const avail=num(availableUSD);
 if(avail!==null&&marginUSD>avail*0.98){
  throw err('MARGIN_SHORT',`필요 증거금($${marginUSD.toFixed(2)})이 현재 가용 증거금($${avail.toFixed(2)})을 초과합니다`);
 }
 const marginCap=pos(maxMarginUSD);
 if(marginCap!==null&&marginUSD>marginCap+0.01){
  throw err('MANUAL_MARGIN_CAP',`단일 수동 주문 증거금($${marginUSD.toFixed(2)})이 안전 한도($${marginCap.toFixed(2)})를 초과합니다`);
 }

 let tp=null,sl=null;
 const sign=dir==='LONG'?1:-1;
 if(tpPrice!=null&&String(tpPrice).trim()!==''){
  const rawTp=pos(tpPrice);
  if(!rawTp)throw err('INVALID_TP','익절(TP) 가격이 올바르지 않습니다');
  tp=tick?Number(roundDecimalToStep(rawTp,tick,dir==='LONG'?'UP':'DOWN')):rawTp;
  if(!(sign*(tp-execPrice)>0))throw err('INVALID_TP',dir==='LONG'?'롱 익절가(TP)는 진입가보다 높아야 합니다':'숏 익절가(TP)는 진입가보다 낮아야 합니다');
 }
 if(slPrice!=null&&String(slPrice).trim()!==''){
  const rawSl=pos(slPrice);
  if(!rawSl)throw err('INVALID_SL','손절(SL) 가격이 올바르지 않습니다');
  sl=tick?Number(roundDecimalToStep(rawSl,tick,dir==='LONG'?'DOWN':'UP')):rawSl;
  if(!(sign*(execPrice-sl)>0))throw err('INVALID_SL',dir==='LONG'?'롱 손절가(SL)는 진입가보다 낮아야 합니다':'숏 손절가(SL)는 진입가보다 높아야 합니다');
 }

 const isPostOnly=type==='LIMIT'&&postOnly===true;
 const isMakerFirst=type==='MARKET'&&makerFirst===true;
 const makerRate=pos(contract.makerFeeRate)??0.0002;
 const takerRate=pos(contract.takerFeeRate)??0.0005;
 const entryFeeRate=(isPostOnly||isMakerFirst)?makerRate:takerRate;
 const rtRate=entryFeeRate+takerRate;

 return {
  symbol:contract.symbol,
  displaySymbol:displaySymbol(contract.symbol),
  venueSymbol:contract.venueSymbol,
  side:dir,
  orderSide:dir==='LONG'?'BUY':'SELL',
  orderType:type,
  marginMode:mMode,
  leverage:lev,
  qty,
  execPrice,
  limitPrice,
  notionalUSD:+notionalUSD.toFixed(2),
  marginUSD:+marginUSD.toFixed(2),
  tpPrice:tp,
  slPrice:sl,
  makerFirst:isMakerFirst,
  postOnly:isPostOnly,
  estRoundTripFeeUSD:+(notionalUSD*rtRate).toFixed(4),
  breakevenMovePct:+(rtRate*100).toFixed(3),
  breakevenRoePct:+(rtRate*lev*100).toFixed(2),
 };
}

/** Look up contract specs, live price, leverage ceiling, and copy holding status for a symbol. */
export async function lookupRealTradeSymbol({
 rawSymbol,client,contractsFor,markOf,availableUSD=null,copyPositions=[],
}){
 const symbol=normalizeManualSymbol(rawSymbol);
 if(!symbol)throw err('INVALID_SYMBOL','종목명을 입력하세요 (예: BTC, ETH, AKE)');
 const map=await contractsFor(symbol);
 const c=resolveCopyContract(map,symbol);
 if(!c)throw err('NO_BINGX_CONTRACT',`BingX 무기한 선물에서 ${displaySymbol(symbol)} 종목을 찾지 못했습니다`,404);
 const [price,levRaw]=await Promise.all([
  Promise.resolve(markOf(c.venueSymbol)).catch(()=>null),
  client?.leverage?client.leverage(c.venueSymbol).catch(()=>null):null,
 ]);
 const levInfo=parseLeverageInfo(levRaw);
 const disp=displaySymbol(c.symbol);
 const copyHolding=(Array.isArray(copyPositions)?copyPositions:[])
  .filter(p=>p&&p.status==='OPEN'&&(p.symbol===c.symbol||displaySymbol(p.symbol)===disp))
  .map(p=>({direction:p.direction,qty:p.qty,leverage:p.leverage}));
 return {
  symbol:c.symbol,
  displaySymbol:disp,
  venueSymbol:c.venueSymbol,
  price:pos(price),
  tickSize:c.tickSize??null,
  quantityStep:c.quantityStep??null,
  minQuantityBase:pos(c.minQuantityBase)??0,
  minNotionalUSDT:pos(c.minNotionalUSDT)??0,
  unitMultiplier:pos(c.unitMultiplier)||1,
  maxLeverage:levInfo.maxLeverage,
  currentLeverage:levInfo.currentLeverage,
  availableUSD:num(availableUSD),
  copyHolding,
 };
}

/** Open copy-ledger positions sharing this contract: symbol (any side, margin mode is per symbol) and the side lane
 * whose leverage the order would set (one-way: every side shares it; hedge: the same direction only). */
export function copyLaneOf({copyPositions=[],contract,side,hedge}){
 const vs=String(contract?.venueSymbol||''),sym=String(contract?.symbol||''),disp=displaySymbol(sym);
 const symbol=(Array.isArray(copyPositions)?copyPositions:[]).filter(p=>p&&p.status==='OPEN'
  &&((vs&&(p.venueSymbol===vs||p.venueAlias===vs))||p.symbol===sym||displaySymbol(p.symbol)===disp));
 const laneSide=symbol.filter(p=>!hedge||p.hedge!==true||p.direction===String(side||'').toUpperCase());
 return {symbol,side:hedge?laneSide:symbol};
}

/** Execute a confirmed real-account manual order on BingX. */
export async function executeRealManualOrder({
 confirm,symbol,side,orderType='MARKET',amountMode='MARGIN_USDT',amount,price=null,
 leverage,marginMode='CROSSED',tpPrice=null,slPrice=null,makerFirst=false,postOnly=false,makerWaitMs=2500,sleep,
 client,contractsFor,markOf,safety=null,copyPositions=[],
}){
 if(confirm!=='REAL_MANUAL_ORDER')throw err('CONFIRM_REQUIRED','실계좌 수동 주문 확인 문구가 필요합니다');
 if(!client||client.mode!=='LIVE')throw err('LIVE_ACCOUNT_UNAVAILABLE','실계좌 BingX 클라이언트가 연결되어 있지 않습니다',409);
 if(safety?.blocked)throw err('DAILY_LOSS_CIRCUIT_BREAKER',safety.reason||'일일 손실 차단 발동으로 오늘 신규 수동 진입이 중단되었습니다',409);
 const normSym=normalizeManualSymbol(symbol);
 if(!normSym)throw err('INVALID_SYMBOL','종목명을 입력하세요');
 const mode=await readPositionMode(client);
 if(!mode.ok)throw err(mode.reason||'POSITION_MODE_UNKNOWN','포지션 모드(단방향/헤지)를 확인하지 못했습니다',502);
 const hedge=mode.hedge===true;

 const map=await contractsFor(normSym);
 const contract=resolveCopyContract(map,normSym);
 if(!contract)throw err('NO_BINGX_CONTRACT',`BingX 무기한 선물에서 ${displaySymbol(normSym)} 종목을 찾지 못했습니다`,404);

 const [balData,markPrice,levRaw]=await Promise.all([
  client.balance(),
  Promise.resolve(markOf(contract.venueSymbol)).catch(()=>null),
  client.leverage?client.leverage(contract.venueSymbol).catch(()=>null):null,
 ]);
 const usdt=bingxBalanceRows(balData).find(r=>r?.asset==='USDT');
 const funds=balanceOf(usdt);
 const availableUSD=funds?.available??null;
 const equityUSD=funds?.equity??availableUSD;
 const levInfo=parseLeverageInfo(levRaw);
 const sideMaxLev=String(side||'').toUpperCase()==='SHORT'
  ?(levInfo.maxLeverage.short??levInfo.maxLeverage.long)
  :(levInfo.maxLeverage.long??levInfo.maxLeverage.short);
 const safeMaxLev=pos(safety?.maxLeverage);
 const effectiveMaxLev=safeMaxLev?Math.min(sideMaxLev??125,safeMaxLev):(sideMaxLev??125);
 const safeMaxMarginUSD=pos(safety?.maxMarginUSD)??(pos(safety?.maxMarginPct)&&pos(equityUSD)?+(equityUSD*safety.maxMarginPct/100).toFixed(2):null);

 const plan=planRealManualOrder({
  side,orderType,amountMode,amount,price,leverage,marginMode,tpPrice,slPrice,makerFirst,postOnly,
  contract,markPrice,availableUSD,maxLeverage:effectiveMaxLev,maxMarginUSD:safeMaxMarginUSD,
 });

 // Copy lane guard (audit C-5, 2026-11-23): where the copy holds an open position on this symbol (one-way: any side;
 // hedge: the same side for leverage, any side for the symbol-wide margin mode) the manual panel never changes the
 // leverage or the margin mode under it. The order itself is refused rather than sent at other settings.
 const lane=copyLaneOf({copyPositions,contract,side:plan.side,hedge});
 const curLev=plan.side==='SHORT'?(levInfo.currentLeverage.short??levInfo.currentLeverage.long):(levInfo.currentLeverage.long??levInfo.currentLeverage.short);
 let keepLeverage=false,keepMargin=false;
 if(lane.symbol.length){
  const copyLev=lane.side[0]?.leverage??null;
  if(lane.side.length){
   const ref=pos(curLev)??pos(copyLev);
   if(!ref||Math.round(ref)!==Math.round(plan.leverage))throw err('COPY_LANE_LEVERAGE',`카피가 ${plan.displaySymbol} ${plan.side==='LONG'?'롱':'숏'} 포지션을 보유 중이라 레버리지를 바꿀 수 없습니다 (현재 ${ref?Math.round(ref)+'배':'확인 불가'}, 요청 ${plan.leverage}배). 같은 레버리지로 주문하거나 카피 청산 후 다시 시도하세요`,409);
   keepLeverage=true;
  }
  if(plan.marginMode!=='CROSSED')throw err('COPY_LANE_MARGIN_MODE',`카피가 ${plan.displaySymbol} 포지션을 보유 중이라 마진 모드를 ${plan.marginMode==='ISOLATED'?'격리':plan.marginMode}로 바꿀 수 없습니다 (카피는 교차)`,409);
  keepMargin=true;
 }
 // Switch margin mode only when needed (BingX returns 80001 if already set to the same mode).
 if(!keepMargin&&typeof client.setMarginType==='function'){
  let curMargin=null;
  if(typeof client.marginType==='function'){
   try{const cur=await client.marginType(plan.venueSymbol);curMargin=String(cur?.marginType||'').toUpperCase()||null}catch{}
  }
  if(curMargin!==plan.marginMode){
   try{await client.setMarginType(plan.venueSymbol,plan.marginMode)}
   catch(e){
    const msg=String(e?.message||'');
    if(!/no need to change|already|same/i.test(msg)&&e?.code!=='VENUE_ERROR_80001')throw err(e?.code||'MARGIN_TYPE_FAILED',`마진 모드(${plan.marginMode}) 변경 실패: ${msg||e?.code}`,502);
   }
  }
 }

 if(!keepLeverage)await client.setLeverage(plan.venueSymbol,leverageSideFor({hedge,direction:plan.side}),plan.leverage);

 const cid=('man'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)).slice(0,32);
 const extraTpSl={
  ...(plan.tpPrice!=null?{takeProfit:JSON.stringify({type:'TAKE_PROFIT_MARKET',stopPrice:plan.tpPrice,workingType:'MARK_PRICE'})}:{}),
  ...(plan.slPrice!=null?{stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:plan.slPrice,workingType:'MARK_PRICE'})}:{}),
 };
 let orderId=null,executionMode=plan.orderType==='LIMIT'?(plan.postOnly?'POST_ONLY':'LIMIT'):'MARKET';
 if(plan.orderType==='MARKET'&&plan.makerFirst){
  const r=await placeMakerThenMarket({
   client,
   symbol:plan.venueSymbol,
   side:plan.orderSide,
   positionSide:positionSideFor({hedge,direction:plan.side}),
   quantity:plan.qty,
   quantityStep:contract.quantityStep,
   minQuantity:contract.minQuantityBase,
   tickSize:contract.tickSize,
   markPrice:plan.execPrice,
   hedge,
   clientOrderId:cid,
   extraParams:extraTpSl,
   waitMs:makerWaitMs,
   ...(typeof sleep==='function'?{sleep}:{}),
  });
  orderId=r.orderId;
  executionMode=r.executionMode;
 }else{
  const params=forMode({
   symbol:plan.venueSymbol,
   side:plan.orderSide,
   positionSide:positionSideFor({hedge,direction:plan.side}),
   type:plan.orderType,
   quantity:String(plan.qty),
   ...(plan.orderType==='LIMIT'?{price:String(plan.limitPrice),timeInForce:plan.postOnly?'PostOnly':'GTC'}:{}),
   ...extraTpSl,
   clientOrderId:cid,
  },hedge);
  const res=await client.placeOrder(params);
  const order=res?.order??res;
  orderId=order?.orderId!=null?String(order.orderId):null;
 }
 const sideKo=plan.side==='LONG'?'롱':'숏';
 const typeKo=plan.orderType==='LIMIT'
  ?`${plan.postOnly?'지정가(Post-Only)':'지정가'} ${plan.limitPrice}`
  :executionMode==='MAKER'?'메이커 지정가 체결'
   :executionMode==='HYBRID'?'메이커+시장가 체결'
    :plan.makerFirst?'시장가 폴백':'시장가';
 return {
  ok:true,
  orderId,
  clientOrderId:cid,
  executionMode,
  plan,
  summary:`${plan.displaySymbol} ${sideKo} ${typeKo} · 수량 ${plan.qty} (약 $${plan.marginUSD} · ${plan.leverage}배 ${plan.marginMode==='ISOLATED'?'격리':'교차'})${plan.tpPrice?` · TP ${plan.tpPrice}`:''}${plan.slPrice?` · SL ${plan.slPrice}`:''}`,
 };
}

/** List current BingX open orders (limit / TP / SL). */
export async function listRealOpenOrders({client,symbol=null}={}){
 if(!client||client.mode!=='LIVE')throw err('LIVE_ACCOUNT_UNAVAILABLE','실계좌 BingX 클라이언트가 연결되어 있지 않습니다',409);
 const data=await client.openOrders(symbol||undefined);
 const raw=Array.isArray(data)?data:Array.isArray(data?.orders)?data.orders:[];
 return raw.map(o=>{
  const vs=String(o?.symbol||'');
  const norm=vs.replace(/[-_]/g,'').toUpperCase();
  return {
   orderId:o?.orderId!=null?String(o.orderId):'',
   symbol:norm,
   displaySymbol:displaySymbol(norm),
   venueSymbol:vs,
   side:String(o?.side||'').toUpperCase(),
   positionSide:String(o?.positionSide||'BOTH').toUpperCase(),
   type:String(o?.type||'').toUpperCase(),
   price:pos(o?.price),
   stopPrice:pos(o?.stopPrice),
   origQty:pos(o?.origQty??o?.quantity),
   executedQty:num(o?.executedQty)??0,
   reduceOnly:o?.reduceOnly===true||String(o?.reduceOnly).toLowerCase()==='true',
   closePosition:o?.closePosition===true||String(o?.closePosition).toLowerCase()==='true',
   clientOrderId:o?.clientOrderId!=null?String(o.clientOrderId).slice(0,64):null,
   workingType:o?.workingType??null,
   time:num(o?.time??o?.updateTime),
  };
 }).filter(o=>o.orderId&&o.venueSymbol).sort((a,b)=>(b.time||0)-(a.time||0));
}

/** Cancel a single BingX open order. */
export async function cancelRealOpenOrder({confirm,symbol,orderId,client,contractsFor}={}){
 if(confirm!=='REAL_MANUAL_CANCEL')throw err('CONFIRM_REQUIRED','주문 취소 확인 문구가 필요합니다');
 if(!client||client.mode!=='LIVE')throw err('LIVE_ACCOUNT_UNAVAILABLE','실계좌 BingX 클라이언트가 연결되어 있지 않습니다',409);
 const id=String(orderId||'').trim();
 if(!id)throw err('ORDER_ID_REQUIRED','취소할 주문 ID가 필요합니다');
 let vs=String(symbol||'').trim().toUpperCase();
 if(!vs)throw err('SYMBOL_REQUIRED','종목명이 필요합니다');
 if(!vs.includes('-')){
  const norm=normalizeManualSymbol(vs);
  const map=contractsFor?await contractsFor(norm).catch(()=>null):null;
  const c=map?resolveCopyContract(map,norm):null;
  vs=c?.venueSymbol||norm.replace(/USDT$/,'-USDT');
 }
 await client.cancelOrder(vs,id);
 return {ok:true,orderId:id,venueSymbol:vs,summary:`${displaySymbol(vs.replace(/[-_]/g,''))} 주문 취소 완료 (#${id.slice(-6)})`};
}

export const REAL_PANIC_CONFIRM_TOKEN='PANIC_FLAT_ALL';

/** Backend-only emergency panic flat for the BingX real account:
 *  1) Disarms all live automation first (copy, live scalp, signal) so no new order can race
 *  2) Cancels all open exchange orders (limit / TP / SL)
 *  3) Market-closes every open position (hedge-aware, reduceOnly)
 *  4) Re-reads positions to confirm flat state and optionally notifies via Telegram. */
export async function executeRealPanicFlat({confirm,client,onDisarmAll=()=>{},sendText=null,log=()=>{}}={}){
 if(confirm!==REAL_PANIC_CONFIRM_TOKEN)throw err('CONFIRM_REQUIRED','비상 전량 청산 확인 문구(PANIC_FLAT_ALL)가 필요합니다');
 if(!client||client.mode!=='LIVE')throw err('LIVE_ACCOUNT_UNAVAILABLE','실계좌 BingX 클라이언트가 연결되어 있지 않습니다',409);

 // Step 1: disarm all live automation immediately before touching orders/positions.
 let disarmed=false;
 try{await onDisarmAll();disarmed=true}catch(e){log('[PANIC] disarm error',e?.message||e)}

 // Step 2: cancel every open order on the exchange.
 const cancelledOrders=[],cancelErrors=[];
 try{
  const openOrders=await listRealOpenOrders({client});
  for(const o of openOrders){
   try{
    await client.cancelOrder(o.venueSymbol,o.orderId);
    cancelledOrders.push({symbol:o.displaySymbol,venueSymbol:o.venueSymbol,orderId:o.orderId,type:o.type});
   }catch(e){
    cancelErrors.push({symbol:o.displaySymbol,venueSymbol:o.venueSymbol,orderId:o.orderId,error:e?.code||e?.message||'CANCEL_FAILED'});
   }
  }
 }catch(e){
  cancelErrors.push({symbol:'ALL',error:e?.code||e?.message||'OPEN_ORDERS_FAILED'});
 }

 // Step 3: read position mode & all open positions, then market-close every non-zero position.
 const closedPositions=[],closeErrors=[];
 let hedge=false;
 try{
  const mode=await readPositionMode(client);
  if(mode?.ok)hedge=mode.hedge===true;
 }catch{}
 try{
  const rawPos=venueRows(await client.positions())||[];
  const openPos=rawPos.map(r=>normalizeVenuePosition(r)).filter(p=>p&&p.size>0&&p.direction);
  for(const p of openPos){
   const closeSide=p.direction==='LONG'?'SELL':'BUY';
   const useHedge=hedge||p.positionSide==='LONG'||p.positionSide==='SHORT';
   const cid=('pan'+Date.now().toString(36)+Math.random().toString(36).slice(2,5)).slice(0,32);
   const params=forMode({
    symbol:p.venueSymbol,
    side:closeSide,
    positionSide:positionSideFor({hedge:useHedge,direction:p.direction}),
    type:'MARKET',
    quantity:String(p.size),
    reduceOnly:'true',
    clientOrderId:cid,
   },useHedge);
   try{
    const res=await client.placeOrder(params);
    const o=res?.order??res;
    closedPositions.push({symbol:displaySymbol(p.symbol),venueSymbol:p.venueSymbol,direction:p.direction,size:p.size,orderId:o?.orderId!=null?String(o.orderId):null});
   }catch(e){
    closeErrors.push({symbol:displaySymbol(p.symbol),venueSymbol:p.venueSymbol,direction:p.direction,size:p.size,error:e?.code||e?.message||'CLOSE_FAILED'});
   }
  }
 }catch(e){
  closeErrors.push({symbol:'ALL',error:e?.code||e?.message||'POSITIONS_READ_FAILED'});
 }

 // Step 4: verify remaining positions on the venue.
 let remainingCount=null;
 try{
  const after=venueRows(await client.positions())||[];
  remainingCount=after.map(r=>normalizeVenuePosition(r)).filter(p=>p&&p.size>0).length;
 }catch{}

 const ok=closeErrors.length===0&&cancelErrors.length===0&&(remainingCount===null||remainingCount===0);
 const summary=`🚨 실계좌 비상 전량 청산 ${ok?'완료':'부분 완료'}\n· 자동매매 전체 중지: ${disarmed?'완료':'오류'}\n· 미체결 주문 취소: ${cancelledOrders.length}건${cancelErrors.length?` (실패 ${cancelErrors.length}건)`:''}\n· 포지션 시장가 청산: ${closedPositions.length}건${closeErrors.length?` (실패 ${closeErrors.length}건)`:''}\n· 잔여 포지션: ${remainingCount===null?'확인 실패':`${remainingCount}개`}`;
 if(typeof sendText==='function'){try{await sendText(summary)}catch{}}
 return {ok,disarmed,cancelledOrders,cancelErrors,closedPositions,closeErrors,remainingCount,summary};
}

