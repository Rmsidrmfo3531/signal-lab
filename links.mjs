import {tradePlan} from './public/trade_plan.js';
/** Official trading-market destination URLs, no orders or wallet connections. */
export function officialMarketLinks(symbol, variationalTicker){
 if(typeof symbol!=='string'||typeof variationalTicker!=='string')return null;
 const match=/^([A-Z0-9]+)USDT$/.exec(symbol);
 if(!match||variationalTicker!==`${match[1]}-PERP`)return null;
 return {
  binance:`https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`,
  variational:`https://omni.variational.io/perpetual/${encodeURIComponent(match[1])}`
 };
}
export function telegramMessage(signal, officialLinks, formatted){
 if(!officialLinks)throw Error('Verified official market URLs required for Telegram signal');
 const plan=tradePlan(signal);
 const text=[`🚨 Binance × Variational ${signal.symbol} ${signal.direction}`,
  `패턴: ${signal.pattern} / 조건 점수 ${signal.score}`,
  `확인: ${new Date(signal.scannedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} KST`,
  `진입 참고: ${formatted(signal.entry)} / 손절: ${formatted(signal.stop)}`,
  ...(plan?.targets.filter(Boolean).map(t=>`${t.name}: ${formatted(t.price)} (${t.multiple}R) · 보유 물량 ${t.reducePct}% 분할익절 · 가격변동 +${t.movePct.toFixed(2)}%`)||[]),
  plan?`진입 관찰 기준: 1H 봉 확정 + 4H 추세 + 참고 진입가 부근 재접근 + Variational 실제 호가 확인` : null,
  `지지: ${signal.supports.map(x=>formatted(x.price)).join(', ')||'없음'}`,
  `저항: ${signal.resistances.map(x=>formatted(x.price)).join(', ')||'없음'}`,
  `거래량 배율: ${signal.volumeRatio.toFixed(2)}x / 목표 손익비 ≥ 2:1`,
  signal.execution?`Variational indicative 호가: Bid ${formatted(signal.execution.bid)} / Ask ${formatted(signal.execution.ask)} (나이 ${Math.round(signal.execution.quoteAgeSeconds)}초)`:null,
  signal.execution?`추정 왕복 스프레드: ${signal.execution.spreadBps.toFixed(2)}bp / ${signal.execution.spreadCostUSD.toFixed(2)} USDC · 명목 ${signal.execution.notional.toFixed(0)} USDC`:null,
  signal.execution?.fundingOneIntervalUSD!=null?`현재 펀딩 1구간 가정: ${signal.execution.fundingOneIntervalUSD.toFixed(3)} USDC (${signal.execution.fundingIntervalSeconds/3600}시간당 구간 금리 기준)`:null,
  `⚠️ 목표가·익절 비중은 예시 시나리오이며 수수료·펀딩·슬리피지 제외. 공개 참고 호가는 확정 체결가가 아님. 실제 진입가·펀딩비·청산가 별도 확인. 자동 주문 없음.`].filter(Boolean).join('\n');
 return {text,disable_web_page_preview:true,reply_markup:{inline_keyboard:[
  [{text:`Variational ${signal.symbol.replace('USDT','')}-PERP ↗`,url:officialLinks.variational}],
  [{text:`Binance ${signal.symbol} 선물 ↗`,url:officialLinks.binance}]
 ]}};
}
