// Observations only: a similarly named contract is never approved as equivalent.
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const fresh=(at,now)=>positive(at)&&at>=1e12&&at<=now+5000&&now-at<=90000;

export function compareOrangeXBinance(market,quote,{now=Date.now()}={}){
 const match=typeof market?.instrumentName==='string'?market.instrumentName.match(/^(BTC|ETH|SOL)-USDT-PERPETUAL$/):null;
 const referenceSymbol=match?match[1]+'USDT':null;
 const price=quote?.symbol===referenceSymbol&&positive(quote?.price)?quote.price:null;
 const priceAt=positive(quote?.exchangePriceAt)?quote.exchangePriceAt:null;
 const orangeXPriceAt=positive(market?.priceAt)?market.priceAt:null;
 const book=positive(market?.bid)&&positive(market?.ask)&&market.bid<market.ask;
 const available=referenceSymbol!==null&&price!==null&&book&&fresh(priceAt,now)&&fresh(orangeXPriceAt,now);
 const mid=book?(market.bid+market.ask)/2:null;
 const gapBps=available?(mid-price)/price*10000:null;
 return {status:!referenceSymbol?'UNVERIFIED_MAPPING':available?'OBSERVATION_ONLY':'STALE_DATA',
  referenceSymbol,price,priceAt,orangeXPriceAt,gapBps,absoluteGapBps:gapBps===null?null:Math.abs(gapBps),
  mappingVerified:false,orderSubmissionEnabled:false};
}
