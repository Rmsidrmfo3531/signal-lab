# OrangeX 1단계: 조회 전용 연결과 검증 기록

후속 실제 연결 재검증과 진단 오류 수정 결과는 [OrangeX 재검증 보고서](ORANGEX_REVALIDATION_KO.md)를 참고하세요. 아래의 235개 테스트는 최초 커밋 `894300a` 당시 기록입니다.

`3e51027` 이후 정책 적용 확인과 공개 API 재시도는 [최근 재시도 보고서](ORANGEX_PUBLIC_RETRY_KO.md), Windows에서의 독립 실행은 [공개 API 진단 안내](ORANGEX_WINDOWS_PUBLIC_DIAGNOSTIC_KO.md)를 참고하세요. 과거 보고서의 관측과 이번 결과는 구분합니다.

## 이번 구현의 범위

대상은 `Rmsidrmfo3531/signal-lab`입니다. `feat/orangex-readonly`는 원격의 최신 기능 브랜치 `fix/paper-no-fixed-capital` 커밋 `a78da08`에서 분리했습니다. `main`과 기존 PR 브랜치를 수정·병합하지 않았습니다. 이전 작업 폴더의 미완료 연구 변경도 별도로 보존했습니다.

구현한 것은 OrangeX 조회 어댑터, 조회 전용 서버 API, PC·모바일 OrangeX 화면, 환경변수 샘플과 Mock 검증입니다. **공식 문서와 실제 응답에 대한 외부 검증은 현재 환경의 접속 제한으로 완료하지 못했습니다.** 확인하지 못한 조회와 거래 기능을 동작한다고 표시하지 않습니다.

현재 단계에는 주문·취소·레버리지 변경·이체·출금 메서드가 없습니다. `PAPER`·`LIVE`는 설정해도 활성화되지 않으며 잘못된 모드는 OrangeX 연결만 비활성화합니다. 기존 서버·스캐너는 계속 실행됩니다. API 키의 존재도 모드를 바꾸지 않습니다.

## API 근거와 연결 결과

사용자가 지정한 공식 문서는 <https://openapi-docs.orangex.com/>입니다. 이 호스트와 `api.orangex.com`은 클라우드의 현재 허용 도메인 목록에 없습니다. 두 요청 모두 **클라우드 프록시 CONNECT 403**으로 목적지에 도달하지 못했습니다. OrangeX 자체의 장애나 계정 권한 거부로 해석하지 않습니다.

두 도메인을 허용하는 환경 설정 초안은 저장했습니다. 아직 실행 환경에 적용된 것은 아닙니다. 환경 설정에서 검토·저장한 후 환경을 게시해야 합니다. [클라우드 실행 환경 스킬](skill://plugin_connector_1p_c5b7d5df5d7081918f2c4be5a633ed5d/cloud-environment-runtime/SKILL.md)의 네트워크 지침은 “An explicit destination-policy denial requires the supported configuration workflow; do not bypass the proxy to reach a blocked destination.”라고 명시합니다. 이 제한을 우회하지 않았으며, 허용 후 공식 문서와 실제 응답을 다시 확인해야 합니다.

보조 참고 자료는 공개 GitHub 저장소 [OrangeX-Global/orangex-api-python](https://github.com/OrangeX-Global/orangex-api-python/tree/b6aece329906fa651249bc919a5ec6391abd881e)의 커밋 `b6aece329906fa651249bc919a5ec6391abd881e`입니다. SDK 소스를 읽었으며 주문·출금 예제는 실행하지 않았습니다. **계정 이름만으로 공식 소유권을 확인한 것은 아닙니다.** 이 자료는 공식 문서 검증의 대체물이 아닙니다.

| 기능 | 소스에서 관찰한 내용 | 이번 운영 상태 |
|---|---|---|
| 공개 호가 | `urls.py`, `websocket_client.py`: `https://api.orangex.com/api/v1/public/get_order_book`, GET, `instrument_name`·`depth`; `result.bids/asks`, `timestamp`, `version` | 명시적으로 연결을 켰을 때 읽기 요청만 시도. 응답은 엄격히 검사하나 실제 OrangeX 응답 검증은 미완료 |
| 최초 OAuth 인증 | `rest_auth_test.py`: `/public/auth`, GET, `client_credentials` | 공식 명세 검증 전 운영 호출 차단. Mock으로만 요청·토큰 관리 검사 |
| 토큰 갱신 | 같은 소스: `/public/auth`, POST JSON-RPC 2.0, `grant_type=refresh_token` | 공식 명세 검증 전 운영 호출 차단. Mock으로만 갱신·동시 호출·오류 검사 |
| 인증 결과 | `result.access_token`, `expires_in`; SDK의 Bearer 사용 | 토큰은 비공개 메모리만 사용. 상태·예외·브라우저·파일로 반환하지 않음 |
| 무기한 선물 상장 목록 | 확인 가능한 정확한 명세 없음 | 조회 경로를 추측하지 않고 미검증 오류 반환, 외부 요청 없음 |
| 잔고·포지션·미체결·체결 내역 | 확인 가능한 정확한 명세 없음 | 미검증 차단, 계좌 자료 `null`. 미조회 잔고·PNL을 0으로 만들지 않음 |
| 최소 수량·수량 단위·가격 단위 | 확인 가능한 정확한 명세 없음 | `null`·미검증 표시, 주문 가능 여부 승인 없음 |
| 수수료·펀딩 | 확인 가능한 정확한 명세 없음 | 비용 0이나 임의 요율로 대체하지 않음. 관측 bid/ask 스프레드만 계산 |
| 요청 제한 | 공식 요청 수 한도 미확인 | 클라이언트 최소 간격·제한된 429/5xx 재시도·Retry-After 상한·타임아웃 구현. 거래소 한도를 충족한다고 주장하지 않음 |
| WebSocket | SDK에 주소는 있으나 이번 단계에서는 연결하지 않음 | HTTP 조회만 구현. 주문용 WS 없음 |

BTC·ETH·SOL 계약 이름은 **조회 요청 후보**입니다. 실제 상장과 Binance 교집합, 가격 단위·주문 지원이 확인되지 않았으므로 `tradable:false`, `orderSubmissionEnabled:false`를 유지합니다. 계약 통화를 USDT로 강제 치환하지 않습니다. Mark Price가 없으면 midpoint를 Mark로 꾸미지 않고 `markPrice:null`로 표시합니다.

## 설정과 실행

Node.js 22 이상에서 기존 `start.bat`, `start_mobile.bat`, `npm start`를 유지합니다. [.env.orangex.example](.env.orangex.example)의 필요한 줄만 기존 `.env`에 추가하세요. 기존 파일 전체를 샘플로 덮어쓰지 마세요.

```dotenv
ORANGEX_ENABLED=false
ORANGEX_MODE=READ_ONLY
ORANGEX_INSTRUMENTS=BTC-USDT-PERPETUAL,ETH-USDT-PERPETUAL,SOL-USDT-PERPETUAL
ORANGEX_REQUEST_TIMEOUT_MS=8000
ORANGEX_CLIENT_ID=
ORANGEX_CLIENT_SECRET=
```

`ORANGEX_ENABLED=true`는 공개 조회 시도를 켜는 설정이며 자동매매를 켜지 않습니다. 공식 명세 미검증 상태에서는 자격증명이 있어도 비공개 인증·계좌 요청을 하지 않습니다. 코드 수준의 인증 계약 주입은 격리된 Mock 검증용이며 `.env`나 브라우저에 우회 스위치를 제공하지 않습니다.

키를 추가하는 후속 단계에서도 조회 권한만 사용하고 출금·거래 권한은 부여하지 마세요. 키나 토큰을 채팅, 스크린샷, Git 또는 브라우저에 넣지 마세요.

OrangeX 탭은 기존 서버의 `GET /api/orangex`로 조회합니다. `?refresh=1`은 동일한 공개 조회를 갱신합니다. 기본 연결 OFF에서는 외부 요청이 없습니다. OrangeX 경로의 비 GET 요청은 405이며 주문 경로는 없습니다. 조회는 캐시·동시 요청 병합을 사용합니다.

연결을 별도로 점검하려면 다음을 실행합니다. 이 명령은 `.env`·사용자 기록·계좌 키를 읽지 않고 공개 호가만 요청합니다.

```bash
npm run test:orangex
```

종료코드 0도 공개 호가 관측을 뜻하며 주문·계좌·공식 명세 검증을 뜻하지 않습니다. 전송 차단은 2, 응답 구조·시세 신선도 검증 실패는 1입니다. 일반 자동 테스트에는 이 실제 네트워크 검사가 포함되지 않습니다.

## 기존 기능과 기록의 보존

- `engine.mjs`·`quality.mjs`·`signal_pipeline.mjs`의 확정 1H·4H 분석과 기존 최종 판정을 그대로 사용합니다. OrangeX가 기존 최종 신호를 승인하거나 모의 진입을 발생시키는 연결은 추가하지 않았습니다.
- `execution.mjs`·`markets.mjs`의 기존 Binance×Variational 교집합과 호가 검증은 그대로입니다. 검증되지 않은 OrangeX 종목을 교집합에 추가하지 않습니다.
- `paper.mjs`·`signal_lifecycle.mjs`·`public/trade_plan.js`의 기존 모의 진입·40/35/25% 익절·손절·CLOSE·PNL 계산을 유지합니다. 최신 기준 브랜치의 명목금액 $500·가정 자본 미설정도 유지합니다.
- `persistence.mjs`와 중앙 `store.json`, 백업·복원 경로는 변경하지 않습니다. OrangeX 조회 상태는 별도 메모리에만 있으며 기존 PNL·포지션·설정에 저장하거나 합산하지 않습니다.
- 텔레그램, Windows 모의 OPEN/CLOSE 알림, TradingView, TradFi, 뉴스, LONG/SHORT 진입 참고 카드와 기존 PC·모바일 화면을 유지합니다.

기준 코드는 이미 **필수 8개 90점 + EMA 기울기 가산점 10점**입니다. 현재 판정을 100점 필수라고 표현하는 과거 설명과 구분해야 합니다. 점수는 승률이 아닙니다. 최종 신호 0건은 패턴·기술·상장·호가·진입 구간 중 어느 단계에서도 발생할 수 있습니다.

추가로 기존 `engine.levels()`가 과거 지지 피벗을 현재가 위라는 이유로 저항 배열에 넣는 사례를 합성 데이터로 재현했습니다. 실제 ARBUSDT 데이터에 대한 단정은 하지 않습니다. 이번 단계의 조회 전용 범위에서 기술 조건을 완화하거나 이전 미완료 연구 수정을 섞지 않았으며 별도 수정 검토 대상으로 남깁니다.

## 생성·수정 파일

| 구분 | 파일 |
|---|---|
| 조회 어댑터·연결 점검 신규 | `orangex.mjs`, `scripts/check-orangex-readonly.mjs` |
| 화면 신규 | `public/orangex.js` |
| 설정·보고서 신규 | `.env.orangex.example`, `ORANGEX_READONLY_KO.md` |
| 신규 Mock·단위·HTTP·UI 검사 | `tests/mock_orangex_readonly.mjs`, `tests/orangex.test.mjs`, `tests/orangex_server.integration.test.mjs`, `tests/orangex_ui.test.mjs` |
| 기존 연결부 수정 | `server.mjs`, `public/index.html`, `public/styles.css`, `updater.mjs` |
| 명령·문서·CI 수정 | `package.json`, `README.md`, `.github/workflows/node-tests.yml` |
| 기존 기대값 오류 보완 | `tests/paper_accounting.test.mjs`, `tests/paper_server.test.mjs` |

## 테스트 기록

기준 `a78da08`의 기존 테스트는 **200개 중 198개 통과·2개 실패**였습니다. 두 실패는 이미 변경된 고정 명목금액·가정 자본 제거에 맞지 않는 기대값이었습니다.

`paper_accounting.test.mjs`는 실제 고정 $500 수량·수수료·슬리피지로 일별·누적 손익을 독립 계산하도록 보완했고, `paper_server.test.mjs`는 가정 자본과 계좌 평가액 `null`, 기존 PNL `6.7`, 명목금액 `500`을 검사합니다. 테스트 제외·기능 기대값 완화로 통과시키지 않았습니다.

최종 결과는 다음과 같습니다. Mock의 API 성공을 실제 OrangeX 연결 성공으로 표현하지 않습니다. 모든 서버 검사는 임시 앱·임시 데이터로 실행하며 실제 `%LOCALAPPDATA%\SignalLab` 기록에는 접근하지 않습니다.

| 검사 | 결과 |
|---|---|
| Linux · Node.js 24.19.0 · 전체 자동 테스트 | **235개 통과**, 실패·건너뜀·취소 0개, 약 14.62초 |
| Linux · Node.js 22.23.3 · 전체 자동 테스트 | **235개 통과**, 실패·건너뜀·취소 0개, 약 14.36초. 리터럴 glob 인자를 직접 전달 |
| OrangeX 신규 검사 | 어댑터 23개 + HTTP 통합 4개 + UI 8개 = **35개** |
| Chromium PC·모바일 | 1440·390·360·720px 모두 예외 0·가로 넘침 0. GET 전용, 이전 조회 실패 상태와 갱신 복구 확인 |
| 실제 공개 조회 · `npm run test:orangex` | **실패, 종료코드 2**. BTC·SOL 연결 오류, ETH 타임아웃. 실제 관측 호가 0개 |
| 직접 공식 문서·공개 API 접속 | 클라우드 프록시 CONNECT 403, 실제 목적지 응답 미확인 |
| GitHub Actions 설정 | Node.js 22/24 × Ubuntu/Windows 네 조합 유지, 기능 브랜치 Push 트리거 추가. YAML·행렬 검증 통과. 호스팅된 Windows 실행 성공은 로컬에서 확인하지 않음 |

기존 LONG 분할 익절·재시작·CLOSE·PNL 저장, SHORT 손절·손실 저장과 백업·복원·저장 실패·기록 보존 검사가 전체 테스트에 포함됩니다. Windows 실기기·알림 풍선·휴대폰 OS를 검증한 결과는 아닙니다. 외부 TradingView·폰트 요청은 브라우저 검사에서 의도적으로 차단했습니다.

개발 중 UI 테스트의 RegExp 인자 실수를 고쳤고, 독립 안전 리뷰에서 발견한 긴 Retry-After 조기 재시도와 배열을 0으로 표시할 수 있는 숫자 변환도 회귀 검사와 함께 수정했습니다. 실제 네트워크 검사 실패는 자동 테스트 통과 수와 분리했습니다.

## 후속 단계 설계

### 2단계: 별도 OrangeX PAPER

공식 상장·호가·단위·수수료·펀딩 명세와 실제 읽기 응답부터 검증합니다. 그 뒤 기존 분석 결과를 별도의 OrangeX 최종 검증기로 넘깁니다. Binance와 OrangeX의 같은 기초자산·결제 통화·계약 크기를 확인하고 가격 차이·호가 시각·시그널 나이·손절 무효화·기존 보유 상태를 검사합니다.

기존 모의 기록과 다른 파일·잠금·백업을 사용하는 `PAPER` 계정을 설계합니다. 위험 한도에 맞게 수량을 아래로 절삭하고 최소 수량과 충돌하면 진입을 거부합니다. 수수료·슬리피지·펀딩·갭을 분리 기록하고 순방향 데이터만 사용합니다. LONG·SHORT, TP1/2/3, STOP, 부분 체결 모델, 재시작·저장 장애·기록 보존을 검증한 후 장기 모의 성과를 수집합니다.

### 3단계: OrangeXExecutionEngine와 LIVE 승인

별도 엔진의 상태를 `신호 검증 → 주문 의도 저장 → 제출 → 접수 → 부분 체결/체결 → 보호 주문 확인 → 청산 → 정산`으로 분리합니다. 요청 성공은 체결이 아닙니다. 타임아웃·접속 장애는 `상태 불명`으로 두고 거래소 조회와 동기화 전에는 재전송하지 않습니다. 거래소가 지원하는 주문 식별자·조회·중복 방지 기능을 확인한 뒤 설계하며 지원을 추정하지 않습니다.

시장가·지정가, reduce-only, 격리/교차·레버리지, 거래소 보호성 손절, 40/35/25% 청산의 실제 지원을 확인해야 합니다. 보호 손절을 거래소에 확실히 보장할 수 없다면 LIVE 진입을 차단합니다. 재시작 시 잔고·포지션·미체결·체결을 맞추고 불일치·잔고 부족·API 장애에서는 신규 주문을 멈춥니다. 기존 포지션 관리는 별도로 지속합니다.

LIVE는 명시적 설정·거래 권한·사전 안전 점검·별도 승인 모두가 필요합니다. 일간 손실·포지션 수·총 노출 상한과 Kill Switch를 먼저 검증하고, 허가된 별도 소액 검증 전에는 활성화하지 않습니다. 출금 권한은 사용하지 않습니다.

### 4단계: Windows 지속 운영

기존 Windows supervisor와 안전 종료·자동 재시작을 재사용합니다. 단일 프로세스 잠금, 절전·네트워크 단절·시간 오차·로그 보존·디스크 부족·백업 복구를 검증합니다. 서버 이전은 기록을 복사·검증한 뒤 진행하며 기존 기록을 초기화하지 않습니다. 체결·보호 주문 실패·동기화 불일치·자동 중지에 대한 텔레그램 알림은 이 단계에서 추가합니다.

## 2단계를 위한 다음 Codex 지시문

> `Rmsidrmfo3531/signal-lab`의 `feat/orangex-readonly`를 기준으로 OrangeX 2단계 PAPER만 구현하라. 먼저 `ORANGEX_READONLY_KO.md`를 읽고 공식 문서·실제 공개 응답·조회 전용 계좌 권한을 검증하라. 미검증 API·단위·수수료·펀딩은 추정하지 말고 필요한 기능을 차단하라. 기존 Binance/Variational 분석·PNL·가상 포지션·설정·백업을 보존하라. OrangeX PAPER는 별도 파일과 잠금·백업에 저장하고 기존 계정과 합산하지 마라. 실제 과거/순방향 데이터와 합성 데이터를 구분하여 LONG/SHORT 진입, 비용, 40/35/25% 익절, STOP, CLOSE, PNL, 재시작·저장 실패를 검증하라. UI에 단계별 거부 사유와 실제 검증 상태를 표시하라. 실제 주문·출금·LIVE 활성화·main 직접 수정·Merge는 하지 마라. 공식 명세의 누락과 테스트 실패를 숨기지 말고 한국어로 보고하라.
