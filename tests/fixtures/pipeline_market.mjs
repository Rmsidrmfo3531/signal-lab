// Synthetic, deterministic market data for the offline HTTP/WebSocket integration tests.
// No real exchange response or private account data is used here.
const HOUR=3600000;
export const ENTRY=102.2;
const candle=(time,open,high,low,close,volume=100,quoteVolume=1_000_000,interval=HOUR)=>[
 time,String(open),String(high),String(low),String(close),String(volume),time+interval-1,String(quoteVolume)
];
export function marketSeries(scenario='breakout-long',now=Date.now()){
 const lastAt=now-HOUR-1000;
 const h1=Array.from({length:149},(_,i)=>{
  const v=i<118?90+i*.07:100;
  return candle(lastAt+(i-149)*HOUR,v,v+.35,v-.35,v);
 });
 h1.push(candle(lastAt,100,103,99.9,ENTRY,230,2_300_000));
 const h4=Array.from({length:300},(_,i)=>{
  const v=70+i*.1;
  return candle(now-(300-i)*4*HOUR-1000,v-.1,v+.35,v-.35,v,300,3_000_000,4*HOUR);
 });
 if(scenario==='retest-long'){
  // A distant established resistance is above 2R; the previous wick is not a confirmed pivot.
  h1[60][2]='112';
  h1[h1.length-2]=candle(lastAt-HOUR,100,103,99.9,101.2,130,1_300_000);
  h1[h1.length-1]=candle(lastAt,100.8,102.4,100.4,ENTRY,230,2_300_000);
 }
 if(scenario==='bonus-missing-long'){
  for(const [offset,value] of [[-4,101],[-3,90],[-2,90],[-1,97.5]]){
   const index=h4.length+offset,time=h4[index][0];
   h4[index]=candle(time,value-.1,value+.35,value-.35,value,300,3_000_000,4*HOUR);
  }
 }
 if(scenario==='weak-volume')h1.at(-1)[5]='110';
 if(scenario==='illiquid-hour')h1.at(-1)[7]='499999';
 if(scenario==='range'){
  for(let i=0;i<h1.length;i++)h1[i]=candle(lastAt+(i-h1.length+1)*HOUR,100,100.35,99.65,100);
  for(let i=0;i<h4.length;i++)h4[i]=candle(now-(h4.length-i)*4*HOUR-1000,100,100.35,99.65,100,300,3_000_000,4*HOUR);
 }
 if(scenario==='breakout-short'||scenario==='retest-short'){
  const original=scenario==='retest-short'?marketSeries('retest-long',now):{h1,h4};
  const mirror=rows=>rows.map(row=>candle(row[0],2*ENTRY-Number(row[1]),2*ENTRY-Number(row[3]),2*ENTRY-Number(row[2]),2*ENTRY-Number(row[4]),Number(row[5]),Number(row[7]),Number(row[6])-Number(row[0])+1));
  return {h1:mirror(original.h1),h4:mirror(original.h4)};
 }
 return {h1,h4};
}
