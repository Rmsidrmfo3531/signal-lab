// Pure position-management calculation. A successful plan never authorizes an order.
import {quantizeVolumeStep,isVolumeStepAligned,splitVolumeQuantity} from './volume_profile.mjs';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const stamp=x=>Number.isSafeInteger(x)&&x>=1e12&&x<8640000000000000;
const FRACTIONS=Object.freeze([.4,.35,.25]);
const failure=(reasons,profileEvidence=null)=>({ok:false,code:'TP_PROFILE_UNAVAILABLE',targets:[],parts:[],estimatedNetRR:null,weightedNetRR:null,
 profileEvidence,reasons:[...new Set(reasons)],fixedRRReplacementEnabled:false,calculationOnly:true,executionApproved:false});

/** Price and quantity units must already be established by the caller's venue
 * contract validation. These scalars are not an independent venue-unit proof.
 * Fees are a declared PAPER model; no unknown cost is silently made zero. */
export function planVolumeTargets(input={}, {now=Date.now(),maxAgeMs=90000}={}){
 const {profileResult,direction,entry,stop,quantity,tickSize,quantityStep,minQuantity,minNotional,contractSizeBase,quantityUnit,notionalCurrency,unitsVerified,
  costs,minNetRR=1.8,targetMode='HVN_ONLY',obstacleFraction=.5}=input??{},evidence=profileResult?.evidence??null,hybrid=targetMode==='HVN_THEN_R';
 if(!['HVN_ONLY','HVN_THEN_R'].includes(targetMode)||!positive(obstacleFraction)||obstacleFraction>1)return failure(['TARGET_SETTINGS_INVALID'],evidence);
 if(!stamp(now)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>90000)return failure(['TARGET_SETTINGS_INVALID'],evidence);
 if(profileResult?.ok!==true||profileResult?.code!=='TP_PROFILE_READY'||!profileResult.profile||!Array.isArray(profileResult.profile.hvn))
  return failure(['VOLUME_PROFILE_NOT_AVAILABLE'],evidence);
 if(!stamp(evidence?.receivedAt)||!stamp(evidence?.windowEnd)||evidence.receivedAt>now||evidence.windowEnd>now||
  now-evidence.receivedAt>maxAgeMs||now-evidence.windowEnd>maxAgeMs||evidence.coverage?.complete!==true||evidence.coverage?.truncated!==false)
  return failure(['VOLUME_PROFILE_STALE_OR_INCOMPLETE'],evidence);
 if(!['LONG','SHORT'].includes(direction)||![entry,stop,quantity,tickSize,quantityStep,minQuantity,minNotional,contractSizeBase,minNetRR].every(positive)||
  unitsVerified!==true||notionalCurrency!=='USDT'||!['BASE_ASSET','CONTRACT'].includes(quantityUnit))return failure(['TARGET_DIRECTION_OR_CONTRACT_UNVERIFIED'],evidence);
 const sign=direction==='LONG'?1:-1;
 if(sign*(entry-stop)<=0)return failure(['STOP_DIRECTION_INVALID'],evidence);
 if(!isVolumeStepAligned(entry,tickSize)||!isVolumeStepAligned(stop,tickSize)||!isVolumeStepAligned(quantity,quantityStep))return failure(['ENTRY_STOP_OR_QUANTITY_OFF_GRID'],evidence);
 if(!costs||!['SYNTHETIC_TEST','EXPLICIT_PAPER_ASSUMPTIONS','VERIFIED_VENUE'].includes(costs.assumption)||
  !['makerRate','takerRate','slippageBps','spreadBps','fundingRate'].every(key=>finite(costs[key]))||
  costs.makerRate<0||costs.takerRate<0||costs.makerRate>1||costs.takerRate>1||costs.slippageBps<0||costs.spreadBps<0||
  costs.slippageBps>1000||costs.spreadBps>1000||Math.abs(costs.fundingRate)>1)return failure(['TARGET_COSTS_UNVERIFIED'],evidence);
 if(evidence.dataSource==='SYNTHETIC_TEST'&&costs.assumption==='VERIFIED_VENUE')return failure(['SYNTHETIC_PROFILE_NOT_VENUE_EVIDENCE'],evidence);
 const size=quantityUnit==='CONTRACT'?contractSizeBase:1,slipRate=(costs.spreadBps/2+costs.slippageBps)/10000,
  entryFill=entry*(1+sign*slipRate),stopFill=stop*(1-sign*slipRate),fundingReserve=Math.abs(costs.fundingRate),
  perUnitRisk=size*(sign*(entryFill-stopFill)+(entryFill+stopFill)*costs.takerRate+entryFill*fundingReserve),
  initialRisk=quantity*perUnitRisk,frontRun=Math.max(tickSize,entry*(costs.spreadBps/2+costs.slippageBps)/10000);
 if(!positive(initialRisk)||!positive(entryFill)||!positive(stopFill))return failure(['TARGET_RISK_INVALID'],evidence);
 const zones=profileResult.profile.hvn.filter(zone=>[zone.priceLow,zone.priceHigh,zone.price,zone.volume].every(positive)&&
  zone.priceHigh>=zone.priceLow&&(direction==='LONG'?zone.priceLow>entry:zone.priceHigh<entry))
  .sort((a,b)=>direction==='LONG'?a.priceLow-b.priceLow:b.priceHigh-a.priceHigh);
 const selected=[];
 const grossR=price=>sign*(price-entry)/Math.abs(entry-stop),roundTrip=entry*(2*costs.takerRate+2*slipRate+fundingReserve),
  netR=price=>(sign*(price-entry)-roundTrip)/(Math.abs(entry-stop)+roundTrip);
 const edge=zone=>direction==='LONG'?zone.priceLow-frontRun:zone.priceHigh+frontRun;
 const pocVolume=profileResult.profile.poc?.peakVolume??profileResult.profile.poc?.volume;
 for(const zone of zones){
  if(selected.some(prior=>zone.priceLow<=prior.priceHigh&&zone.priceHigh>=prior.priceLow))continue;
  if(hybrid&&!selected.length&&netR(edge(zone))<minNetRR+.02){
   // A heavy zone before TP1 would likely stall the move: no trade. A light one is passed through.
   if(positive(pocVolume)&&(zone.peakVolume??zone.volume)>=obstacleFraction*pocVolume)return failure(['STRONG_HVN_BEFORE_TP1'],evidence);
   continue;
  }
  selected.push(zone);if(selected.length===3)break;
 }
 const fills=[];
 if(selected.length<3){
  if(!hybrid)return failure(['FEWER_THAN_THREE_DIRECTIONAL_HVNS'],evidence);
  // Open air beyond the last volume zone: continue in whole R steps (>= minNetRR, then +1R each).
  // Smallest half-R step whose net reward still clears minNetRR after round-trip costs.
  const rd=Math.abs(entry-stop),firstR=Math.ceil(((minNetRR*(rd+roundTrip)+roundTrip)/rd+.05)*2)/2;
  let r=selected.length?Math.max(firstR,Math.floor(grossR(edge(selected.at(-1))))+1):firstR;
  while(selected.length+fills.length<3){fills.push(r);r+=1}
 }
 let quantities;
 try{quantities=splitVolumeQuantity(quantity,quantityStep)}catch{return failure(['TARGET_QUANTITY_ROUNDING_INVALID'],evidence)}
 const tolerance=Math.max(1e-12,quantity*Number.EPSILON*32);
 if(quantities.some(q=>!positive(q)||q<minQuantity||!isVolumeStepAligned(q,quantityStep))||Math.abs(quantities.reduce((a,b)=>a+b,0)-quantity)>tolerance)
  return failure(['TARGET_SPLIT_MINIMUM_OR_REMAINDER_INVALID'],evidence);
 let targets;
 const rDistance=Math.abs(entry-stop);
 try{targets=[...selected.map(zone=>quantizeVolumeStep(edge(zone),tickSize,direction==='LONG'?'DOWN':'UP')),
  ...fills.map(r=>quantizeVolumeStep(entry+sign*r*rDistance,tickSize,direction==='LONG'?'DOWN':'UP'))]}
 catch{return failure(['TARGET_PRICE_DIRECTION_OR_ORDER_INVALID'],evidence)}
 if(targets.some((price,i)=>!positive(price)||sign*(price-entry)<=0||i>0&&sign*(price-targets[i-1])<=0))return failure(['TARGET_PRICE_DIRECTION_OR_ORDER_INVALID'],evidence);
 const parts=targets.map((price,index)=>{
  const q=quantities[index],exitFill=price*(1-sign*slipRate),gross=q*size*sign*(exitFill-entryFill),fees=q*size*(entryFill+exitFill)*costs.takerRate,
   funding=q*size*entryFill*fundingReserve,net=gross-fees-funding;
  const zone=selected[index];
  return {price,fraction:FRACTIONS[index],quantity:q,actualFraction:q/quantity,zone:zone?{...zone}:null,source:zone?'HVN':'R_MULTIPLE',rMultiple:zone?null:fills[index-selected.length],
   estimatedGrossPnL:gross,estimatedFees:fees,estimatedFundingReserve:funding,estimatedNetPnL:net,estimatedNetRR:net/(q*perUnitRisk),
   costAssumption:costs.assumption,accountRateVerified:costs.accountRateVerified===true};
 });
 if(parts.some(part=>!finite(part.estimatedNetPnL)||part.estimatedNetPnL<=0||part.quantity*size*part.price<minNotional))return failure(['TARGET_MIN_NOTIONAL_OR_NET_PROFIT_INVALID'],evidence);
 if(parts[0].estimatedNetRR<minNetRR)return failure(['TARGET_NET_RR_BELOW_MINIMUM'],evidence);
 return {ok:true,code:'TP_PROFILE_READY',targets,parts,estimatedNetRR:parts[0].estimatedNetRR,
  weightedNetRR:parts.reduce((sum,part)=>sum+part.estimatedNetPnL,0)/initialRisk,profileEvidence:evidence,reasons:[],
  initialRisk,quantity,totalQuantity:quantity,quantityUnit,notionalCurrency,contractSizeBase,stop,entry,version:'VOLUME_PROFILE_TP_V1',costAssumption:costs.assumption,
  costAssumptions:{assumption:costs.assumption,makerRate:costs.makerRate,takerRate:costs.takerRate,slippageBps:costs.slippageBps,
   spreadBps:costs.spreadBps,fundingRate:costs.fundingRate,fundingPolicy:'ABSOLUTE_RATE_STRESS_RESERVE',accountRateVerified:costs.accountRateVerified===true},
  unitsProofStatus:'CALLER_VERIFIED_DECLARATION',targetMode,hvnTargets:selected.length,rMultipleTargets:fills.length,
  managementVersion:'VOLUME_PROFILE_V1',
  fixedRRReplacementEnabled:fills.length>0,calculationOnly:true,executionApproved:false};
}
