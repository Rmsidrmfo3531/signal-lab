// US core macroeconomic indicator calendar with 24-month empirical BTC impact stats (read-only).
// Primary source: TradingView public economic calendar (includes live `actual`, `forecast`, `previous`).
// Fallback source: ForexFactory public weekly JSON feeds (thisweek + nextweek).
// Focuses strictly on US core BTC-moving releases (FOMC, CPI, NFP, PCE, PPI, GDP, Retail Sales,
// Initial Jobless Claims, ISM Mfg/Svc PMI, JOLTS, Michigan Sentiment) — excluding non-US/China and
// low-impact housing/ADP noise — while capturing companion sub-indicators (Core PCE YoY, GDP Price
// Index, Continuing Claims, ISM Prices Paid, Michigan Inflation Expectations, Avg Hourly Earnings)
// and grading impact from real 2-year 5m BTC backtest data (econ_impact_stats.json).

import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const TV_CALENDAR_URL='https://economic-calendar.tradingview.com/events';
const FF_THIS_WEEK_URL='https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_NEXT_WEEK_URL='https://nfs.faireconomy.media/ff_calendar_nextweek.json';
const KST_MS=9*3600000;
const DAY_KO=['일','월','화','수','목','금','토'];

const COUNTRY_META={USD:{flag:'🇺🇸',nameKo:'미국'}};
const ISO2_TO_CCY={US:'USD'};

function loadBacktestStats(){
 try{
  const p=fileURLToPath(new URL('./econ_impact_stats.json',import.meta.url));
  return JSON.parse(fs.readFileSync(p,'utf8'));
 }catch{
  return {baseline:null,families:{}};
 }
}
export const ECON_IMPACT_STATS=loadBacktestStats();
export function getHistoricalImpact(familyKey){
 return familyKey&&ECON_IMPACT_STATS?.families?.[familyKey]||null;
}

// Primary US core BTC-moving indicators (matched by title, independent of TradingView's inconsistent importance code
// which marks Initial Jobless Claims as 0 and Housing Starts as 1).
const PRIMARY_US_RE=/^(?:fed interest rate decision|federal funds rate|interest rate|fomc statement|fomc press conference|fomc (?:meeting )?minutes|fomc economic projections|fed chair .*speaks|fed powell speech|powell speaks|core inflation rate (?:mom|yoy)|inflation rate (?:mom|yoy)|core cpi\s*(?:m\/m|y\/y)|cpi\s*(?:m\/m|y\/y)|core pce price index(?:\s*(?:mom|m\/m))?|non[- ]?farm (?:payrolls|employment change)|unemployment rate|ppi\s*(?:mom|m\/m)|core ppi\s*(?:mom|m\/m)|gdp growth rate qoq.*|(?:advance|prelim|final) gdp\s*q\/q|retail sales\s*(?:mom|m\/m)|(?:initial jobless|unemployment) claims|ism manufacturing pmi|ism services pmi|jolts job openings|michigan consumer sentiment.*|prelim uom consumer sentiment|cb consumer confidence|jackson hole.*)$/i;

// Companion sub-indicators (including importance 0 / -1 on TradingView) released alongside primary US releases
// that frequently drive or reverse BTC direction.
const SUB_INDICATOR_RE=/^(?:core pce price index\s*(?:yoy|y\/y)|pce price index\s*(?:mom|yoy|m\/m|y\/y)|personal spending(?:\s*mom)?|personal income(?:\s*mom)?|core inflation rate\s*(?:mom|yoy)|inflation rate\s*(?:mom|yoy)|core cpi\s*(?:m\/m|y\/y)|cpi\s*(?:m\/m|y\/y)|average hourly earnings.*|participation rate|u6 unemployment rate|nonfarm payrolls private|core ppi\s*(?:mom|yoy|m\/m|y\/y)|ppi\s*(?:yoy|y\/y)|continuing jobless claims|ism manufacturing prices|ism services prices|ism manufacturing employment|ism services employment|retail sales control group|retail sales ex autos.*|core retail sales.*|gdp price index.*|core pce prices qoq.*|michigan.*inflation expectations.*|uom.*inflation expectations.*|fomc economic projections|interest rate projection.*)$/i;

const NO_ACTUAL_TITLE_RE=/speaks|speech|press conference|minutes|statement|symposium|outlook report|testifies|testimony|holiday/i;

// Ordered rules: first match wins. `familyKey` links to 24-month empirical BTC backtest stats in econ_impact_stats.json.
const EVENT_RULES=[
 {re:/^(?:federal funds rate|fed interest rate decision|interest rate)$/i,familyKey:'FOMC_RATE',ko:'미국 기준금리 결정 (FOMC)',critical:true,polarity:'INVERSE',
  hint:'금리 동결·인하 여부 및 점도표가 BTC 변동성 직결',
  watch:'기준금리 · 성명서 문구 · 점도표 · 30분 뒤 파월 기자회견',
  reversal:'금리·성명서 첫 반응이 30분 뒤 파월 의장 기자회견 한마디로 완전히 반전되는 경우가 잦습니다.'},
 {re:/fomc economic projections|interest rate projection/i,familyKey:'FOMC_RATE',ko:'FOMC 경제전망 · 점도표',critical:true,polarity:'INVERSE',
  hint:'향후 금리 인하 횟수 전망 변화 시 급변동',
  watch:'올해·내년 점도표 중위값 · 장기 중립금리 · 근원 PCE 전망치',
  reversal:'금리가 동결돼도 점도표상 연내 인하 횟수가 줄거나 늘면 즉시 반대 방향으로 급변합니다.'},
 {re:/fomc press conference/i,familyKey:'FOMC_RATE',ko:'FOMC 파월 의장 기자회견',critical:true,polarity:'NEUTRAL',
  hint:'매파·비둘기파 발언 톤에 따라 실시간 급등락',
  watch:'추가 인하/동결 시사 · 인플레이션 평가 · 고용 하방 리스크 언급',
  reversal:'성명서 발표 직후 방향을 추격하면 기자회견 질의응답 중 V자 반전(청산 휩소) 위험이 큽니다.'},
 {re:/fomc statement/i,familyKey:'FOMC_RATE',ko:'FOMC 통화정책 성명서',critical:true,polarity:'NEUTRAL',
  hint:'성명서 문구 변화로 향후 금리 경로 선반영',
  watch:'물가 둔화 문구 삭제/추가 · 만장일치 여부(반대표)',
  reversal:'성명서만 보고 진입하기보다 30분 뒤 기자회견 톤 변화로 반전될 수 있음을 감안해야 합니다.'},
 {re:/fomc (?:meeting )?minutes/i,familyKey:'FOMC_RATE',ko:'FOMC 의사록 공개',critical:true,polarity:'NEUTRAL',
  hint:'연준 위원 간 매파·비둘기파 의견 확인',
  watch:'금리 인상/인하 논의 비중 · 대차대조표(QT) 종료 논의',
  reversal:'일부 매파 문구에 초기 하락했다가 비둘기파 다수 의견이 확인되면 빠르게 되돌립니다.'},
 {re:/fed chair .*speaks|powell speak|fed powell speech/i,familyKey:'FOMC_RATE',ko:'연준 의장 연설',critical:true,polarity:'NEUTRAL',
  hint:'금리·유동성 관련 발언 시 단기 급변동 유의',
  watch:'금리 경로 · 인플레이션 재점화 우려 · 유동성/QT 발언',
  reversal:'준비 원고 반응과 이어지는 Q&A 발언이 엇갈리며 급반전하는 패턴이 잦습니다.'},
 {re:/core pce price index.*(?:y\/?y|yoy)/i,familyKey:'PCE',ko:'미국 근원 PCE 물가지수 (전년비)',critical:false,polarity:'INVERSE',
  hint:'연준 최선호 물가지표 — 예상 하회 시 위험자산 우호적',
  watch:'근원 PCE(전월비·전년비) · 헤드라인 PCE · 개인소비·개인소득 · 이전치 수정',
  reversal:'전년비가 예상 상회해도 전월비(MoM) 둔화나 이전 달 하향 수정 시 하락 후 반등 전환합니다.'},
 {re:/core pce price index/i,familyKey:'PCE',ko:'미국 근원 PCE 물가지수 (전월비)',critical:false,polarity:'INVERSE',
  hint:'연준 최선호 물가지표 — 예상 하회 시 위험자산 우호적',
  watch:'근원 PCE(전월비·전년비) · 헤드라인 PCE · 개인소비·개인소득 · 이전치 수정',
  reversal:'PCE 본체가 높아도 동시 발표되는 개인소비 둔화나 이전치 하향 수정 시 급반등이 나올 수 있습니다.'},
 {re:/\bpce price index.*(?:y\/?y|yoy)/i,familyKey:'PCE',ko:'미국 PCE 물가지수 (전년비)',critical:false,polarity:'INVERSE',
  hint:'인플레이션 둔화 여부에 따라 금리 기대감 변동',
  watch:'헤드라인 PCE · 근원(Core) PCE · 개인소비지출',
  reversal:'에너지·식품 영향으로 헤드라인이 높아도 근원 PCE가 안정되면 시장이 빠르게 반전합니다.'},
 {re:/\bpce price index/i,familyKey:'PCE',ko:'미국 PCE 물가지수 (전월비)',critical:false,polarity:'INVERSE',
  hint:'인플레이션 둔화 여부에 따라 금리 기대감 변동',
  watch:'헤드라인 PCE · 근원(Core) PCE · 개인소비지출',
  reversal:'헤드라인과 근원 PCE 방향이 엇갈리면 초반 급락/급등 후 되돌림이 크게 발생합니다.'},
 {re:/personal spending/i,familyKey:'PCE',ko:'미국 개인소비지출 (소비)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'PCE 동시 발표 세부 지표 — 소비 과열/둔화 확인',
  watch:'개인소비 · 개인소득 · 실질 소비 증감',
  reversal:'PCE 물가가 예상치에 부합해도 개인소비가 급감/급증하면 경기·금리 해석이 바뀝니다.'},
 {re:/personal income/i,familyKey:'PCE',ko:'미국 개인소득',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'PCE 동시 발표 세부 지표 — 소비 여력 확인',
  watch:'개인소득 · 저축률 · 개인소비',
  reversal:'물가 지표가 부담스러워도 소득·소비 둔화가 동반되면 완화적 해석으로 반전될 수 있습니다.'},
 {re:/core (?:cpi|inflation rate).*(?:y\/?y|yoy)/i,familyKey:'CPI',ko:'미국 근원 CPI (전년비)',critical:true,polarity:'INVERSE',
  hint:'예상 상회 시 금리 부담으로 코인 하방 압력',
  watch:'근원 CPI(전월비·전년비) · 헤드라인 CPI · 주거비(Shelter) · 슈퍼코어 서비스',
  reversal:'헤드라인 CPI가 나빠도 근원 CPI 전월비(MoM)가 낮게 나오면 하락 직후 강하게 V자 반전합니다.'},
 {re:/core (?:cpi|inflation rate).*(?:m\/?m|mom)/i,familyKey:'CPI',ko:'미국 근원 CPI (전월비)',critical:true,polarity:'INVERSE',
  hint:'핵심 물가 추세 — 예상 상회 시 매도 변동성 확대',
  watch:'근원 CPI(전월비) · 헤드라인 CPI(전년비) · 서비스 물가 세부 항목',
  reversal:'전월비가 예상 상회해도 소수점 둘째 자리 반올림이나 주거비 둔화 확인 시 반전합니다.'},
 {re:/(?:^|\b)(?:cpi|inflation rate).*(?:y\/?y|yoy)/i,familyKey:'CPI',ko:'미국 소비자물가 CPI (전년비)',critical:true,polarity:'INVERSE',
  hint:'대표 인플레이션 지표 — 발표 직후 강한 위아래 휩소 주의',
  watch:'헤드라인 CPI(전년비·전월비) · 근원(Core) CPI · 에너지/주거비 비중',
  reversal:'헤드라인이 예상 상회해 급락해도 근원(Core) CPI가 예상 하회하면 즉시 상승 반전하는 경우가 많습니다.'},
 {re:/(?:^|\b)(?:cpi|inflation rate).*(?:m\/?m|mom)/i,familyKey:'CPI',ko:'미국 소비자물가 CPI (전월비)',critical:true,polarity:'INVERSE',
  hint:'예상치 대비 ±0.1%p 괴리만으로도 급변동',
  watch:'헤드라인 CPI(전월비) · 근원 CPI(전월비·전년비)',
  reversal:'유가 일시 상승으로 헤드라인만 튀고 근원 CPI가 낮으면 초반 하락이 매수 기회로 반전됩니다.'},
 {re:/non[- ]?farm (?:employment change|payrolls)/i,familyKey:'NFP',ko:'미국 비농업 고용 (NFP)',critical:true,polarity:'PRO_GROWTH_CAVEAT',
  hint:'고용 과열·둔화 여부가 금리 인하 속도 좌우',
  watch:'NFP 고용자 수 · 실업률 · 시간당 평균임금 · 이전 2개월 수정치',
  reversal:'NFP 헤드라인이 강해도 동시 발표되는 실업률 상승·임금 둔화·이전치 대폭 하향 수정 시 즉시 반전합니다.'},
 {re:/u6 unemployment rate/i,familyKey:'NFP',ko:'미국 광의 실업률 (U-6)',critical:false,polarity:'INVERSE_CLAIMS',
  hint:'고용보고서 세부 지표 — 체감 고용 여력 확인',
  watch:'U-6 실업률 · 공식 실업률 · NFP',
  reversal:'공식 실업률이 안정적이어도 U-6가 급등하면 고용 악화 해석으로 전환됩니다.'},
 {re:/unemployment rate/i,familyKey:'NFP',ko:'미국 실업률',critical:true,polarity:'INVERSE_CLAIMS',
  hint:'예상 상회 시 경기 침체 우려 vs 금리 인하 기대 충돌',
  watch:'실업률 · 경제활동참가율 · 비농업 고용(NFP) · 시간당 임금',
  reversal:'실업률이 올라도 경제활동참가율 상승 때문이거나 NFP가 강하면 침체 공포가 해소되며 반전합니다.'},
 {re:/average hourly earnings/i,familyKey:'NFP',ko:'미국 시간당 평균임금',critical:false,polarity:'INVERSE',
  hint:'고용보고서 핵심 세부 지표 — 임금 인플레이션 압력 확인',
  watch:'시간당 임금(전월비·전년비) · 주당 평균근로시간',
  reversal:'NFP 고용이 강하게 나와도 임금 상승률이 둔화되면 인플레 우려가 꺾이며 반등 전환합니다.'},
 {re:/participation rate/i,familyKey:'NFP',ko:'미국 경제활동참가율',critical:false,polarity:'NEUTRAL',
  hint:'실업률 해석의 핵심 세부 지표',
  watch:'경제활동참가율 · 실업률 · NFP',
  reversal:'실업률 상승이 구직자 유입(참가율 상승)에 따른 것이면 경기 악화 해석이 완화됩니다.'},
 {re:/nonfarm payrolls private/i,familyKey:'NFP',ko:'미국 민간 비농업 고용',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'정부 고용을 제외한 민간 실질 고용',
  watch:'민간 NFP · 전체 NFP · 실업률',
  reversal:'전체 NFP가 정부 채용으로 부풀려지고 민간 고용이 부진하면 방향이 반전됩니다.'},
 {re:/core ppi.*(?:y\/?y|yoy)/i,familyKey:'PPI',ko:'미국 근원 PPI (전년비)',critical:false,polarity:'INVERSE',
  hint:'소비자물가(CPI)·PCE 선행 지표',
  watch:'근원 PPI(전월비·전년비) · 헤드라인 PPI',
  reversal:'헤드라인 PPI와 근원 PPI가 엇갈리면 초반 변동 후 되돌림이 나타납니다.'},
 {re:/core (?:ppi|producer price)/i,familyKey:'PPI',ko:'미국 근원 PPI (전월비)',critical:false,polarity:'INVERSE',
  hint:'소비자물가(CPI)·PCE 선행 지표 — 예상 상회 시 부담',
  watch:'근원 PPI · 헤드라인 PPI · PCE 직결 항목(의료·항공·금융) · 이전치 수정',
  reversal:'PPI 헤드라인이 높아도 PCE에 반영되는 세부 서비스 물가가 낮으면 하락 후 반등합니다.'},
 {re:/ppi.*(?:y\/?y|yoy)/i,familyKey:'PPI',ko:'미국 생산자물가 PPI (전년비)',critical:false,polarity:'INVERSE',
  hint:'도매 물가 추세 확인',
  watch:'헤드라인 PPI(전월비·전년비) · 근원 PPI',
  reversal:'이전 달 수치가 크게 하향 수정되거나 근원 PPI가 낮으면 반전합니다.'},
 {re:/\bppi\b|producer price/i,familyKey:'PPI',ko:'미국 생산자물가 PPI (전월비)',critical:false,polarity:'INVERSE',
  hint:'도매 물가 추세 확인 — 발표 직후 단기 변동',
  watch:'헤드라인 PPI · 근원 PPI · 이전 달 수정치',
  reversal:'본 지표가 예상 상회해도 이전 달 수치가 크게 하향 수정되거나 근원 PPI가 낮으면 반전합니다.'},
 {re:/continuing jobless claims/i,familyKey:'JOBLESS_CLAIMS',ko:'미국 연속 실업수당 청구건수',critical:false,polarity:'INVERSE_CLAIMS',
  hint:'신규 실업수당과 동시 발표 — 재취업 난이도(장기 고용 둔화) 확인',
  watch:'연속 청구건수 · 신규 청구건수 · 4주 이동평균',
  reversal:'신규 청구가 양호해도 연속 청구가 급증하면 고용 둔화 해석으로 방향이 바뀝니다.'},
 {re:/(?:initial jobless|unemployment) claims/i,familyKey:'JOBLESS_CLAIMS',ko:'미국 신규 실업수당 청구건수',critical:false,polarity:'INVERSE_CLAIMS',
  hint:'매주 목요일 발표 — 고용 둔화 여부 실시간 체크',
  watch:'신규 청구건수 · 연속 청구건수(Continuing Claims) · 동시 발표 GDP/PCE',
  reversal:'신규 청구 수치가 예상과 달라도 연속 청구건수나 동시 발표되는 타 미국 지표에 의해 빠르게 반전합니다.'},
 {re:/jolts job openings/i,familyKey:'JOLTS',ko:'미국 JOLTS 구인·이직 보고서',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'노동시장 과열 완화 여부 확인',
  watch:'구인건수 · 자발적 퇴사율(Quits Rate) · 해고율',
  reversal:'구인건수가 예상보다 많아도 퇴사율 하락·이전치 하향 수정 시 금리 부담이 완화되며 반전합니다.'},
 {re:/ism manufacturing prices|ism services prices|ism .*prices paid/i,familyKey:'ISM_MFG',ko:'미국 ISM 물가지수 (Prices Paid)',critical:false,polarity:'INVERSE',
  hint:'ISM PMI 핵심 세부 항목 — 기업 체감 인플레이션 직결',
  watch:'ISM 물가지수(Prices Paid) · 헤드라인 PMI · 신규주문',
  reversal:'헤드라인 PMI가 양호해도 물가지수(Prices Paid)가 급등하면 매파 해석으로 하락 반전합니다.'},
 {re:/ism manufacturing employment|ism services employment/i,familyKey:'ISM_MFG',ko:'미국 ISM 고용지수',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'ISM PMI 세부 항목 — 비농업 고용(NFP) 선행 힌트',
  watch:'ISM 고용지수 · 헤드라인 PMI · 물가지수',
  reversal:'PMI 본체와 고용·물가 세부 항목이 엇갈리면 발표 직후 양방향 휩소가 발생합니다.'},
 {re:/ism manufacturing pmi/i,familyKey:'ISM_MFG',ko:'미국 ISM 제조업 PMI',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'50 기준 경기 확장·위축 판단 — 2년 실측 상회 시 강세 경향',
  watch:'헤드라인 PMI · 물가지수(Prices Paid) · 신규주문 · 고용지수',
  reversal:'PMI가 50을 상회해도 내부 물가지수(Prices Paid) 급등 시 금리 우려로 하락 반전하는 경우가 잦습니다.'},
 {re:/ism services pmi/i,familyKey:'ISM_SVC',ko:'미국 ISM 서비스업 PMI',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'미국 경제 비중이 큰 서비스업 경기 지표',
  watch:'헤드라인 PMI · 서비스 물가지수(Prices Paid) · 고용지수',
  reversal:'서비스 PMI가 좋아도 물가지수 급등이 동반되면 연준 매파 우려로 급반락할 수 있습니다.'},
 {re:/retail sales control group/i,familyKey:'RETAIL_SALES',ko:'미국 소매판매 통제그룹 (GDP 반영)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'소매판매 핵심 세부 지표 — GDP 소비 계산에 직접 반영',
  watch:'통제그룹 · 근원 소매판매 · 헤드라인 소매판매',
  reversal:'헤드라인 소매판매가 부진해도 통제그룹이 예상 상회하면 오히려 반등 전환합니다.'},
 {re:/core retail sales|retail sales ex/i,familyKey:'RETAIL_SALES',ko:'미국 근원 소매판매',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'자동차·휘발유 제외 소비 탄력성 지표',
  watch:'근원 소매판매 · 통제그룹 · 헤드라인 소매판매',
  reversal:'자동차 판매 변동으로 헤드라인이 흔들려도 근원 소매판매 방향을 따라 반전하는 경우가 많습니다.'},
 {re:/retail sales/i,familyKey:'RETAIL_SALES',ko:'미국 소매판매 (전월비)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'소비 경기 확인 — 예상 상회 시 달러 강세 경향',
  watch:'헤드라인 소매판매 · 근원 소매판매 · 통제그룹(Control Group) · 이전치 수정',
  reversal:'헤드라인이 예상 하회해도 근원·통제그룹이 강하거나 이전치가 상향 수정되면 반전합니다.'},
 {re:/gdp price index|gdp deflator/i,familyKey:'GDP',ko:'미국 GDP 물가지수 (디플레이터)',critical:false,polarity:'INVERSE',
  hint:'GDP 동시 발표 물가 세부 지표 — 스태그플레이션 경계 핵심',
  watch:'GDP 물가지수 · 실질 GDP 성장률 · 분기 근원 PCE',
  reversal:'GDP 성장률이 예상과 달라도 내부 GDP 물가지수 방향에 따라 시장이 즉시 반전합니다.'},
 {re:/core pce prices qoq/i,familyKey:'GDP',ko:'미국 분기 근원 PCE 물가',critical:false,polarity:'INVERSE',
  hint:'GDP 동시 발표 분기 물가 세부 지표',
  watch:'분기 근원 PCE · 실질 GDP 성장률',
  reversal:'GDP 성장률보다 내부 분기 PCE 물가가 예상치를 크게 벗어나면 방향이 뒤집힙니다.'},
 {re:/advance gdp|gdp growth rate.*adv/i,familyKey:'GDP',ko:'미국 GDP 성장률 (속보치)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'첫 분기 성장률 발표로 경기 침체·과열 판단 핵심',
  watch:'실질 GDP 성장률 · GDP 물가지수(디플레이터) · 분기 PCE · 민간 소비',
  reversal:'성장률이 부진해도 동시 발표되는 GDP 물가지수가 높으면(또는 반대) 첫 방향에서 급반전합니다.'},
 {re:/prelim gdp|gdp growth rate.*2nd|gdp growth rate.*prelim/i,familyKey:'GDP',ko:'미국 GDP 성장률 (잠정치)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'GDP 수정치 — 큰 폭 조정 시 변동성',
  watch:'수정 GDP 성장률 · GDP 물가지수 · 동시 발표 실업수당',
  reversal:'GDP 수정치와 동시 발표되는 물가지수·실업수당이 엇갈리면 휩소가 커집니다.'},
 {re:/final gdp|gdp growth rate.*final/i,familyKey:'GDP',ko:'미국 GDP 성장률 (확정치)',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'분기 성장률 확정치',
  watch:'확정 GDP · GDP 물가지수 · 기업이익',
  reversal:'확정치 자체보다 동시 발표되는 PCE 물가·실업수당 수치에 따라 방향이 뒤집힐 수 있습니다.'},
 {re:/\bgdp\b/i,familyKey:'GDP',ko:'미국 GDP 성장률',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'거시 경기 성장세 확인 지표',
  watch:'실질 GDP · 물가 세부 항목 · 소비/투자 기여도',
  reversal:'헤드라인 성장률과 내부 물가 지표 방향이 다르면 초반 움직임이 반전될 수 있습니다.'},
 {re:/cb consumer confidence/i,familyKey:'MICHIGAN',ko:'미국 컨퍼런스보드 소비자신뢰지수',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'소비 심리 변화 확인',
  watch:'신뢰지수 본체 · 기대지수(80 하회 여부) · 노동시장 체감지수',
  reversal:'헤드라인이 반등해도 향후 경기 기대지수가 악화되면 상승분을 반납합니다.'},
 {re:/(?:uom|michigan).*5\s*year.*inflation expectations/i,familyKey:'MICHIGAN',ko:'미시간대 5년 기대 인플레이션',critical:false,polarity:'INVERSE',
  hint:'장기 기대 물가 세부 지표 — 연준 매파 우려 직결',
  watch:'5년 장기 기대 인플레이션 · 1년 기대 인플레이션 · 소비심리 본체',
  reversal:'소비심리 본체보다 5년 기대 인플레이션이 0.1~0.2%p만 튀어도 급락 반전합니다.'},
 {re:/(?:uom|michigan).*inflation expectations/i,familyKey:'MICHIGAN',ko:'미시간대 1년 기대 인플레이션',critical:false,polarity:'INVERSE',
  hint:'소비심리 동시 발표 핵심 세부 지표 — 연준 매파 우려 직결',
  watch:'1년 기대 인플레이션 · 5년 장기 기대 인플레이션 · 소비심리 본체',
  reversal:'소비심리지수가 둔화돼도 1년·5년 기대 인플레이션이 튀어 오르면 급락 반전합니다.'},
 {re:/(?:uom|michigan) consumer sentiment/i,familyKey:'MICHIGAN',ko:'미국 미시간대 소비심리지수',critical:false,polarity:'PRO_GROWTH_CAVEAT',
  hint:'소비심리 및 기대 인플레이션 동시 주목',
  watch:'소비심리 본체 · 1년 기대 인플레이션 · 5년 장기 기대 인플레이션',
  reversal:'소비심리 본체보다 함께 나오는 1년·5년 기대 인플레이션 수치가 시장 방향을 반전시키는 핵심입니다.'},
 {re:/jackson hole/i,familyKey:'FOMC_RATE',ko:'잭슨홀 경제심포지엄',critical:true,polarity:'NEUTRAL',
  hint:'연준 의장 기조연설 시 중기 통화정책 방향 전환점',
  watch:'금리 인하/동결 시사 · 중립금리 논의 · 고용/물가 우선순위',
  reversal:'기조연설 첫 문단 반응 이후 전체 톤이 해석되며 반전 변동성이 크게 나타납니다.'},
];

export function expectsNumericActual(title){
 return !NO_ACTUAL_TITLE_RE.test(String(title||''));
}

function resolveUsCurrency(raw){
 const ccy=String(raw?.currency||ISO2_TO_CCY[String(raw?.country||'').toUpperCase()]||raw?.country||'').trim().toUpperCase();
 return ccy==='USD'?'USD':'';
}

/** Return true if a raw calendar item is a primary US core BTC-moving release (excludes China/non-US and housing/ADP noise). */
export function isHighImpactCryptoEvent(raw){
 if(!raw||typeof raw!=='object')return false;
 if(!resolveUsCurrency(raw))return false;
 const title=String(raw.title||raw.indicator||'').replace(/\s+/g,' ').trim();
 if(!title)return false;
 // Exclude weekly ADP or NSA duplicates
 if(/weekly|nsa\b/i.test(title))return false;
 return PRIMARY_US_RE.test(title);
}

function isCompanionSubEvent(raw){
 if(!raw||typeof raw!=='object')return false;
 if(!resolveUsCurrency(raw))return false;
 const title=String(raw.title||raw.indicator||'').replace(/\s+/g,' ').trim();
 if(!title||/weekly|nsa\b/i.test(title))return false;
 return SUB_INDICATOR_RE.test(title);
}

/** Localize a US economic event with empirical 24-month BTC backtest grade, checklist, and reversal guide. */
export function localizeEconomicEvent(raw){
 const title=String(raw?.title||'').replace(/\s+/g,' ').trim();
 for(const rule of EVENT_RULES){
  if(rule.re.test(title)){
   const bt=getHistoricalImpact(rule.familyKey);
   const grade=bt?.grade||(rule.critical?'S':'A');
   const tier=grade==='S'?'CRITICAL':(grade==='A'?'HIGH':'WATCH');
   const tierLabelKo=grade==='S'?'S 초강력':(grade==='A'?'A 강력':'B 참고');
   return {
    familyKey:rule.familyKey||null,
    titleKo:rule.ko,
    grade,
    tier,
    tierLabelKo,
    polarity:rule.polarity||'NEUTRAL',
    hintKo:rule.hint,
    watchItemsKo:rule.watch||'',
    reversalKo:rule.reversal||'',
    backtest:bt,
   };
  }
 }
 return {
  familyKey:null,
  titleKo:`미국 ${title}`,
  grade:'B',
  tier:'WATCH',
  tierLabelKo:'B 참고',
  polarity:'NEUTRAL',
  hintKo:'미국 주요 거시지표 — 발표 전후 변동성 유의',
  watchItemsKo:'헤드라인 수치 · 세부 구성 항목 · 이전 발표치 수정 여부',
  reversalKo:'동시 발표되는 타 세부 지표나 이전치 수정에 따라 초기 방향이 반전될 수 있습니다.',
  backtest:null,
 };
}

/** Format numeric value from TradingView using scale (K/M/B/T) and unit (%/$). */
export function formatTvValue(val,scale='',unit=''){
 if(val==null||val==='')return '';
 if(typeof val==='string'&&!/^-?\d+(?:\.\d+)?$/.test(val.trim()))return val.trim();
 const n=Number(val);
 if(!Number.isFinite(n))return '';
 const sc=String(scale||'').trim();
 const u=String(unit||'').trim();
 const numStr=String(+n.toFixed(4));
 if(u==='$'||u==='€'||u==='£'||u==='¥'){
  return n<0?`-${u}${String(+Math.abs(n).toFixed(4))}${sc}`:`${u}${numStr}${sc}`;
 }
 return `${numStr}${sc}${u}`;
}

function parseNumericFigure(str){
 const s=String(str||'').trim();
 if(!s)return null;
 const m=s.match(/^([+-]?)[^\d.-]*(\d+(?:,\d+)*(?:\.\d+)?)\s*([KMBT]?)\s*(%?)$/i);
 if(!m)return null;
 const sign=m[1]==='-'?-1:1;
 const base=Number(m[2].replace(/,/g,''));
 if(!Number.isFinite(base))return null;
 const scale=String(m[3]||'').toUpperCase();
 const unit=m[4]||'';
 return {value:sign*base,scale,unit};
}

/** Compute actual-vs-forecast surprise direction and formatted Korean diff label. */
export function computeEventSurprise(actual,forecast){
 const a=parseNumericFigure(actual);
 const f=parseNumericFigure(forecast);
 if(!a||!f||a.scale!==f.scale||a.unit!==f.unit)return null;
 const diff=+(a.value-f.value).toFixed(4);
 if(Math.abs(diff)<1e-6){
  return {direction:'INLINE',labelKo:'예상 부합',deltaText:'0'};
 }
 const sign=diff>0?'+':'';
 const suffix=a.unit==='%'?'%p':`${a.scale}${a.unit}`;
 return {
  direction:diff>0?'ABOVE':'BELOW',
  labelKo:diff>0?'예상 상회':'예상 하회',
  deltaText:`${sign}${diff}${suffix}`,
 };
}

/** Evaluate directional crypto risk-asset bias from surprise + indicator polarity. */
export function evaluateCryptoImpact(surprise,polarity='NEUTRAL'){
 if(!surprise)return null;
 if(surprise.direction==='INLINE')return {tone:'NEUTRAL',labelKo:'중립 · 예상 부합'};
 if(polarity==='INVERSE'){
  return surprise.direction==='BELOW'
   ?{tone:'BULLISH',labelKo:'코인 우호 (물가·금리 완화)'}
   :{tone:'BEARISH',labelKo:'코인 부담 (매파·금리 압력)'};
 }
 if(polarity==='INVERSE_CLAIMS'){
  return surprise.direction==='ABOVE'
   ?{tone:'MIXED',labelKo:'양면 · 고용 둔화 (금리완화 vs 침체)'}
   :{tone:'BEARISH',labelKo:'코인 부담 (고용 견조·금리 압력)'};
 }
 if(polarity==='PRO_GROWTH_CAVEAT'){
  return surprise.direction==='ABOVE'
   ?{tone:'MIXED',labelKo:'양면 · 경기 견조 (금리 부담 유의)'}
   :{tone:'MIXED',labelKo:'양면 · 경기 둔화 (완화 vs 침체)'};
 }
 return {tone:'NEUTRAL',labelKo:surprise.labelKo};
}

/** Format an epoch ms timestamp into KST display labels. */
export function formatKstEventTime(at){
 const d=new Date(Number(at)+KST_MS);
 const mm=String(d.getUTCMonth()+1).padStart(2,'0');
 const dd=String(d.getUTCDate()).padStart(2,'0');
 const dow=DAY_KO[d.getUTCDay()];
 const hh=String(d.getUTCHours()).padStart(2,'0');
 const mi=String(d.getUTCMinutes()).padStart(2,'0');
 return {
  dateKey:`${d.getUTCFullYear()}-${mm}-${dd}`,
  dateLabel:`${mm}/${dd}(${dow})`,
  timeLabel:`${hh}:${mi}`,
  fullLabel:`${mm}/${dd}(${dow}) ${hh}:${mi} KST`,
 };
}

/** Human-readable Korean countdown label (with live HH:MM:SS precision inside 24 hours). */
export function formatCountdownKo(at,now=Date.now(),{hasActual=false,expectsActual=true,precise=false}={}){
 if(hasActual)return '발표 완료';
 const diffMs=Number(at)-Number(now);
 if(diffMs<=0){
  const agoMin=Math.floor(Math.abs(diffMs)/60000);
  if(agoMin<15)return expectsActual?'발표 직후 · 결과 수집 중':'진행 중 · 변동성 유의';
  if(agoMin<60)return `${agoMin}분 전 발표`;
  const agoHr=Math.floor(agoMin/60);
  return `${agoHr}시간 전 발표`;
 }
 if(precise&&diffMs<24*3600000){
  const totalSec=Math.max(0,Math.ceil(diffMs/1000));
  const h=Math.floor(totalSec/3600);
  const m=Math.floor((totalSec%3600)/60);
  const s=totalSec%60;
  const p2=n=>String(n).padStart(2,'0');
  return h>0?`T-${p2(h)}:${p2(m)}:${p2(s)}`:`T-${p2(m)}:${p2(s)}`;
 }
 const mins=Math.ceil(diffMs/60000);
 if(mins<60)return `${mins}분 후`;
 const hrs=Math.floor(mins/60);
 const remMin=mins%60;
 if(hrs<24)return remMin>0?`${hrs}시간 ${remMin}분 후`:`${hrs}시간 후`;
 const days=Math.floor(hrs/24);
 const remHr=hrs%24;
 return remHr>0?`${days}일 ${remHr}시간 후`:`${days}일 후`;
}

function normalizeEventRecord({id='',at,country='USD',title,forecast='',previous='',actual='',period='',source='ForexFactory',isSub=false}){
 const cleanTitle=String(title||'').replace(/\s+/g,' ').trim();
 const loc=localizeEconomicEvent({country:'USD',title:cleanTitle});
 const kst=formatKstEventTime(at);
 const cleanActual=String(actual||'').trim();
 const cleanForecast=String(forecast||'').trim();
 const cleanPrevious=String(previous||'').trim();
 const surprise=cleanActual&&cleanForecast?computeEventSurprise(cleanActual,cleanForecast):null;
 const cryptoImpact=evaluateCryptoImpact(surprise,loc.polarity);
 return {
  id:String(id||`USD|${cleanTitle.toLowerCase()}|${at}`),
  at,
  date:new Date(at).toISOString(),
  country:'USD',
  flag:COUNTRY_META.USD.flag,
  countryKo:COUNTRY_META.USD.nameKo,
  familyKey:loc.familyKey,
  title:cleanTitle,
  titleKo:loc.titleKo,
  period:String(period||'').trim(),
  grade:loc.grade,
  tier:loc.tier,
  tierLabelKo:loc.tierLabelKo,
  polarity:loc.polarity,
  hintKo:loc.hintKo,
  watchItemsKo:loc.watchItemsKo,
  reversalKo:loc.reversalKo,
  backtest:loc.backtest,
  expectsActual:expectsNumericActual(cleanTitle),
  forecast:cleanForecast,
  previous:cleanPrevious,
  actual:cleanActual,
  surprise,
  cryptoImpact,
  isSub,
  subEvents:[],
  source,
  kstDateKey:kst.dateKey,
  kstDateLabel:kst.dateLabel,
  kstTimeLabel:kst.timeLabel,
  kstFullLabel:kst.fullLabel,
 };
}

function tierRank(tier){return tier==='CRITICAL'?0:(tier==='HIGH'?1:2)}

/** Fold duplicate same-family primaries at the same timestamp (e.g. CPI MoM + Core CPI YoY) into subEvents of the lead event, and attach companion sub-indicators. */
export function attachCompanionSubEvents(primaryEvents,subEvents){
 // 1) Collapse same-timestamp same-family primaries (keep highest-priority lead, fold siblings into subEvents)
 const familyPriority=title=>{
  const t=String(title||'').toLowerCase();
  if(/core (?:cpi|inflation rate).*(?:m\/m|mom)|core pce price index.*(?:m\/m|mom)|non[- ]?farm|fed interest rate|^interest rate$|federal funds rate|gdp growth rate|advance gdp|retail sales\s*(?:mom|m\/m)|initial jobless|unemployment claims|ism manufacturing pmi|ism services pmi/.test(t))return 0;
  if(/(?:cpi|inflation rate).*(?:y\/y|yoy)|unemployment rate|core ppi/.test(t))return 1;
  return 2;
 };

 const byFamSlot=new Map();
 const collapsed=[];
 const extraSubs=[];
 const ordered=[...primaryEvents].sort((a,b)=>a.at-b.at||tierRank(a.tier)-tierRank(b.tier)||familyPriority(a.title)-familyPriority(b.title));
 for(const ev of ordered){
  const famKey=ev.familyKey?`${ev.familyKey}|${ev.at}`:ev.id;
  if(!byFamSlot.has(famKey)){
   byFamSlot.set(famKey,ev);
   collapsed.push(ev);
  }else{
   extraSubs.push(ev);
  }
 }

 // 2) Attach extra same-family siblings & companion sub-indicators to matching family or timestamp host
 const byTs=new Map();
 for(const ev of collapsed){
  if(!byTs.has(ev.at))byTs.set(ev.at,ev);
 }
 for(const sub of [...extraSubs,...subEvents]){
  const host=(sub.familyKey&&byFamSlot.get(`${sub.familyKey}|${sub.at}`))||byTs.get(sub.at);
  if(!host||host.title.toLowerCase()===sub.title.toLowerCase())continue;
  if(host.subEvents.length<6&&!host.subEvents.some(x=>x.title.toLowerCase()===sub.title.toLowerCase())){
   host.subEvents.push({
    id:sub.id,
    title:sub.title,
    titleKo:sub.titleKo,
    actual:sub.actual,
    forecast:sub.forecast,
    previous:sub.previous,
    surprise:sub.surprise,
    cryptoImpact:sub.cryptoImpact,
    polarity:sub.polarity,
   });
  }
 }
 return collapsed;
}

/** Detect conflicting simultaneous prints (e.g. Headline CPI hot/BEARISH vs Core CPI cool/BULLISH, or GDP hot vs GDP Price Index cool). */
export function analyzeReleaseConflicts(events){
 const groups=new Map();
 for(const ev of (Array.isArray(events)?events:[])){
  if(!ev)continue;
  const key=`${ev.country}|${ev.at}`;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(ev);
 }
 const conflicts=[];
 for(const [slotKey,group] of groups.entries()){
  const allItems=[];
  for(const ev of group){
   if(ev.actual&&ev.surprise)allItems.push(ev);
   for(const sub of (ev.subEvents||[])){
    if(sub.actual&&sub.surprise)allItems.push(sub);
   }
  }
  if(allItems.length<2)continue;
  const bullish=allItems.filter(x=>x.cryptoImpact?.tone==='BULLISH');
  const bearish=allItems.filter(x=>x.cryptoImpact?.tone==='BEARISH');
  const above=allItems.filter(x=>x.surprise?.direction==='ABOVE');
  const below=allItems.filter(x=>x.surprise?.direction==='BELOW');

  let conflict=null;
  if(bullish.length&&bearish.length){
   const bTxt=bearish.map(x=>`${x.titleKo} ${x.actual}(${x.surprise.labelKo})`).slice(0,2).join(', ');
   const gTxt=bullish.map(x=>`${x.titleKo} ${x.actual}(${x.surprise.labelKo})`).slice(0,2).join(', ');
   conflict={
    slotKey,
    at:group[0].at,
    country:group[0].country,
    flag:group[0].flag,
    detected:true,
    kind:'OPPOSITE_IMPACT',
    summaryKo:`지표 엇갈림 · 반전 주의 — 부담(${bTxt}) vs 우호(${gTxt}). 헤드라인 첫 반응 추격에 유의하세요.`,
   };
  }else if(above.length&&below.length){
   const aTxt=above.map(x=>`${x.titleKo} ${x.actual}(상회)`).slice(0,2).join(', ');
   const dTxt=below.map(x=>`${x.titleKo} ${x.actual}(하회)`).slice(0,2).join(', ');
   conflict={
    slotKey,
    at:group[0].at,
    country:group[0].country,
    flag:group[0].flag,
    detected:true,
    kind:'MIXED_SURPRISE',
    summaryKo:`동시 발표 지표 혼조 — 상회(${aTxt}) vs 하회(${dTxt}). 세부 항목 해석에 따른 반전 변동성에 유의하세요.`,
   };
  }
  if(conflict){
   conflicts.push(conflict);
   for(const ev of group)ev.conflict=conflict;
  }
 }
 return conflicts.sort((a,b)=>b.at-a.at);
}

/** Parse and deduplicate raw ForexFactory JSON arrays into normalized US core events + companion sub-events. */
export function parseEconomicEvents(rawLists){
 const lists=Array.isArray(rawLists)&&Array.isArray(rawLists[0])?rawLists:[rawLists];
 const seen=new Set();
 const primaries=[],subs=[];
 for(const list of lists){
  if(!Array.isArray(list))continue;
  for(const raw of list){
   const isPrimary=isHighImpactCryptoEvent(raw);
   const isSub=!isPrimary&&isCompanionSubEvent(raw);
   if(!isPrimary&&!isSub)continue;
   const at=Date.parse(String(raw.date||''));
   if(!Number.isFinite(at))continue;
   const title=String(raw.title||'').replace(/\s+/g,' ').trim();
   const key=`USD|${title.toLowerCase()}|${at}`;
   if(seen.has(key))continue;
   seen.add(key);
   const rec=normalizeEventRecord({
    id:key,
    at,
    country:'USD',
    title,
    forecast:raw.forecast,
    previous:raw.previous,
    actual:raw.actual,
    source:'ForexFactory',
    isSub,
   });
   if(isPrimary)primaries.push(rec);
   else subs.push(rec);
  }
 }
 const merged=attachCompanionSubEvents(primaries,subs);
 analyzeReleaseConflicts(merged);
 return merged;
}

/** Parse TradingView /events JSON response into normalized US core events + companion sub-events with live actuals. */
export function parseTradingViewEvents(payload){
 const rows=Array.isArray(payload?.result)?payload.result:(Array.isArray(payload)?payload:[]);
 const seen=new Set();
 const primaries=[],subs=[];
 for(const raw of rows){
  const isPrimary=isHighImpactCryptoEvent(raw);
  const isSub=!isPrimary&&isCompanionSubEvent(raw);
  if(!isPrimary&&!isSub)continue;
  const at=Date.parse(String(raw.date||''));
  if(!Number.isFinite(at))continue;
  const title=String(raw.title||raw.indicator||'').replace(/\s+/g,' ').trim();
  const dedupKey=`USD|${title.toLowerCase()}|${at}`;
  if(seen.has(dedupKey))continue;
  seen.add(dedupKey);
  const scale=raw.scale||'';
  const unit=raw.unit||'';
  const rec=normalizeEventRecord({
   id:raw.id!=null?`tv:${raw.id}`:dedupKey,
   at,
   country:'USD',
   title,
   actual:formatTvValue(raw.actual,scale,unit),
   forecast:formatTvValue(raw.forecast,scale,unit),
   previous:formatTvValue(raw.previous,scale,unit),
   period:raw.period||'',
   source:'TradingView',
   isSub,
  });
  if(isPrimary)primaries.push(rec);
  else subs.push(rec);
 }
 const merged=attachCompanionSubEvents(primaries,subs);
 analyzeReleaseConflicts(merged);
 return merged;
}

/** True when an event with an expected numeric actual is within [T-30s, T+15m] and still awaiting its actual print. */
export function isReleaseWatchWindow(events,now=Date.now()){
 const t=Number(now)||Date.now();
 return (Array.isArray(events)?events:[]).some(e=>
  e&&e.expectsActual!==false&&!e.actual&&t>=e.at-30000&&t<=e.at+15*60000
 );
}

/** Return events whose `actual` just arrived compared to the previous cached list. */
export function findNewlyReleasedEvents(prevEvents,nextEvents){
 const prevMap=new Map();
 for(const e of (Array.isArray(prevEvents)?prevEvents:[])){
  if(!e)continue;
  prevMap.set(e.id,e);
  prevMap.set(`${e.country}|${e.titleKo}|${e.at}`,e);
 }
 const newly=[];
 for(const e of (Array.isArray(nextEvents)?nextEvents:[])){
  if(!e?.actual)continue;
  const old=prevMap.get(e.id)||prevMap.get(`${e.country}|${e.titleKo}|${e.at}`);
  if(old&&!old.actual)newly.push(e);
 }
 return newly;
}

/** Build the dashboard/API economic calendar payload relative to `now`. */
export function buildEconomicCalendarReport({events=[],now=Date.now(),updatedAt=null,error='',source=''}={}){
 const t=Number(now)||Date.now();
 const todayKey=formatKstEventTime(t).dateKey;
 const list=(Array.isArray(events)?events:[]).map(e=>({...e,subEvents:Array.isArray(e?.subEvents)?e.subEvents:[]}));
 const detectedSource=source||list[0]?.source||'TradingView';
 analyzeReleaseConflicts(list);

 const decorate=e=>{
  const diffMs=e.at-t;
  const hasActual=Boolean(e.actual);
  const isImminent=!hasActual&&diffMs>-15*60000&&diffMs<=2*3600000;
  const isAwaitingResult=!hasActual&&e.expectsActual!==false&&diffMs<=0&&diffMs>-15*60000;
  const isJustReleased=hasActual&&diffMs<=60000&&diffMs>=-30*60000;
  const isWithin24h=!hasActual&&diffMs>-15*60000&&diffMs<=24*3600000;
  const isToday=e.kstDateKey===todayKey;
  return {
   ...e,
   countdownKo:formatCountdownKo(e.at,t,{hasActual,expectsActual:e.expectsActual!==false,precise:true}),
   isImminent,
   isAwaitingResult,
   isJustReleased,
   isWithin24h,
   isToday,
  };
 };

 const upcoming=list
  .filter(e=>!e.actual&&(e.at>=t||(e.at>=t-15*60000)))
  .sort((a,b)=>a.at-b.at||tierRank(a.tier)-tierRank(b.tier))
  .slice(0,20)
  .map(decorate);

 const recent=list
  .filter(e=>(e.actual&&e.at<=t+60000&&e.at>=t-24*3600000)||(!e.actual&&e.at<t-15*60000&&e.at>=t-24*3600000))
  .sort((a,b)=>b.at-a.at||tierRank(a.tier)-tierRank(b.tier))
  .slice(0,8)
  .map(decorate);

 const justReleased=recent.filter(e=>e.isJustReleased);
 const activeConflicts=justReleased.map(e=>e.conflict).filter(Boolean);
 const latestConflict=activeConflicts[0]||recent.find(e=>e.conflict)?.conflict||null;
 const nextEvent=upcoming[0]||null;
 const imminentCount=upcoming.filter(e=>e.isImminent).length;
 const todayCount=upcoming.filter(e=>e.isToday).length;
 const criticalCount=upcoming.filter(e=>e.tier==='CRITICAL').length;
 const releaseWatch=isReleaseWatchWindow(list,t);

 return {
  ok:Boolean(list.length||!error),
  updatedAt:Number(updatedAt)||t,
  serverNow:t,
  source:detectedSource,
  baseline:ECON_IMPACT_STATS?.baseline||null,
  error:error||'',
  releaseWatch,
  justReleased,
  latestConflict,
  nextEvent,
  imminentCount,
  todayCount,
  criticalCount,
  upcomingCount:upcoming.length,
  upcoming,
  recent,
 };
}

/** Fetch live US core events (including `actual` prints & companion sub-indicators) from TradingView. */
export async function fetchTradingViewCalendar({fetcher=fetch,now=Date.now(),timeoutMs=15000}={}){
 const fromIso=new Date(now-24*3600000).toISOString();
 const toIso=new Date(now+14*86400000).toISOString();
 const url=`${TV_CALENDAR_URL}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&countries=US`;
 const headers={
  Accept:'application/json',
  Origin:'https://www.tradingview.com',
  Referer:'https://www.tradingview.com/',
  'User-Agent':'SignalLab/1.0',
 };
 const res=await fetcher(url,{signal:AbortSignal.timeout(timeoutMs),headers});
 if(!res.ok)throw Error(`TradingView 캘린더 HTTP ${res.status}${res.status===429?' (요청 한도 초과)':''}`);
 const json=await res.json();
 if(!Array.isArray(json?.result))throw Error('TradingView 캘린더 응답 형식 오류');
 return parseTradingViewEvents(json);
}

/** Fetch fallback weekly US schedule from ForexFactory public CDN JSON feeds. */
export async function fetchForexFactoryCalendar({fetcher=fetch,timeoutMs=15000}={}){
 const headers={Accept:'application/json','User-Agent':'SignalLab/1.0'};
 const resThis=await fetcher(FF_THIS_WEEK_URL,{signal:AbortSignal.timeout(timeoutMs),headers});
 if(!resThis.ok)throw Error(`경제지표 캘린더 HTTP ${resThis.status}${resThis.status===429?' (요청 한도 초과)':''}`);
 const thisWeek=await resThis.json();
 if(!Array.isArray(thisWeek))throw Error('경제지표 캘린더 응답 형식 오류');

 let nextWeek=[];
 try{
  const resNext=await fetcher(FF_NEXT_WEEK_URL,{signal:AbortSignal.timeout(timeoutMs),headers});
  if(resNext.ok){
   const parsed=await resNext.json();
   if(Array.isArray(parsed))nextWeek=parsed;
  }
 }catch{}

 return parseEconomicEvents([thisWeek,nextWeek]);
}

/** Fetch US core economic calendar events: TradingView (live actuals) primary, ForexFactory fallback. */
export async function fetchEconomicCalendar({fetcher=fetch,now=Date.now(),timeoutMs=15000}={}){
 try{
  const tvEvents=await fetchTradingViewCalendar({fetcher,now,timeoutMs});
  if(tvEvents.length)return tvEvents;
 }catch(tvErr){
  try{
   return await fetchForexFactoryCalendar({fetcher,timeoutMs});
  }catch(ffErr){
   throw Error(`${tvErr.message} / 대체 ${ffErr.message}`);
  }
 }
 return fetchForexFactoryCalendar({fetcher,timeoutMs}).catch(()=>[]);
}
