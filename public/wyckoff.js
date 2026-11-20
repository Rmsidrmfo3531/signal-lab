const panel = document.getElementById('wyckoffResearch');
const form = document.getElementById('wyckoffForm');
const status = document.getElementById('wyckoffStatus');
const results = document.getElementById('wyckoffResults');
const rows = document.getElementById('wyckoffRows');
const input = document.getElementById('wyckoffSymbol');
const number = new Intl.NumberFormat('ko-KR', {maximumSignificantDigits:8});
const date = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
const format = value => Number.isFinite(value) ? number.format(value) : '—';
const side = {UP:'상방', DOWN:'하방'};
const verdict = {UNDETERMINED:'방향 미확정', ACCUMULATION:'매집', RE_ACCUMULATION:'재매집', DISTRIBUTION:'분산', RE_DISTRIBUTION:'재분산'};
const retest = {WAIT_BREAKOUT:'돌파 대기', WAIT_RETEST:'4시간봉 재시험 대기', CONFIRMED:'4시간봉 재시험 확인',
  INVALIDATED:'재시험 가설 무효화', INSUFFICIENT_HISTORY:'4시간봉 이력 부족', EXIT_WITHOUT_D:'D 확인 전 범위 종료'};
const availability = {NONE:'감지된 박스 없음', DATA_UNAVAILABLE:'확정봉 조회 불가', INSUFFICIENT_HISTORY:'이력 부족', INSUFFICIENT_VOLUME:'거래량 부족'};
const volumeBand = ['매우 낮음', '낮음', '보통', '다소 높음', '높음', '매우 높음', '극히 높음'];

function boxRow(name, box) {
  if (!box.phase) return [name, availability[box.status], '—'];
  const headline = [box.phase + ' 국면', verdict[box.verdict], side[box.direction],
    box.failedVerdict && '실패한 판정 ' + verdict[box.failedVerdict]].filter(Boolean).join(' · ');
  const last = box.events.at(-1);
  const details = [box.lower !== null && `${format(box.lower)} ~ ${format(box.upper)} USDT`,
    box.status === 'CANDIDATE' ? '후보 범위' : box.pendingDirection ? `${side[box.pendingDirection]} 돌파 확인 대기` : retest[box.retest.status],
    box.breakout && `${box.breakout.label} 확인 ${date.format(box.breakout.confirmedAt + 1)}`,
    box.retest.at && `4시간봉 ${date.format(box.retest.at + 1)}`,
    last && `최근 ${last.label} ${date.format(last.confirmedAt + 1)}`].filter(Boolean).join(' · ');
  return [name, headline, details];
}

function volumeRow(vsa) {
  if (vsa.status !== 'OK') return ['VSA Wyckoff', availability[vsa.status], '—'];
  const recent = vsa.latestEvent;
  const details = [vsa.dryUpRatio !== null && `거래량 수축 비율 ${format(vsa.dryUpRatio)}${vsa.dryUp ? ' · 수축' : ''}`,
    vsa.estimatedBuyPct !== null && `봉 모양 기준 매수량 추정 ${vsa.estimatedBuyPct.toFixed(1)}%`,
    recent && `최근 ${recent.label === 'SV' ? 'SV(하락 정지 징후)' : 'UT(상단 돌파 실패)'} · 확인 ${date.format(recent.confirmedAt + 1)}`];
  return ['VSA Wyckoff', `${volumeBand[vsa.band - 1]} · 20봉 평균의 ${vsa.ratio.toFixed(2)}배`, details.filter(Boolean).join(' · ') || '—'];
}

let requested = false;
async function loadObservation() {
  requested = true;
  const button = form.querySelector('button');
  const symbol = input.value.trim().toUpperCase();
  input.value = symbol;
  button.disabled = true;
  results.hidden = true;
  status.textContent = '확정봉을 조회하는 중입니다.';
  try {
    const response = await fetch('/api/wyckoff?' + new URLSearchParams({symbol}));
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '와이코프 데이터를 조회하지 못했습니다.');
    const values = [boxRow('Wyckoff Range', data.range), boxRow('Wyckoff Structure Map v3.3', data.structureMap), volumeRow(data.vsa)];
    rows.replaceChildren(...values.map(([name, state, detail]) => {
      const row = document.createElement('tr');
      row.insertCell().textContent = name;
      row.insertCell().textContent = state;
      row.insertCell().textContent = detail;
      return row;
    }));
    const setup = data.pattern?.direction === 'LONG' ? '롱' : data.pattern?.direction === 'SHORT' ? '숏' : '없음';
    const map = data.structureMap;
    const comparison = setup !== '없음' && map.retest?.status === 'CONFIRMED' && data.pattern.confirmedAt >= map.retest.at
      ? (side[map.direction] === (setup === '롱' ? '상방' : '하방') ? ' · 와이코프 방향 일치' : ' · 와이코프 방향 불일치') : '';
    status.textContent = `${data.symbol} · 최근 1시간봉 기존 패턴 ${setup}${comparison} · 한국 시간`;
    results.hidden = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

panel.addEventListener('toggle', () => {
  if (panel.open && !requested) void loadObservation();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!form.querySelector('button').disabled) void loadObservation();
});
