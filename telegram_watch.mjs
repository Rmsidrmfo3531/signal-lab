/** Telegram-only observations. A watch alert can never authorize an order. */
const VERSION='ISSUE6-100-V1';
export function watchMinScore(raw){
 if(raw===undefined)return 80;
 const value=Number(raw);
 return Number.isInteger(value)&&value>=80&&value<=100?value:0;
}
export function shouldNotifyWatch(signal,{minScore=80,verified=false,now=Date.now()}={}){
 const threshold=watchMinScore(minScore),score=signal?.score,confirmedAt=signal?.patternConfirmedAt;
 return threshold>=80&&verified===true&&Boolean(signal)&&signal.symbol!=='BTCUSDT'&&
  /^[A-Z0-9]{2,24}USDT$/.test(String(signal.symbol||''))&&['LONG','SHORT'].includes(signal.direction)&&
  signal.patternConfirmed===true&&signal.patternTimeframe==='1h'&&typeof signal.pattern==='string'&&signal.pattern.length>0&&
  signal.scoreVersion===VERSION&&signal.indicators?.valid===true&&Number.isFinite(score)&&score>=threshold&&score<=100&&
  signal.status!=='signal'&&signal.qualified!==true&&Number.isSafeInteger(confirmedAt)&&confirmedAt>0&&confirmedAt<=now&&now-confirmedAt<=75*60000;
}
export function watchAlertKey(signal){
 return `watch:${signal.symbol}:${signal.direction}:${signal.pattern}:${signal.patternConfirmedAt}`;
}
function binanceURL(signal,links){
 const expected=`https://www.binance.com/en/futures/${encodeURIComponent(signal.symbol)}`;
 if(!/^[A-Z0-9]{2,24}USDT$/.test(signal.symbol)||links?.binance!==expected)throw Error('Verified Binance market link is required');
 return expected;
}
export function telegramWatchMessage(signal,officialLinks){
 const url=binanceURL(signal,officialLinks);
 if(!Number.isFinite(signal.score)||signal.score<0||signal.score>100)throw Error('Canonical score is unavailable');
 const failed=Array.isArray(signal.technicalValidation?.reasons)?signal.technicalValidation.reasons:
  Array.isArray(signal.quality?.failed)?signal.quality.failed.filter(x=>typeof x==='string'):[];
 const checks=Array.isArray(signal.scoreBreakdown)?signal.scoreBreakdown:signal.indicators?.checks||[];
 const kst=new Date(signal.patternConfirmedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
 const text=[`🔎 [관찰 알림 · 최종 신호 아님] ${signal.symbol} ${signal.direction}`,
  `종합 평가 점수: ${signal.score}/100 · 단일 100점 체계`,
  ...checks.map(x=>`  ${x.label}: ${x.earned}/${x.weight}점${Number.isFinite(x.value)?` (값 ${x.value})`:''}`),
  `확정 패턴: ${signal.pattern}`,`1시간봉 확정: ${kst} KST`,
  Number.isFinite(signal.volumeRatio)?`거래량 배율: ${signal.volumeRatio.toFixed(2)}배`:null,
  `기술 검증 미충족: ${failed.length?failed.join(' / '):'별도 최종 판정 확인 필요'}`,
  `거래 승인: 미승인 · ${signal.executionStatus||'호가·수량·손실 한도 별도 검증'}`,
  '⚠️ 점수는 승률이 아닙니다. 관찰 알림은 Telegram 전용이며 화면의 최종 신호·자동 주문으로 사용하지 않습니다.'
 ].filter(Boolean).join('\n');
 return {text,disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:`Binance ${signal.symbol} 선물 ↗`,url}]]}};
}
