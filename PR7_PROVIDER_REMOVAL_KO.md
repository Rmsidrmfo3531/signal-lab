# PR #7 공급자 의존성 제거·점수 정책 검증

2026-11-05 · 제출 브랜치 `feat/issue6-integrated` · 비교 기준 `62f6274`

이 문서는 이전 통합 보고서 이후의 보완 결과입니다. PR #7에서 폐기된 공급자의 서버·TradFi·API·화면·Telegram·링크·문서·설정 의존성을 제거했습니다. 암호화폐 분석·호가 검증은 Binance USDT 무기한 선물만 사용합니다. main 병합과 OrangeX 실제 주문 활성화는 수행하지 않습니다.

## 변경 내용

| 영역 | 변경 파일 | 결과 |
|---|---|---|
| 서버·API | `server.mjs`, `markets.mjs`, `signal_pipeline.mjs`, `scan_diagnostics.mjs`, `paper_health.mjs` | 구 공급자 수집·상장 교집합·폴링·텔레그램 전송·상태 필드를 제거. Binance 계약·호가·위험 검증만 사용 |
| 구 체결 모듈 | `execution.mjs` 삭제 | 참조 코드·업데이트 허용 목록도 제거. Binance 호가 깊이·스프레드·수수료 가정·위험 검사는 유지 |
| TradFi | `tradfi.mjs`, `tradfi_signal.mjs`, `tradfi_feed.mjs` | 검증된 대체 공급자가 없어 수집·분석·신규 모의 진입을 비활성. 기존 키가 있어도 활성화되지 않음 |
| 기존 원장 | `paper.mjs`, `public/paper_ui.js` | 기존 TradFi 진행·대기·종료 기록을 보존. 신규 등록·가격 갱신·대기 만료 처리를 중지. Binance와 같은 종목명이 있어도 TradFi 기록에 적용하지 않음 |
| UI·링크 | `public/app.js`, `index.html`, `styles.css`, `tradfi.js`, `tradingview.js`, `links.mjs` | 구 공급자 링크·버튼·필드·구독 제거. TradFi는 중지 안내와 기존 PNL·일지 접근 유지. 최종 Telegram 링크는 Binance만 제공 |
| 진단·안내 | `scripts/check-market-data.mjs`, `diagnose_scan.mjs`, `package.json`, `.env.issue6.example`, README·Windows·모바일 안내 | 공개 시장 진단은 Binance GET 4개만 수행하고 4H 301봉 요청. 패키지 이름 `signal-lab`. 오래된 안내의 연결 주소를 제거하고 과거 이력임을 표시 |
| 합성 연구 호환 | `research/legacy_v58/decision.mjs`, 재생 모듈·예제·fixture | 폐기된 공급자 의존 없이 Binance 형태의 합성 호가로 구 전략 회귀를 유지. 실시간 분석에 연결하지 않으며 합성 자료만 허용 |
| 점수 설정 | `signal_policy.mjs`, `quality.mjs`, `orangex_adapter.mjs`, API·화면 | 아래 설정·검증 상태를 일관되게 노출 |

TradFi 조회 API는 `status:disabled`, `provider:null`, `paperEntryEnabled:false`, 보존된 기록 수를 반환합니다. `POST /api/tradfi/refresh`는 **409 / TRADFI_PROVIDER_UNAVAILABLE**로 거부합니다. 브라우저 TradFi 모듈은 원격 요청·타이머·차트 삽입을 실행하지 않습니다.

기존 TradFi 포지션은 종료하거나 재평가하지 않습니다. TP/SL·수량·체결·PNL을 그대로 표시하며 **“공급자 없음·기록 보존·자동처리 중지”**, **“마지막 저장 시세 평가(현재 평가 아님)”**를 명시합니다. 공급자가 없는 동안의 익절·손절 체결을 생성하지 않습니다.

## 90점 설정과 한계

`SIGNAL_FINAL_MIN_SCORE=90`은 새 단일 100점 체계의 **제안 기본값**입니다. 허용값은 **90~100 정수**이며, 잘못된 값이나 90 미만이면 서버 시작을 차단합니다. 이번 작업에서 임계값을 낮추지 않았습니다.

기존 중앙 `.env`를 읽은 뒤 해당 값을 분석·최종 판정·OrangeX 사전 검사에 공유합니다. 환경 파일 자체를 수정하지 않습니다. `/api/status`, `/api/results`, `/api/analyze`와 화면에 다음 정보가 표시됩니다.

- `finalMinScore`, `defaultFinalMinScore`, `setting`, `source:DEFAULT|CONFIGURED`
- `validationStatus`, `performanceValidation`, `outOfSampleValidation`, `walkForwardValidation`: **UNVERIFIED**
- `scoreIsWinProbability:false`, `liveApproval:false`

실제 기존 환경 파일에 95를 넣은 상황을 **임시 데이터 경로**에서 재현했습니다. 서버가 95를 읽고, 별도 기술 검증을 통과한 90점 합성 후보의 최종 신호·모의 진입을 차단하며 파일 원문은 보존됨을 확인했습니다. 이는 설정·판정 동작 검사이며 90점 또는 95점의 실전 성능 검증이 아닙니다.

## 검증 결과

| 검사 | 결과 |
|---|---|
| Linux Node.js 22.23.4 전체 회귀 | **726/726 통과**, 실패·취소·건너뛰기 0 |
| Linux Node.js 24.19.0 전체 회귀 | **726/726 통과**, 실패·취소·건너뛰기 0 |
| 서버·클라이언트·진단·테스트 구문 | **JS/MJS 191개 통과** |
| Chromium | **1440×1000 / 390×844 / 360×800 / 720×1024 모두 통과** |
| 브라우저 오류·가로 넘침·TradFi API 요청 | 각 화면 **0건** |
| 합성 LONG·SHORT·분할 익절·손절·CLOSE·PNL·복구 | 전체 회귀에 포함하여 통과 |
| TradFi 기존 기록·설정·백업·재시작 2회 | 별도 임시 원장으로 보존 확인 |
| 제거 대상 공급자명·호스트·구 API 경로 검색 | 현재 작업 트리 전체 **0건** (`.git`, 의존성 폴더 제외) |
| 실제 Windows 실행·원격 GitHub Actions 결과 | **UNVERIFIED** — 이번 클라우드 검사로 대체하지 않음 |
| 실제 거래소·Telegram 발송·외부 TradingView 접속 | 이번에는 실행하지 않음 |
| 새 전략의 실제 수익률·성능 개선 | **UNVERIFIED** |

최초 전체 실행은 722개 중 **2개 실패**했습니다. 개별 분석 API의 최상위 `scorePolicy` 누락을 보완했고, 공급자 중지 후에도 TradFi가 캔들을 조회한다고 기대하던 구형 검사를 “어느 시간봉도 요청하지 않고 중지를 반환하는지” 확인하도록 변경했습니다. 이후 기록 중지 표시와 보존·설정 검사를 포함한 최종 726개가 모두 통과했습니다. 초기 실패 로그는 삭제하지 않았습니다.

삭제된 공급자만 검증하던 테스트는 Binance 계약·현재 호가·비용·최대 손실 검사와 TradFi 중지·기록 보존 검사로 대체했습니다. 테스트 건너뛰기 또는 비용·위험 검증 완화로 통과시키지 않았습니다. 실제 네트워크 대신 명시적인 합성 응답과 로컬 서버를 사용했고, 지정하지 않은 외부 요청은 실패하도록 차단했습니다.

## 보존 및 남은 한계

`persistence.mjs`, `data-cli.mjs`, Windows 시작·모바일 시작·백업·복원 도구, OrangeX 저장 모듈·실험 Journal은 비교 기준과 동일합니다. 별도 원래 작업 디렉터리에 남아 있던 미커밋 파일 28개의 해시도 동일합니다. 실제 Windows 사용자 폴더에 접근하거나 기존 `.env`·store·백업·PNL을 수정하지 않았습니다. 서버 재시작 보존 검사는 별도 임시 경로에서 수행했습니다.

기존 저장 파일에 있던 알 수 없는 메타데이터나 과거 TradFi 이력은 삭제·변환하지 않습니다. 이전 공급자 설정이 기존 `.env`에 남아 있어도 이를 이용해 기능을 활성화하거나 연결하지 않습니다. 새 코드와 문서에는 해당 설정 의존성이 없습니다.

TradFi를 다시 사용하려면 대체 공급자의 상품 대응·계약·시세·정산 규격과 기존 포지션의 후속 관리 정책을 별도 검증해야 합니다. OrangeX는 **READ_ONLY / 실제 시세 PAPER 자동 진입 OFF / LIVE OFF**를 유지합니다. 실계좌 보호 주문·reduce-only·안전한 손절 교체·체결 동기화와 실제 운영 성과를 검증했다고 주장하지 않습니다.

기계 판독 결과는 `reports/pr7-provider-removal-validation.json`, 화면 결과는 `reports/pr7-provider-removal-ui.json`에 기록했습니다. 전체 TAP·초기 실패·구문 해시·보존 확인 자료는 클라우드 `/workspace/signal-pr7-removal-evidence`에 보관했습니다.
