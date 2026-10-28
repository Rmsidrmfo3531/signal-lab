// Independent accounting checks and descriptive statistics. This module never
// changes a ledger, approves a strategy, fetches data or submits an order.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<=8640000000000000-9*3600000;
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-9,Math.abs(b)*1e-9);
const rounded=value=>finite(value)?Math.round(value*1e8)/1e8:null;
const sum=(rows,key)=>rows.reduce((total,row)=>total+row[key],0);
const MODES=new Set(['SYNTHETIC_TEST','HISTORICAL_REPLAY','LIVE_MARKET_PAPER']);
const RUNS=new Set(['BACKTEST','FORWARD_PAPER']);
const NAME=/^([A-Z0-9]{2,20})-([A-Z0-9]{2,12})-PERPETUAL$/;
const TZ=9*3600000;
const daily=at=>new Date(at+TZ).toISOString().slice(0,10);
const monthly=at=>daily(at).slice(0,7);
function weekly(at){
 const shifted=new Date(daily(at)+'T00:00:00Z');
 shifted.setUTCDate(shifted.getUTCDate()+4-(shifted.getUTCDay()||7));
 const year=shifted.getUTCFullYear(),start=Date.UTC(year,0,1),week=Math.ceil(((shifted-start)/86400000+1)/7);
 return `${year}-W${String(week).padStart(2,'0')}`;
}
function context(state){
 return {executionMode:state?.executionMode??'SYNTHETIC_TEST',runKind:state?.runKind??'FORWARD_PAPER'};
}
const RATE=rate=>finite(rate)&&rate>=0&&rate<=.1;
function independentTrade(position,{now,closed,executionMode,runKind}){
 const issues=[],flows=[],key=typeof position?.key==='string'&&position.key.length<=240?position.key:null;
 const issue=(code,field)=>issues.push({key,code,field});
 if(!plain(position))return {key,valid:false,complete:false,slippageComplete:false,issues:[{key,code:'TRADE_STRUCTURE_INVALID',field:'trade'}],flows:[]};
 const c=position.contract,dir=position.direction==='LONG'?1:position.direction==='SHORT'?-1:0,
  match=typeof position.instrumentName==='string'?NAME.exec(position.instrumentName):null;
 if(!dir||!match||!key)issue('TRADE_IDENTITY_INVALID','trade');
 if(match&&position.symbol!==match[1]+match[2]||plain(c)&&(c.instrumentName!==position.instrumentName||c.symbol!==position.symbol))
  issue('CONTRACT_MAPPING_MISMATCH','contract');
 if(position.dataSource!=='SYNTHETIC_FIXTURE'||position.executionMode!==undefined&&position.executionMode!==executionMode||
  position.runKind!==undefined&&position.runKind!==runKind)issue('MIXED_EXECUTION_CONTEXT','context');
 if(executionMode!=='SYNTHETIC_TEST')issue('EXECUTION_MODE_FILL_FORBIDDEN','context');
 if(!plain(c)||!positive(c.contractSizeBase)||c.quantityUnit!=='CONTRACT'||c.source!=='SYNTHETIC_FIXTURE'||
  c.unitsVerifiedForSimulation!==true)issue('CONTRACT_UNITS_UNVERIFIED','contract');
 if(!plain(c)||c.feeUnit!=='FRACTION'||!RATE(c.makerRate)||!RATE(c.takerRate))issue('FEES_UNVERIFIED','contract');
 if(!plain(c)||!positive(c.fundingIntervalMs)||!Number.isSafeInteger(c.fundingIntervalMs)||!finite(c.fundingRate)||
  Math.abs(c.fundingRate)>.1)issue('FUNDING_SCHEDULE_UNVERIFIED','contract');
 const entries=Array.isArray(position.entryParts)?position.entryParts:[],exits=Array.isArray(position.exitParts)?position.exitParts:[],
  funding=Array.isArray(position.fundingParts)?position.fundingParts:[];
 if(!entries.length||!Array.isArray(position.exitParts)||!Array.isArray(position.fundingParts))issue('PARTS_UNOBSERVED','parts');
 const validFill=(part,index,kind)=>{
  if(!plain(part)||!positive(part.quantity)||!positive(part.price)||!finite(part.feeUSD)||part.feeUSD<0||!stamp(part.at)||
   !stamp(position.openedAt)||part.at<position.openedAt||part.at>now||closed&&(!stamp(position.closedAt)||part.at>position.closedAt)){
   issue('FILL_PART_INVALID',`${kind}.${index}`);return false;
  }
  if(kind==='exit'&&!['TP1','TP2','TP3','STOP','CLOSE','TIME_LIMIT'].includes(part.type))issue('EXIT_TYPE_INVALID',`exit.${index}.type`);
  if(![undefined,'TAKER','MAKER'].includes(part.liquidity))issue('FEE_LIQUIDITY_UNVERIFIED',`${kind}.${index}.liquidity`);
  return true;
 };
 const entriesValid=entries.map((p,i)=>validFill(p,i,'entry')).every(Boolean),
  exitsValid=exits.map((p,i)=>validFill(p,i,'exit')).every(Boolean);
 if(!entriesValid||!exitsValid||issues.some(row=>['CONTRACT_UNITS_UNVERIFIED','FEES_UNVERIFIED','PARTS_UNOBSERVED'].includes(row.code)))
  return {key,valid:false,complete:false,slippageComplete:false,issues,flows:[],direction:position.direction,asset:match?.[1]??null};
 const factor=c.contractSizeBase,entered=sum(entries,'quantity'),exited=sum(exits,'quantity'),
  entryPrice=entries.reduce((value,p)=>value+p.price*p.quantity,0)/entered;
 if(!near(position.entryPrice,entryPrice)||!near(position.quantityOriginal,entered)||!near(position.quantityRemaining,entered-exited)||
  position.quantityRemaining<0||closed&&(!stamp(position.closedAt)||position.closedAt>now||position.quantityRemaining!==0))issue('QUANTITY_OR_ENTRY_MISMATCH','position');
 const quantityFlows=[...entries.map(p=>({at:p.at,quantity:p.quantity,priority:0})),
  ...exits.map(p=>({at:p.at,quantity:-p.quantity,priority:1}))].sort((a,b)=>a.at-b.at||a.priority-b.priority);
 let available=0;for(const flow of quantityFlows){available+=flow.quantity;if(available<-1e-8)issue('EXIT_BEFORE_ENTRY','parts')}
 let fees=0,gross=0,slippage=0,spread=0,slippageComplete=true,entrySlippage=0,exitSlippage=0,entrySpread=0,exitSpread=0;
 for(const [kind,parts]of [['entry',entries],['exit',exits]])for(const [index,part]of parts.entries()){
  const rate=part.liquidity==='MAKER'?c.makerRate:c.takerRate,fee=part.quantity*part.price*factor*rate;
  if(!near(part.feeUSD,fee))issue('FEE_MISMATCH',`${kind}.${index}.feeUSD`);fees+=fee;
  if(kind==='entry')flows.push({at:part.at,amount:-fee,type:'ENTRY_FEE'});
  else{
   const gain=part.quantity*factor*dir*(part.price-entryPrice);gross+=gain;
   if(!near(part.grossUSD,gain))issue('GROSS_MISMATCH',`exit.${index}.grossUSD`);
   flows.push({at:part.at,amount:gain-fee,type:'EXIT'});
  }
  if(!positive(part.referencePrice)||!positive(part.marketMidPrice)){slippageComplete=false;continue}
  const orderSign=kind==='entry'?dir:-dir,
   adverse=orderSign*(part.price-part.referencePrice)*part.quantity*factor,
   spreadCost=orderSign*(part.referencePrice-part.marketMidPrice)*part.quantity*factor;
  if(orderSign*(part.price-part.referencePrice)<-1e-8||orderSign*(part.referencePrice-part.marketMidPrice)<-1e-8)
   issue('EXECUTION_REFERENCE_INVALID',`${kind}.${index}.referencePrice`);
  if(Object.hasOwn(part,'slippageUSD')&&!near(part.slippageUSD,adverse))issue('SLIPPAGE_MISMATCH',`${kind}.${index}.slippageUSD`);
  if(Object.hasOwn(part,'spreadCostUSD')&&!near(part.spreadCostUSD,spreadCost))issue('SPREAD_MISMATCH',`${kind}.${index}.spreadCostUSD`);
  slippage+=adverse;spread+=spreadCost;
  if(kind==='entry'){entrySlippage+=adverse;entrySpread+=spreadCost}else{exitSlippage+=adverse;exitSpread+=spreadCost}
 }
 let fundingUSD=0;const observed=new Set(),ids=new Set();
 for(const [index,part]of funding.entries()){
  if(!plain(part)||!stamp(part.at)||part.at<=position.openedAt||part.at>now||closed&&part.at>position.closedAt||
   !finite(part.rate)||Math.abs(part.rate)>.1||!positive(part.markPrice)||!finite(part.quantity)||part.quantity<0||
   !finite(part.amountUSD)||!Number.isSafeInteger(c.fundingIntervalMs)||part.at%c.fundingIntervalMs!==0||
   typeof part.id!=='string'||observed.has(part.at)||ids.has(part.id)){
   issue('FUNDING_PART_INVALID',`funding.${index}`);continue;
  }
  const quantity=entries.filter(p=>p.at<part.at).reduce((n,p)=>n+p.quantity,0)-exits.filter(p=>p.at<part.at).reduce((n,p)=>n+p.quantity,0),
   amount=Math.max(0,quantity)*factor*part.markPrice*part.rate*dir;
  if(!near(part.quantity,Math.max(0,quantity))||!near(part.amountUSD,amount))issue('FUNDING_MISMATCH',`funding.${index}`);
  observed.add(part.at);ids.add(part.id);fundingUSD+=amount;flows.push({at:part.at,amount:-amount,type:'FUNDING'});
 }
 const end=closed?position.closedAt:now,expected=stamp(end)&&stamp(position.openedAt)&&Number.isSafeInteger(c.fundingIntervalMs)?
  Math.floor(end/c.fundingIntervalMs)-Math.floor(position.openedAt/c.fundingIntervalMs):null;
 const fundingComplete=Number.isSafeInteger(expected)&&expected>=0&&observed.size===expected;
 if(!fundingComplete)issue('FUNDING_EVENTS_MISSING','fundingParts');
 const net=gross-fees-fundingUSD;
 for(const [field,value]of Object.entries({feesUSD:fees,realizedGrossUSD:gross,fundingUSD,realizedPnLUSD:net}))
  if(!near(position[field],value))issue('LEDGER_TOTAL_MISMATCH',field);
 const valid=issues.every(row=>row.code==='FUNDING_EVENTS_MISSING'),complete=valid&&fundingComplete,
  plannedRisk=positive(position.plannedRiskUSD)?position.plannedRiskUSD:null,
  targetRisk=positive(position.stop)&&dir*(entryPrice-position.stop)>0?Math.abs(entryPrice-position.stop):null,
  targets=Array.isArray(position.targets)&&position.targets.length===3&&position.targets.every(positive)?position.targets:null;
 const plannedRR=targetRisk&&targets?targets.reduce((total,target,index)=>total+[.4,.35,.25][index]*dir*(target-entryPrice)/targetRisk,0):null;
 return {key,valid,complete,slippageComplete,issues,flows,direction:position.direction,asset:match?.[1]??null,closed,
  openedAt:position.openedAt,closedAt:closed?position.closedAt:null,holdingMs:closed?position.closedAt-position.openedAt:null,
  quantityOriginal:entered,quantityExited:exited,plannedRiskUSD:plannedRisk,plannedRR,
  grossPnLUSD:gross,feesUSD:fees,fundingUSD:fundingComplete?fundingUSD:null,accountedFundingUSD:fundingUSD,
  netPnLUSD:complete?net:null,accountedNetPnLUSD:net,realizedR:complete&&plannedRisk?net/plannedRisk:null,
  slippageUSD:slippageComplete?slippage:null,spreadCostUSD:slippageComplete?spread:null,
  // Entry execution costs are allocated only to the exited fraction for an open
  // position. Closed trades allocate all entry costs exactly once.
  frictionlessPnLUSD:slippageComplete?gross+entrySlippage*(exited/entered)+exitSlippage+entrySpread*(exited/entered)+exitSpread:null};
}

export function auditOrangeXPaperAccounting(state={}, {now=Date.now()}={}){
 const ctx=context(state),issues=[],trades=[];
 if(!plain(state)||!stamp(now)||!Array.isArray(state.open)||!Array.isArray(state.closed)||!MODES.has(ctx.executionMode)||!RUNS.has(ctx.runKind))
  return {valid:false,complete:false,slippageComplete:false,issues:[{key:null,code:'STATE_OR_CONTEXT_INVALID',field:'state'}],totals:null,trades:[],...ctx};
 const seen=new Set();
 for(const [closed,rows]of [[false,state.open],[true,state.closed]])for(const p of rows){
  const row=independentTrade(p,{now,closed,...ctx});
  row.closed=closed;
  if(row.key&&seen.has(row.key)){row.valid=false;row.complete=false;row.issues.push({key:row.key,code:'DUPLICATE_TRADE_KEY',field:'key'})}
  if(row.key)seen.add(row.key);trades.push(row);issues.push(...row.issues);
 }
 const valid=trades.every(row=>row.valid),complete=valid&&trades.every(row=>row.complete),
  slippageComplete=valid&&trades.every(row=>row.slippageComplete);
 const totals=valid?{grossPnLUSD:rounded(sum(trades,'grossPnLUSD')),feesUSD:rounded(sum(trades,'feesUSD')),
  fundingUSD:complete?rounded(sum(trades,'fundingUSD')):null,netPnLUSD:complete?rounded(sum(trades,'netPnLUSD')):null,
  accountedFundingUSD:rounded(sum(trades,'accountedFundingUSD')),accountedNetPnLUSD:rounded(sum(trades,'accountedNetPnLUSD')),
  slippageUSD:slippageComplete?rounded(sum(trades,'slippageUSD')):null,spreadCostUSD:slippageComplete?rounded(sum(trades,'spreadCostUSD')):null,
  frictionlessPnLUSD:slippageComplete?rounded(sum(trades,'frictionlessPnLUSD')):null}:null;
 return {valid,complete,slippageComplete,issues,totals,trades,...ctx};
}

function drawdown(flows,capital){
 let running=positive(capital)?capital:0,peak=running,maximum=0,maximumPct=positive(capital)?0:null;
 const grouped=new Map();for(const row of flows)grouped.set(row.at,(grouped.get(row.at)??0)+row.amount);
 for(const [,amount]of [...grouped].sort((a,b)=>a[0]-b[0])){
  running+=amount;peak=Math.max(peak,running);const loss=peak-running;maximum=Math.max(maximum,loss);
  if(positive(peak)&&positive(capital))maximumPct=Math.max(maximumPct,loss/peak*100);
 }
 return {maxDrawdownUSD:rounded(maximum),maxDrawdownPct:maximumPct===null?null:rounded(maximumPct)};
}
function metrics(rows,{capital,ledgerRows=rows,validOverride=true}={}){
 // The ledger's append order resolves equal-millisecond closes. Reordering
 // identities alphabetically would invent a different loss streak.
 const done=rows.filter(row=>row.closed).sort((a,b)=>a.closedAt-b.closedAt),
  valid=validOverride&&rows.every(row=>row.valid),complete=valid&&rows.every(row=>row.complete),
  ledgerComplete=validOverride&&ledgerRows.every(row=>row.valid&&row.complete),slippageComplete=valid&&done.every(row=>row.slippageComplete);
 const nets=complete?done.map(row=>row.netPnLUSD):[],wins=nets.filter(n=>n>0),losses=nets.filter(n=>n<0),
  gross=valid?sum(done,'grossPnLUSD'):null,fees=valid?sum(done,'feesUSD'):null,
  funding=complete?sum(done,'fundingUSD'):null,net=complete?sum(done,'netPnLUSD'):null;
 let streak=0,maxStreak=0;
 if(complete)for(const value of nets){streak=value<0?streak+1:0;maxStreak=Math.max(maxStreak,streak)}
 const average=(key)=>done.length&&done.every(row=>finite(row[key]))?sum(done,key)/done.length:null,
  dd=ledgerComplete?drawdown(ledgerRows.flatMap(row=>row.flows),capital):{maxDrawdownUSD:null,maxDrawdownPct:null};
 return {totalTrades:done.length,winningTrades:complete?wins.length:null,losingTrades:complete?losses.length:null,
  winRatePct:done.length&&complete?rounded(wins.length/done.length*100):null,
  averagePlannedRR:valid?rounded(average('plannedRR')):null,averageRealizedR:complete?rounded(average('realizedR')):null,
  averageWinLossRatio:complete&&wins.length&&losses.length?rounded((wins.reduce((n,x)=>n+x,0)/wins.length)/
   (-losses.reduce((n,x)=>n+x,0)/losses.length)):null,
  profitFactor:complete&&losses.length?rounded(wins.reduce((n,x)=>n+x,0)/-losses.reduce((n,x)=>n+x,0)):null,
  profitFactorStatus:!complete?'UNVERIFIED':!done.length?'NO_TRADES':!losses.length?'NO_LOSSES':'CALCULATED',
  ...dd,averageHoldingMs:valid?rounded(average('holdingMs')):null,expectancyUSD:complete&&done.length?rounded(net/done.length):null,
  currentLossStreak:complete?streak:null,maxLossStreak:complete?maxStreak:null,
  grossPnLUSD:rounded(gross),netPnLUSD:rounded(net),feesUSD:rounded(fees),fundingUSD:rounded(funding),
  afterFeesPnLUSD:valid?rounded(gross-fees):null,afterFeesAndFundingPnLUSD:rounded(net),
  slippageUSD:slippageComplete?rounded(sum(done,'slippageUSD')):null,
  spreadCostUSD:slippageComplete?rounded(sum(done,'spreadCostUSD')):null,
  frictionlessPnLUSD:slippageComplete?rounded(sum(done,'frictionlessPnLUSD')):null,
  complete,auditValid:valid,slippageComplete};
}
function periods(rows,format,complete){
 const bins=new Map(),ensure=key=>{if(!bins.has(key))bins.set(key,{period:key,pnlUSD:0,netPnLUSD:0,tradeCount:0});return bins.get(key)};
 for(const row of rows){
  if(row.closed&&stamp(row.closedAt))ensure(format(row.closedAt)).tradeCount++;
  for(const flow of row.flows??[])if(stamp(flow.at)&&finite(flow.amount))ensure(format(flow.at)).pnlUSD+=flow.amount;
 }
 return [...bins.values()].sort((a,b)=>a.period.localeCompare(b.period)).map(row=>({...row,
  pnlUSD:complete?rounded(row.pnlUSD):null,netPnLUSD:complete?rounded(row.pnlUSD):null}));
}

export function analyzeOrangeXPaperPerformance(state={}, {now=Date.now(),minSampleSize=30}={}){
 const audit=auditOrangeXPaperAccounting(state,{now}),ctx=context(state),capital=state?.settings?.capitalUSD,
  threshold=Number.isSafeInteger(minSampleSize)&&minSampleSize>0?minSampleSize:30,closed=audit.trades.filter(row=>row.closed),
  sufficient=closed.length>=threshold&&audit.valid&&audit.complete,reasons=[];
 if(closed.length<threshold)reasons.push('INSUFFICIENT_SAMPLE');
 if(!audit.valid)reasons.push('ACCOUNTING_AUDIT_FAILED');
 if(!audit.complete)reasons.push('COST_OR_FUNDING_UNVERIFIED');
 if(!audit.slippageComplete)reasons.push('SLIPPAGE_UNVERIFIED');
 if(ctx.executionMode==='SYNTHETIC_TEST')reasons.push('SYNTHETIC_RESULTS_NOT_MARKET_VALIDATION');
 else reasons.push('EXECUTION_DISABLED_FOR_MODE');
 const directions=Object.fromEntries(['LONG','SHORT'].map(direction=>[direction,metrics(audit.trades.filter(row=>row.direction===direction),{capital,validOverride:audit.valid})])),
  assets=Object.fromEntries(['BTC','ETH','SOL'].map(asset=>[asset,metrics(audit.trades.filter(row=>row.asset===asset),{capital,validOverride:audit.valid})]));
 return {kind:'ORANGEX_PAPER_PERFORMANCE',...ctx,sample:{tradeCount:closed.length,minSampleSize:threshold,sufficient,strategyValidated:false,reasons},
  metrics:metrics(audit.trades,{capital,validOverride:audit.valid}),directions,assets,
  periods:{daily:periods(audit.trades,daily,audit.complete),weekly:periods(audit.trades,weekly,audit.complete),monthly:periods(audit.trades,monthly,audit.complete)},
  audit,definitions:{population:'CLOSED_TRADES',maxDrawdown:'ALL_RECORDED_REALIZED_CASH_FLOWS_INCLUDING_OPEN_PARTIALS',
   unrealizedDrawdownIncluded:false,realizedRDenominator:'PLANNED_RISK_USD_INCLUDING_DECLARED_RISK_COST_RESERVES',
   slippage:'DEPTH_COST_VS_SAME_SIDE_REFERENCE_ALREADY_EMBEDDED_IN_ACTUAL_FILL_PNL',
   frictionlessPnL:'CLOSED_TRADES_MIDPOINT_REFERENCE_GROSS_BEFORE_SPREAD_DEPTH_FEES_AND_FUNDING',periodTimezone:'Asia/Seoul'},
  realMarketPerformanceVerified:false,updatedAt:now};
}
