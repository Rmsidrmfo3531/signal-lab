// Reproducible synthetic strategy replay input, never recorded OrangeX data.
import {marketSeries,ENTRY} from './pipeline_market.mjs';
import {syntheticBinanceContext} from './binance_signal.mjs';
import {syntheticContract,syntheticSettings} from './orangex_paper_scenario.mjs';

export const REPLAY_NOW=Date.parse('2026-10-28T01:00:00Z');
export function syntheticReplayBook(at,bid=102.19,ask=102.21,patch={}){
 return {receivedAt:at,instrumentName:'BTC-USDT-PERPETUAL',dataSource:'SYNTHETIC_FIXTURE',
  bids:[[bid,1000]],asks:[[ask,1000]],timestamp:at,markPrice:(bid+ask)/2,markPriceAt:at,...patch};
}
export function syntheticReplayInput({scenario='breakout-long',now=REPLAY_NOW,complete=false}={}){
 const series=marketSeries(scenario,now),at=now-1000;
 const input={kind:'ORANGEX_PAPER_REPLAY',executionMode:'SYNTHETIC_TEST',dataSource:'SYNTHETIC_FIXTURE',strategyVersion:'LEGACY_V58',
  symbol:'BTCUSDT',instrumentName:'BTC-USDT-PERPETUAL',h1:series.h1,h4:series.h4,metadata:[{at,quoteVolume:1e8}],
  venueSnapshots:[{at,...syntheticBinanceContext('BTCUSDT',ENTRY,at)}],
  markets:[syntheticReplayBook(at),syntheticReplayBook(at+1)],settings:structuredClone(syntheticSettings),
  contracts:[structuredClone(syntheticContract)],startAt:at,endAt:at+1};
 if(complete){
  input.markets.push(...(scenario.endsWith('short')?[syntheticReplayBook(at+4,105,105.01)]:
   [syntheticReplayBook(at+2,107,107.01),syntheticReplayBook(at+3,110,110.01),syntheticReplayBook(at+4,112,112.01)]));
  input.endAt=at+4;
 }
 return input;
}
