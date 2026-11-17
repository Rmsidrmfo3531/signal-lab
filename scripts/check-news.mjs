// News diagnosis (user 2026-11-17 "원문도 못 갖고 오고 한국어로 번역도 못하고"): read-only, no keys, no orders.
//   node scripts/check-news.mjs
// For each RSS source: feed HTTP status and items, RSS text length, the article page fetch and extracted
// paragraphs, then one translation request through the same Google endpoint the server uses.
import {FEEDS,parseRSS} from '../news.mjs';
import {articleDetail} from '../news_article.mjs';
import {googleTranslate,googleTranslateStatus} from '../news_translation.mjs';
const UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'};
for(const f of FEEDS){
 let line=`[${f.name}] `;
 try{
  const r=await fetch(f.url,{headers:UA,signal:AbortSignal.timeout(15000)});const body=await r.text();
  const items=parseRSS(body,f.name);
  line+=`피드 HTTP ${r.status} · 기사 ${items.length}건`;
  const raw=body.match(/<item\b[^>]*>([\s\S]*?)<\/item>/i)?.[1]||'';
  line+=` · RSS 본문 태그: description ${/<description/i.test(raw)?'있음':'없음'}, content:encoded ${/<content:encoded/i.test(raw)?'있음('+(raw.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1]||'').length+'자)':'없음'}`;
  const a=items[0];
  if(a){
   line+=`\n   첫 기사: ${a.title.slice(0,70)}\n   요약 ${a.summary.length}자: ${a.summary.slice(0,90).replace(/\s+/g,' ')}`;
   const d=await articleDetail(a,{translate:undefined});
   line+=`\n   기사 페이지: ${d.ok?'성공 · 문단 '+d.paragraphs.length+'개 · 첫 문단 '+d.paragraphs[0].slice(0,80):'실패 '+d.error}`;
  }
 }catch(e){line+=`피드 실패 ${e.name==='TimeoutError'?'TIMEOUT':e.message}`}
 console.log(line);
}
try{
 const t=await googleTranslate({text:'Bitcoin rose 5% after the ETF approval.',signal:AbortSignal.timeout(10000)});
 console.log('\n[번역] 성공:',typeof t==='string'?t:JSON.stringify(t).slice(0,200));
}catch(e){console.log('\n[번역] 실패:',e.code||e.message,googleTranslateStatus.lastError||'')}
