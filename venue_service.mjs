// On-demand BingX/Gate.io public quote service for the dashboard. Nothing polls in
// the background: a snapshot is built only when /api/venues is requested, with
// short caches so repeated page refreshes stay inside each venue's rate limit.
import {VENUES,compareVenues} from './venue_market_data.mjs';
import {BingXMarketData} from './bingx_market.mjs';
import {GateMarketData} from './gateio_market.mjs';

export const MAX_VENUE_SYMBOLS=6;
const SYMBOL=/^[A-Z0-9]{1,20}USDT$/;

export function parseVenueSymbols(value,fallback=[]){
 const list=(typeof value==='string'&&value.trim()?value.split(','):fallback).map(x=>String(x).trim().toUpperCase()).filter(x=>SYMBOL.test(x));
 return [...new Set(list)].slice(0,MAX_VENUE_SYMBOLS);
}

export class VenueQuoteService{
 constructor({clients,now=Date.now,bookTtlMs=5000}={}){
  this.clients=clients??{BINGX:new BingXMarketData({now}),GATEIO:new GateMarketData({now})};
  Object.assign(this,{now,bookTtlMs});this.books=new Map();this.pending=null;
  this.status=Object.fromEntries(VENUES.map(v=>[v,{state:'idle',contractsAt:0,contractCount:0,lastSuccessAt:0,error:null}]));
 }
 async #venueRow(venue,symbol){
  const client=this.clients[venue],status=this.status[venue];
  let contracts;
  try{contracts=await client.loadContracts();status.contractsAt=client.contractsAt;status.contractCount=contracts.size}
  catch(error){status.state='error';status.error=error.code||'CONTRACTS_UNAVAILABLE';return {contract:null,book:null,error:status.error}}
  const contract=contracts.get(symbol)??null;
  if(!contract)return {contract:null,book:null,error:'NOT_LISTED'};
  const key=venue+':'+symbol,cached=this.books.get(key);
  if(cached&&this.now()-cached.at<this.bookTtlMs)return {contract,book:cached.book,error:null};
  try{
   const book=await client.book(symbol);this.books.set(key,{at:this.now(),book});
   status.state='connected';status.error=null;status.lastSuccessAt=this.now();
   return {contract,book,error:null};
  }catch(error){status.state='error';status.error=error.code||'BOOK_UNAVAILABLE';return {contract,book:null,error:status.error}}
 }
 /** symbols: canonical (BTCUSDT); binancePrice(symbol) supplies the chart reference. */
 async snapshot(symbols,{binancePrice=()=>null}={}){
  if(this.pending)return this.pending;
  this.pending=(async()=>{
   const rows=[];
   for(const symbol of parseVenueSymbols(symbols.join(','))){
    const [bingx,gateio]=await Promise.all([this.#venueRow('BINGX',symbol),this.#venueRow('GATEIO',symbol)]);
    rows.push(compareVenues(symbol,{bingx,gateio,binancePrice:binancePrice(symbol)}));
   }
   return {mode:'PUBLIC_READ_ONLY',ordersEnabled:false,accountAccess:false,apiKeysUsed:false,chartReference:'BINANCE',
    generatedAt:this.now(),venues:structuredClone(this.status),rows,maxSymbols:MAX_VENUE_SYMBOLS};
  })();
  try{return await this.pending}finally{this.pending=null}
 }
}
