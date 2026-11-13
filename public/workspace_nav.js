// Client-side section routing: panels remain mounted so streaming prices,
// chart state, live positions and journal data are never reset on navigation.
const workspaceRoutes = Object.freeze({
  overview: '대시보드 · 차트',
  live: '실매매',
  news: '시황 · 뉴스',
  alerts: '알림 · 시스템 상태',
  journal: '매매일지 · 위험관리'
});
const workspaceAliases = Object.freeze({
  chartPanel: 'overview',
  workGrid: 'overview',
  execution: 'overview',
  matched: 'overview',
  // Old bookmarks of the removed 자동 모의매매 page open the 실매매 page.
  paper: 'live',
  // The 시그널 스캐너 page was removed at the user's request (the scan itself keeps feeding live trades).
  scanner: 'live'
});
const workspaceSections = [...document.querySelectorAll('.content > [data-workspace-route]')];
const workspaceHeading = document.querySelector('.page-head h1');
const defaultHeading = workspaceHeading?.innerHTML ?? '';
const workspaceEyebrow = document.querySelector('.page-head .eyebrow');
const defaultEyebrow = workspaceEyebrow?.textContent ?? '';
const workspaceIntro = document.querySelector('.page-head .intro');
const defaultIntro = workspaceIntro?.textContent ?? '';
// One line per page that says what is on it (the generic line was the same on every page).
const workspaceIntros = {
  live: 'BingX 주문 상태 · 보유 포지션 · 종료된 거래',
  news: '한국어 번역 뉴스와 실측 시장 시황',
  alerts: '텔레그램·화면 알림 설정과 최근 알림 기록',
  journal: '매매 기록, 패턴별 결과와 위험 한도'
};

function workspaceRouteForHash(hash = window.location.hash) {
  const requested = String(hash).replace(/^#/, '');
  return Object.hasOwn(workspaceRoutes, requested) ? requested : (workspaceAliases[requested] || 'overview');
}

function showWorkspaceRoute() {
  const route = workspaceRouteForHash();
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
  if (workspaceHeading) {
    if (route === 'overview') workspaceHeading.innerHTML = defaultHeading;
    else workspaceHeading.textContent = workspaceRoutes[route];
  }
  if (workspaceEyebrow) { workspaceEyebrow.textContent = route === 'overview' ? defaultEyebrow : ''; workspaceEyebrow.hidden = route !== 'overview'; }
  if (workspaceIntro) workspaceIntro.textContent = route === 'overview' ? defaultIntro : (workspaceIntros[route] || defaultIntro);
  const crumb = document.getElementById('crumbPage');
  if (crumb) crumb.textContent = route === 'overview' ? '대시보드' : workspaceRoutes[route];
  document.title = 'Signal Lab · ' + workspaceRoutes[route];
  document.getElementById('sidebar')?.classList.remove('open');
  window.requestAnimationFrame(() => {
    if (window.location.hash === '#chartPanel') {
      document.getElementById('chartPanel')?.scrollIntoView({block:'start'});
    } else {
      window.scrollTo({top:0,behavior:'auto'});
    }
    // A canvas previously hidden by navigation needs fresh dimensions.
    window.dispatchEvent(new Event('resize'));
  });
}
window.addEventListener('hashchange', showWorkspaceRoute);
showWorkspaceRoute();
