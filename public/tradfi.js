// The market provider was removed. Keep an inert status module so bookmarks
// and existing PNL/journal screens remain available without remote requests.
export function refreshTradFi(){
 const status=document.getElementById('tradfiStatus');
 if(status)status.textContent='DISABLED · 대체 시세 공급자 미설정 · 신규 분석·진입 OFF';
 const feed=document.getElementById('tradfiFeed');
 if(feed)feed.textContent='기존 PNL·포지션·매매일지 보존 · TradFi 시세 추적 중지';
}
export function initTradFi(){refreshTradFi()}
