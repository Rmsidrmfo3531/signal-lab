// Client-side section routing: panels remain mounted so live positions, copy state,
// news data are never reset on navigation.
// The dashboard shows only these three pages (user request 2026-11-17; 매매일지 removed 2026-11-20);
// the server keeps running the removed pages' features (scanner, Telegram notices, notification
// settings, /api/journal records).
const workspaceRoutes = Object.freeze({
  real: '실계좌 · 카피 매매',
  live: '테스트넷 · 신호 전략',
  orderflow: '호가·CVD·청산맵', // renamed from '수급 · 청산맵' (user 2026-11-25 09:51); the #orderflow hash stays
  news: '시황 · 뉴스'
});
const defaultRoute = 'real';
// Old bookmarks of the removed 자동 모의매매 page open the 테스트넷 page.
// Every other old or unknown hash (#overview, #alerts, #chartPanel, #venues, #scanner, #journal, ...) opens 실계좌.
// #firechart, #cvd and #liquidation also open 호가·CVD·청산맵 (its features' names); #orderflow keeps working.
const workspaceAliases = Object.freeze({ paper: 'live', firechart: 'orderflow', cvd: 'orderflow', liquidation: 'orderflow' });
const workspaceSections = [...document.querySelectorAll('.content > [data-workspace-route]')];

function workspaceRouteForHash(hash = window.location.hash) {
  const requested = String(hash).replace(/^#/, '');
  return Object.hasOwn(workspaceRoutes, requested) ? requested : (workspaceAliases[requested] || defaultRoute);
}

function showWorkspaceRoute() {
  const route = workspaceRouteForHash();
  // Keep the address bar on a real page so a reload or bookmark lands on what is shown.
  if (window.location.hash !== '#' + route) {
    try { window.history?.replaceState?.(null, '', (window.location.pathname || '') + (window.location.search || '') + '#' + route); } catch {}
  }
  for (const section of workspaceSections) {
    const active = section.dataset.workspaceRoute === route;
    section.hidden = !active;
    section.setAttribute('aria-hidden', String(!active));
  }
  for (const link of document.querySelectorAll('.navlink, .mobile-bottom-nav a')) {
    const destination = workspaceRouteForHash(link.getAttribute('href') || '');
    const active = destination === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const crumb = document.getElementById('crumbPage');
  if (crumb) crumb.textContent = workspaceRoutes[route];
  document.title = 'Signal Lab · ' + workspaceRoutes[route];
  document.getElementById('sidebar')?.classList.remove('open');
  window.requestAnimationFrame(() => window.scrollTo({top:0,behavior:'auto'}));
}
window.addEventListener('hashchange', showWorkspaceRoute);
showWorkspaceRoute();
