/** Optional Telegram research alerts; NEVER relaxes the strict execution/signal gate. */
export function watchMinScore(raw){
 const value=Number(raw);
 return Number.isInteger(value)&&value>=1&&value<=100?value:0;
}
export function shouldNotifyWatch(signal,{minScore=0,verified=false,altOnly=true,now=Date.now()}={}){
 const threshold=watchMinScore(minScore);
 const score=Number(signal?.score),confirmedAt=Number(signal?.patternConfirmedAt);
 return threshold>0&&verified===true&&Boolean(signal)&&
   (!altOnly||signal.symbol!=='BTCUSDT')&&
   /^[A-Z0-9]+USDT$/.test(String(signal.symbol||''))&&
   ['LONG','SHORT'].includes(signal.direction)&&
   signal.patternConfirmed===true&&typeof signal.pattern==='string'&&signal.pattern.length>0&&
   Number.isFinite(score)&&score>=threshold&&score<=100&&
   signal.status!=='signal'&&signal.qualified!==true&&
   Number.isFinite(confirmedAt)&&confirmedAt>0&&confirmedAt<=now&&now-confirmedAt<=75*60000;
}
export function watchAlertKey(signal){
 return `watch:${signal.symbol}:${signal.direction}:${signal.pattern}:${signal.time}`;
}
export function telegramWatchMessage(signal,officialLinks){
 if(!officialLinks?.variational||!officialLinks?.binance)throw Error('Verified market links are required');
 const failed=Array.isArray(signal.quality?.failed)?signal.quality.failed.filter(x=>typeof x==='string'):[];
 const kst=new Date(signal.patternConfirmedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
 const text=[
  `🔎 [관찰용 · 매매 신호 아님] ${signal.symbol} ${signal.direction}`,
  `기술 조건 점수: ${signal.score}/100 · 설정 임계값 통과`,
  `확정 패턴: ${signal.pattern}`,
  `1시간봉 확정: ${kst} KST`,
  `거래량 배율: ${Number(signal.volumeRatio||0).toFixed(2)}배`,
  `미충족 기술 조건: ${failed.length?failed.join(' / '):'없음'}`,
  `별도 체결·비용 검증: ${signal.executionStatus||'미확인'}`,
  '⚠️ 조건 점수는 승률이 아닙니다. 진입 가능 신호가 아니며 호가·손절·리스크를 별도로 검증하세요. 자동 주문 없음.'
 ].join('\n');
 return {text,disable_web_page_preview:true,reply_markup:{inline_keyboard:[
  [{text:`Variational ${signal.symbol.replace('USDT','')}-PERP ↗`,url:officialLinks.variational}],
  [{text:`Binance ${signal.symbol} 선물 ↗`,url:officialLinks.binance}]
 ]}};
}
