/** Official destination links only. This module never submits an order. */
export function officialBinanceLinks(symbol){
 if(typeof symbol!=='string'||!/^[A-Z0-9]{2,24}USDT$/.test(symbol))return null;
 return {binance:`https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`};
}
export function officialMarketLinks(symbol){return officialBinanceLinks(symbol)}
// Only a matching, already opened PAPER record supplies position information.
// Analyzer risk defaults and planned quantities are not confirmed positions.
export function telegramMessage(signal,officialLinks,{paperPosition}={}){
 const official=officialBinanceLinks(signal?.symbol);
 if(!official||officialLinks?.binance!==official.binance)throw Error('Verified Binance market URL required for Telegram signal');
 if(signal.scoreVersion!=='ISSUE6-100-V1'||signal.status!=='signal'||signal.qualified!==true||
   !['LONG','SHORT'].includes(signal.direction)||!Number.isFinite(signal.score)||signal.score<90||signal.score>100)
  throw Error('Final validation is required');
 const plan=signal.targetPlan,prices=plan?.targets;
 const validPlan=plan?.ok===true&&Array.isArray(prices)&&prices.length===3&&prices.every(p=>Number.isFinite(p)&&p>0)&&
   prices.every((p,i)=>signal.direction==='LONG'?p>(i?prices[i-1]:signal.entry):p<(i?prices[i-1]:signal.entry));
 if(!validPlan)throw Error('Final volume-profile target validation is required');
 const position=paperPosition?.market==='CRYPTO'&&paperPosition.symbol===signal.symbol&&
   paperPosition.direction===signal.direction&&paperPosition.pattern===signal.pattern&&
   Number.isFinite(signal.patternConfirmedAt)&&paperPosition.barAt===signal.patternConfirmedAt&&
   Number.isFinite(paperPosition.openedAt)&&paperPosition.openedAt>0&&
   Number.isFinite(paperPosition.entryFill)&&paperPosition.entryFill>0&&
   paperPosition.targetPlan?.quantityUnit==='BASE_ASSET'&&
   Number.isFinite(paperPosition.originalQty)&&paperPosition.originalQty>0&&
   Number.isFinite(paperPosition.qtyRemaining)&&paperPosition.qtyRemaining>0&&paperPosition.qtyRemaining<=paperPosition.originalQty
   ?paperPosition:null;
 const leverage=position?.leverage;
 const multiple=typeof leverage==='number'&&Number.isFinite(leverage)&&leverage>0
   ? leverage.toLocaleString('ko-KR',{maximumFractionDigits:2})+'배 (모의 기준)' : '미설정';
 const quantity=position
   ? position.qtyRemaining.toLocaleString('en-US',{maximumFractionDigits:12})+' '+signal.symbol.slice(0,-4) : '미확인';
 const text=[
  '종목: '+signal.symbol,
  '방향: '+(signal.direction==='LONG'?'롱 (LONG)':'숏 (SHORT)'),
  '배율: '+multiple,
  '포지션 수량(모의): '+quantity
 ].join('\n');
 return {text,disable_web_page_preview:true};
}
