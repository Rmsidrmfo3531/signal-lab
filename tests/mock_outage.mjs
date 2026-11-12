// Offline fixture: a real Binance outage, with no alternative exchange transport.
// Older synthetic fixtures target the base patterns: the study-material trend patterns are tested separately.
process.env.SIGNAL_TREND_GATE??='off';
import './mock_realtime.mjs';
import fs from 'node:fs';
const normal=globalThis.fetch;
globalThis.fetch=async (input,options)=>{
 const url=new URL(String(input));
 if(fs.existsSync(process.env.SIGNAL_LAB_TEST_OUTAGE_FLAG||'')&&url.hostname==='fapi.binance.com')
  return new Response(JSON.stringify({error:'simulated Binance outage'}),{status:503,headers:{'Content-Type':'application/json'}});
 return normal(input,options);
};
