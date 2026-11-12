// Client-side section routing: panels remain mounted so streaming prices,
// chart state, live positions and journal data are never reset on navigation.
const workspaceRoutes = Object.freeze({
  overview: '대시보드 · 차트',
  scanner: '최종 신호 · 스캐너',
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
  paper: 'live'
});
const workspaceSections = [...document.querySelectorAll('.content > [data-workspace-route]')];
const workspaceHeading = document.querySelector('.page-head h1');
const defaultHeading = workspaceHeading?.innerHTML ?? '';
const workspaceEyebrow = document.querySelector('.page-head .eyebrow');
const defaultEyebrow = workspaceEyebrow?.textContent ?? '';

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
  if (workspaceEyebrow) workspaceEyebrow.textContent = route === 'overview' ? defaultEyebrow : 'SIGNAL LAB / WORKSPACE';
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
