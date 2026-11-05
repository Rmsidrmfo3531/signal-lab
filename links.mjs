/** Official destination links only. This module never submits an order. */
export function officialBinanceLinks(symbol){
 if(typeof symbol!=='string'||!/^[A-Z0-9]{2,24}USDT$/.test(symbol))return null;
 return {binance:`https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`};
}
export function officialMarketLinks(symbol){return officialBinanceLinks(symbol)}
export function telegramMessage(signal,officialLinks,formatted=String){
 const official=officialBinanceLinks(signal?.symbol);
 if(!official||officialLinks?.binance!==official.binance)throw Error('Verified Binance market URL required for Telegram signal');
 if(!Number.isFinite(signal.score)||signal.score<0||signal.score>100)throw Error('Canonical score is unavailable');
 if(signal.scoreVersion==='ISSUE6-100-V1'&&(signal.status!=='signal'||signal.qualified!==true))throw Error('Final validation is required');
 const plan=signal.targetPlan,prices=plan?.targets,
  validPlan=plan?.ok===true&&Array.isArray(prices)&&prices.length===3&&prices.every(p=>Number.isFinite(p)&&p>0)&&
   prices.every((p,i)=>signal.direction==='LONG'?p>(i?prices[i-1]:signal.entry):p<(i?prices[i-1]:signal.entry));
 if(signal.scoreVersion==='ISSUE6-100-V1'&&!validPlan)throw Error('Final volume-profile target validation is required');
 const evidence=plan?.profileEvidence||{},source=evidence.dataSource??evidence.source??'미확인',
  checks=Array.isArray(signal.scoreBreakdown)?signal.scoreBreakdown:[],confirmedAt=signal.patternConfirmedAt??signal.scannedAt;
 const text=[`🚨 [최종 신호 · 주문 승인 별도] Binance 선물 ${signal.symbol} ${signal.direction}`,
  `확정 패턴: ${signal.pattern} / 종합점수 ${signal.score}/100`,
  `확정봉: ${new Date(confirmedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} KST`,
  `진입 참고: ${formatted(signal.entry)} / 손절: ${formatted(signal.stop)}`,
  ...(validPlan?prices.map((price,index)=>`TP${index+1}: ${formatted(price)} · 초기 물량 ${[40,35,25][index]}% 청산`):['TP_PROFILE_UNAVAILABLE: 검증된 3개 매물대 목표가 없음 · 신규 진입 보류']),
  validPlan?`매물대 근거: ${source} · 집계 기간/커버리지/갱신 시각은 지표 상세에서 확인`:null,
  Number.isFinite(plan?.estimatedNetRR)?`비용 가정 반영 1차 목표 순손익비: ${plan.estimatedNetRR.toFixed(2)}R`:null,
  ...checks.map(check=>`${check.label}: ${check.earned}/${check.weight}점`),
  `기술 검증과 거래 승인·호가 깊이·스프레드·최대 손실 검증은 별도입니다.`,
  `⚠️ 점수는 예상 승률이 아닙니다. 공개 호가는 확정 체결이 아니며 수수료·펀딩·슬리피지·청산가를 별도 확인하세요. 자동 주문 없음.`
 ].filter(Boolean).join('\n');
 const keyboard=[];
 keyboard.push([{text:`Binance ${signal.symbol} 선물 ↗`,url:official.binance}]);
 return {text,disable_web_page_preview:true,reply_markup:{inline_keyboard:keyboard}};
}
