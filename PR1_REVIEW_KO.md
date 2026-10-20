# PR #1 머지 전 재검증 보고서

검토 대상은 `main`의 `ae80863`부터 기존 PR 커밋 `c07db8f`까지 변경된 **33개 파일 전체**입니다. 변경 부분뿐 아니라 관련 함수의 호출 경로와 기존 테스트도 함께 확인했습니다. 추가 수정은 같은 `fix/signal-pipeline-paper-safety` 브랜치에 반영했습니다. 머지는 하지 않았습니다.

## 이번에 발견하고 수정한 문제

| 중요도 | 파일·함수 | 재현 근거와 수정 |
|---|---|---|
| 높음 | `server.mjs` · `connectWS`, 새 `cryptoEntryAllowed` | 대기 신호를 등록한 뒤 Variational 호가가 181초 지난 상태에서 새 Binance 틱이 오면 기존 코드는 가상 진입했습니다. 매 진입 직전 동일 확정봉·패턴·방향과 현재 최종 판정을 다시 확인합니다. 기존 포지션의 익절·손절 추적은 계속됩니다. 새 HTTP 통합 테스트는 기존 PR 코드에서 실패하고 수정 코드에서 통과했습니다. |
| 높음 | `server.mjs` · `checkSymbolInternal`, 새 `publishCryptoSignal` | 브라우저 검사에서 첫 분석이 실시간 시세보다 먼저 도착하면 이후 최종 신호가 1건이어도 모의 등록 검사·대기·진입이 모두 0건인 기동 순서 문제를 확인했습니다. 틱이 들어와 전체 조건이 충족되면 등록·알림을 재평가하고 저장된 키로 중복을 막습니다. 등록한 바로 그 틱에서는 진입하지 않고 후속 틱을 기다립니다. 새 통합 테스트는 기존 PR에서 115개 틱 후에도 진입하지 못해 실패했습니다. |
| 높음 | `execution.mjs` · `executionEstimate` | 숫자 환경설정에 `abc`가 들어가 `NaN`이 되면 비교식이 거짓이어서 오래된 호가 제한 등이 무력화됐습니다. 모든 체결 제한의 유한한 숫자·허용 범위를 검사하고 잘못된 설정은 승인하지 않습니다. |
| 높음 | `paper.mjs` · `PaperEngine.#onPrice` | 신호 등록 후 다른 포지션이 손실을 확정하면 이미 대기 중인 신호가 일간·주간 손실 상한을 우회했습니다. 실제 가상 진입 직전에 상한을 다시 확인합니다. 두 기간의 회귀 테스트를 추가했습니다. |
| 보통 | `paper.mjs` · `realizedCashFlows`, `paperSummary` | 구형 종료 기록의 `closeParts: []`를 정밀 기록으로 오인해 손익을 진입 날짜에 배정했습니다. 종료일 기준의 근사 집계로 처리하고 근사 표시를 켭니다. 기존 거래 원본과 누적 PNL은 바꾸지 않습니다. |
| 보통 | `server.mjs` · `pollNews` | 뉴스 저장이 실패하기 전에 초기화 완료 표시와 알림 전송을 해버렸습니다. 알림 대상 상태를 먼저 저장하고 성공 후 전송합니다. 장애 복구 후 재시도와 중복 방지를 검증했습니다. 새 테스트는 기존 PR 코드에서 실패했습니다. |
| 보통 | `public/trade_plan.js` · `entryTiming`, `public/app.js` · `currentReadySignals` | 필수 봉 신선도·최근 분석이 만료되거나 거래소 상태가 끊겨도 캐시된 준비 완료 표시가 남았습니다. PC·모바일 공용 진입 판정에 만료를 반영하고 목록·개수·상세를 함께 갱신합니다. 틱 수신이 멈춰도 화면에서 주기적으로 재평가합니다. |
| 보통 | `public/app.js` · `renderWatch` | Variational 장애 중 연구 종목으로 전환되고 기존 관심 목록이 복원되면 없는 `variational.ticker` 접근으로 화면 처리가 중단됐습니다. 미검증 상태를 표시하고 렌더링을 계속하도록 수정·회귀 검사했습니다. |
| 보통 | `public/app.js` · 선택 종목 분석 버튼 | 실제 Chromium에서 비동기 분석 후 `event.currentTarget`이 `null`이 되어 버튼 복구 시 예외가 발생했습니다. `await` 전에 버튼 참조를 보관하도록 수정하고 실제 브라우저의 이벤트 수명과 같은 회귀 검사를 추가했습니다. |
| 보통 | `tests/signal_pipeline.integration.test.mjs` · `stop`, `sandbox` | Windows에서 신호로 종료한 자식 프로세스는 `exitCode`가 계속 `null`일 수 있어 종료 대기가 멈출 수 있었습니다. `signalCode`도 확인하고 타이머를 정리합니다. 가짜 캔들 시각은 재시작 전후 고정하고 실제 Windows 알림 전송은 임시 설정에서 끕니다. OPEN/CLOSE 이력 검증은 유지합니다. |
| 보통 | `scripts/check-market-data.mjs` | 문자열 상장 목록이 배열로 오인되어 예외가 발생하고, HTTP 200의 빈 응답을 네트워크 차단으로 잘못 분류했습니다. BTC 시세 누락도 잘못 통과할 수 있었습니다. 배열·시세 검증과 구조화된 실패 보고를 추가했습니다. 데이터 오류는 종료코드 1, 전송·HTTP 접근 실패는 2로 구분하며 가짜 응답 6개로 검사했습니다. |

기존의 **필수 8개 90점 + 기울기 가산점 10점** 정책은 유지했습니다. 점수가 높더라도 필수 유동성·손절·봉 신선도·양방향 호가·비용 반영 순손익비 등의 조건이 빠지면 최종 신호를 만들지 않습니다. 분석에는 확정 1H·4H를 사용하며 차트 선택은 1H·4H·1D를 유지합니다.

## 원래 변경된 33개 파일의 리뷰 범위

| 번호 | 파일 | 확인한 경로·판정 |
|---:|---|---|
| 1 | `FIX_VALIDATION_KO.md` | 기술 배점·임시 데이터·검증 한계와 코드 비교. 이전 테스트 수는 당시 결과로 명확히 표시. |
| 2 | `README.md` | 실행·테스트 명령, 현재 정책과 과거 이력 구분. 최신 재검증 문서 연결. |
| 3 | `data-cli.mjs` | 백업·복원 CLI 오류 반환과 실행 중 복원 거부. |
| 4 | `engine.mjs` | `normalizedKlines`, `validateKlineSeries`, `analyze`, `recentRange`: 확정봉·간격·OHLC·돌파 범위·양방향 패턴. |
| 5 | `execution.mjs` | `executionEstimate`, `riskSizedEstimate`: 양방향 호가·시세 시각·명목금액·비용·위험 한도. 잘못된 설정 차단 추가. |
| 6 | `markets.mjs` | `extractVariationalPerps`, `intersectPerpetualMarkets`: USDT 무기한 교집합·중복·별칭·TradFi 제외. |
| 7 | `package.json` | 외부 의존성 없는 `npm test`, 별도 `test:market`, Node.js 22 이상 요구. |
| 8 | `paper.mjs` | 등록→진입→40/35/25% 익절→손절/CLOSE, 저장 롤백·기간 PNL·재시작. 진입 직전 손실 상한과 구형 날짜 배정 보완. |
| 9 | `persistence.mjs` | 중앙 기록 우선, 원자적 저장·백업·복원 잠금·손상 원본 보존, 기록 자동 초기화 금지. |
| 10 | `public/app.js` | SSE/HTTP→현재 시세·최종 목록·상세·네 단계 집계, PC·모바일 공용 렌더. 캐시 만료 표시 보완. |
| 11 | `public/index.html` | 필수/가산점 표시, 진단·차트·TradFi·뉴스·알림 DOM 유지. |
| 12 | `public/styles.css` | 진단 영역의 PC·모바일 배치와 기존 반응형 규칙. |
| 13 | `public/trade_plan.js` | `entryAllowance`, `tradePlan`, `entryTiming`: 서버/브라우저 공용 진입 폭·가격 신선도·만료. |
| 14 | `quality.mjs` | `gradeSetup`: 9개 항목 배점, 필수/가산점 분리와 1H/4H 만료 시각. |
| 15 | `scan_diagnostics.mjs` | `describeScanFunnel`: 패턴·기술·거래소·최종 집계와 실제 최종 판정 일치. |
| 16 | `scripts/check-market-data.mjs` | 공개 GET 전용, 비밀값/사용자 기록 미사용, 실제 데이터 검사와 가상 테스트 분리. |
| 17 | `server.mjs` | REST/WS→분석→공용 판정→화면/SSE→가상 진입·저장·알림 전체 경로. 신규 진입 재검증·뉴스 저장 순서 보완. |
| 18 | `signal_pipeline.mjs` | `evaluateSignal`: 기술·공통 상장·호가·순손익비·현재 진입·분석 만료를 함께 판정. |
| 19 | `tests/candle_validation.test.mjs` | 누락·중복·미래·비정상 OHLC, 확정 시각 위조와 돌파 직전 봉 회귀. |
| 20 | `tests/execution.test.mjs` | 호가·가격 차이·비용·방향·미래 시각과 잘못된 제한 설정 회귀. |
| 21 | `tests/fixtures/pipeline_market.mjs` | 상승/하락·돌파/리테스트·횡보·거래량/유동성 부족 데이터 구성. |
| 22 | `tests/markets.test.mjs` | 정확한 공통 상장, SWAP/별칭/중복 모호성·TradFi 제외. |
| 23 | `tests/mock_pipeline.mjs` | 외부 목적지·쓰기 요청 차단, 1H/4H/1D만 허용, 임시 시계·고정 봉 시각. |
| 24 | `tests/mock_storage_failure.mjs` | 임시 저장 경로에만 장애 주입, 실제 파일·거래소 접촉 없음. |
| 25 | `tests/paper_accounting.test.mjs` | 비용·분할 청산·KST 경계·재시작·저장 실패·기존 기록 보존·진입 직전 상한. |
| 26 | `tests/persistence.test.mjs` | 임시 폴더의 실제 CLI 복원, 잠금·손상본·디스크 오류·500건 이상 기록 보존. |
| 27 | `tests/quality.test.mjs` | 양방향 90점 승인, 필수 조건 누락·오래된 4H 차단. |
| 28 | `tests/signal_pipeline.integration.test.mjs` | 실제 서버 HTTP/가짜 시세로 최종 LONG/SHORT·손익 저장·재시작·목록 밖 추적·대기 중 호가 만료. |
| 29 | `tests/signal_pipeline.test.mjs` | 90점 승인/필수 누락 95점 거부, 현재 가격·호가·분석·봉 만료와 진단 일치. |
| 30 | `tests/storage_failure.integration.test.mjs` | 저장 오류 HTTP 503, 설정·기존 PNL 롤백과 복구 후 저장. |
| 31 | `tests/ui_scan_state.test.mjs` | 최신 시세 보존·지연 틱 거부·네 단계 표시·상세 정리·현재 준비 목록 만료. |
| 32 | `tests/updater.test.mjs` | SHA 검증·필수 모듈 적용, 사용자 설정·현재/백업 기록 보존. |
| 33 | `updater.mjs` | 런타임·알림 파일 허용 목록, HTTPS/동일 출처·해시·사용자 파일 제외 유지. |

## 통합 검증과 결과

| 실행 환경·명령 | 결과 |
|---|---|
| Linux · Node.js 24.19.0 · `npm test` | **191개 통과**, 실패·건너뜀·취소 0개, 약 14.08초 |
| Linux · Node.js 22.23.3 · `node --test 'tests/*.test.mjs'` | **191개 통과**, 실패·건너뜀·취소 0개, 약 13.95초. 셸 확장 없이 glob 인자를 직접 전달해 Windows cmd에 필요한 Node 자체 파일 검색도 확인. |
| 실제 공개 시장 · `npm run test:market` | **실패, 종료코드 2 (`blocked`)**. Binance DNS `EAI_AGAIN` 및 제한시간 초과, Variational 제한시간 초과. |

기존 PR의 175개에서 회귀 검사 16개가 늘었습니다. 전체 검사는 외부 fetch/WS를 차단한 부모 실행과 가짜 거래소 자식 서버를 사용했습니다. 테스트 대상은 사용자 파일이 아닌 임시 데이터입니다. 로컬 두 Node 버전의 성공을 실제 Windows OS 성공으로 해석하지 않아야 합니다.

Chromium에서 최신 소스를 별도 임시 앱으로 실행해 다음을 확인했습니다. 수동 분석으로 자동 등록 문제를 우회하지 않았습니다.

| 브라우저 항목 | PC | 모바일 |
|---|---:|---:|
| 화면 너비 / 문서 너비 | 1440 / 1440px | 390 / 390px |
| JavaScript 예외 / 가로 넘침 | 0 / 없음 | 0 / 없음 |
| 자동 기동 후 패턴→기술→거래소→최종 각 1종·모의 OPEN | 통과 | 통과 |
| 선택 분석 버튼 클릭 후 복구·준비 목록·상세 | 통과 | 통과 |
| 1H·4H·1D, TradingView/Variational 링크, TradFi·뉴스·모의 패널 | 통과 | 통과 |

최초 브라우저 검사는 자동 OPEN 대기 시간 초과와 선택 분석 버튼의 JavaScript 예외로 실패했습니다. 위에서 설명한 기동 순서·버튼 참조 오류를 수정한 뒤 같은 흐름을 재실행해 통과했습니다. 기존 코드에서 실패하도록 의도한 회귀 확인과 실제 수정 후 성공을 구분했습니다.

다음은 **가상 데이터 테스트**입니다. 실제 서버를 임시 앱에서 실행하고 Binance/Variational 전송을 가짜 읽기 응답으로 교체했습니다.

- 확정 1H 패턴과 4H 추세로 LONG·SHORT 돌파 및 양방향 리테스트를 최종 신호까지 연결했습니다.
- 기울기 가산점이 없는 90점도 승인하고 횡보·거래량 부족·필수 유동성 부족·거래소 호가 누락은 거부했습니다.
- 최종 LONG→다음 틱 가상 진입→TP1→서버 재시작→TP2·TP3→CLOSE→양수 PNL 저장을 확인했습니다.
- SHORT→가상 진입→손절→CLOSE→음수 PNL 저장을 확인했습니다. 수수료·슬리피지와 OPEN/CLOSE 이력, 재시작 후 중복 방지도 검사했습니다.
- 스캔·교집합·연구 목록 밖에 있는 기존 포지션도 손절까지 추적했습니다. 신규 대기 진입은 현재 검증을 다시 요구했습니다.
- 분석이 첫 실시간 시세보다 먼저 끝나도 추가 수동 분석 없이 최종 신호→대기 등록→후속 틱 진입이 연결되고 알림이 중복되지 않는지 검사했습니다.
- 저장 실패는 성공으로 처리하지 않으며 포지션·설정·PNL·알림 상태가 되돌아갑니다. 정상 백업 복원·손상 원본 보존·실행 중 복원 차단도 검사했습니다.

**실제 거래소 데이터 검사**는 `npm run test:market`로 분리합니다. 공개 REST GET만 사용합니다. 이번 재실행도 위의 연결 오류로 실패했으므로 실제 거래소의 현재 최종 신호 발생은 확인했다고 주장하지 않습니다. 이 검사는 공개 WebSocket·실제 계정 주문을 검증하지 않습니다.

## 자동 검사와 PR 보고

`.github/workflows/node-tests.yml`에 Node.js 22/24 × Ubuntu/Windows 네 조합을 추가했습니다. 실패는 그대로 실패 검사로 표시하며, 임시 데이터 폴더·빈 외부 자격증명·자동 업데이트 비활성화를 사용합니다. 프로젝트에는 설치할 외부 의존성이나 lockfile이 없습니다.

공식 배포 해시를 확인한 `actionlint`와 YAML 구조 검사가 통과했습니다. 처음에는 `runner.temp`를 job 환경변수에 넣어 lint가 실패했고, 올바른 step 범위로 옮겨 해결했습니다. PR 댓글 처리의 성공·실패·취소·건너뜀, 기존 댓글·사용자 댓글 보호·이전 커밋 보호를 포함한 16개 모사 검사도 통과했습니다.

테스트 job은 읽기 권한만 사용합니다. 별도 보고 job만 PR 댓글 권한을 가지며 같은 저장소의 PR #1에 한정됩니다. 프로젝트 코드를 실행하지 않고 이 문서를 읽어 실제 검사 결과·실행 URL·커밋과 함께 댓글을 생성/갱신합니다. PR의 최신 커밋이 달라졌으면 이전 실행은 댓글을 덮어쓰지 않습니다.

이 클라우드의 GitHub API 요청은 HTTP 403으로 차단되어 호스팅된 검사·댓글 결과를 직접 확인할 수 없었습니다. 아래에 자동으로 추가되는 Actions 결과를 최종 기준으로 확인해야 합니다. 로컬 Linux 통과를 Windows 실행 성공으로 표현하지 않았습니다.

## 기록 보호와 남은 확인 범위

실제 Binance/Variational 주문은 실행하지 않았습니다. 기존 Windows `%LOCALAPPDATA%\SignalLab`의 PNL·설정 파일은 읽거나 변경하지 않았습니다. 테스트 데이터·장애 주입·백업/복원은 모두 별도 임시 폴더에서 수행했습니다. 비밀키·토큰 값은 출력하지 않았습니다.

Windows 알림의 OPEN/CLOSE 호출 경로와 이력 검사는 유지했습니다. Linux 클라우드에서는 Windows 풍선 알림의 실제 노출을 검증할 수 없습니다. 브라우저 검사는 Chromium의 PC·모바일 화면 크기이며 실제 휴대폰 OS나 외부 TradingView 서비스의 정상 응답을 보장하지 않습니다. 신호 빈도·수익률·실제 체결 품질에 대한 보장도 아닙니다.
