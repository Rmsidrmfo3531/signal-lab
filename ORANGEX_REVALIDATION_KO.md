> 과거 개발 단계의 검증 이력입니다. 현재 버전은 Binance 단일 분석이며 이전 공급자 연결·설정·링크는 제거됐습니다. 대체 공급자가 없는 TradFi 수집·신규 신호·신규 모의 진입은 비활성입니다. 아래의 과거 기능 설명을 현재 사용 안내로 적용하지 마세요. 기존 PNL·포지션·설정·백업은 보존합니다.

# OrangeX 실제 연결 재검증

기준은 `Rmsidrmfo3531/signal-lab`의 `feat/orangex-readonly`, 커밋 `894300a`입니다. 2026년 10월 27일 한국 시간에 확인했습니다. 최초 보고서 `ORANGEX_READONLY_KO.md`와 현재 네트워크 정책을 먼저 읽었습니다.

**실제 OrangeX 서버 연결은 확인하지 못했습니다.** READ_ONLY를 유지했으며 실제 주문·취소·출금·비공개 계좌 요청은 전송하지 않았습니다. 공식 문서·실제 상장·호가를 확인한 것으로 표시하지 않습니다.

## 접속 계층별 관측

실행 환경의 현재 정책은 `observations_current:true`, `state:enforced`, `restricted`입니다. `openapi-docs.orangex.com`, `api.orangex.com`, `api.github.com`은 현재 허용 목록에 없습니다. 저장된 설정 초안과 실제 적용된 정책은 다릅니다.

| 대상 | 프록시 CONNECT | OrangeX/문서 서버 HTTP | 판정 |
|---|---:|---|---|
| `https://openapi-docs.orangex.com/` | 403 | 응답 없음 | 문서 서버에 도달하기 전 프록시 거부 |
| BTC 공개 호가 요청 | 403 | 응답 없음 | 프록시 거부 |
| ETH 공개 호가 요청 | 403 | 응답 없음 | 프록시 거부 |
| SOL 공개 호가 요청 | 403 | 응답 없음 | 프록시 거부 |

curl 종료코드는 네 요청 모두 56이었습니다. 원 서버 HTTP 상태는 `null`이며, 원 서버와의 TLS 핸드셰이크·인증서 결과도 관측하지 못했습니다. `CONNECT 403`을 OrangeX의 HTTP 403이나 TLS 인증서 오류로 바꾸어 해석하지 않습니다.

원본 요청 URL·시각·종목별 진단은 [연결 점검 JSON](reports/orangex-revalidation-connectivity.json)에 있습니다. 인증 헤더·키·토큰은 포함하지 않습니다. 재현 예시는 다음과 같습니다. 호스트·프록시 설정을 우회하거나 TLS 검증을 끄지 않습니다.

```bash
curl --silent --show-error --proto '=https' --max-time 12 \
  --output orangex-public-body.json \
  --write-out 'proxy_connect=%{http_connect} origin_http=%{http_code}\n' \
  'https://api.orangex.com/api/v1/public/get_order_book?instrument_name=BTC-USDT-PERPETUAL&depth=20'
```

## `npm run test:orangex` 실제 결과

명령을 실행했으며 **종료코드 2, `transport_error`**입니다. 이 명령의 Node 클라이언트가 관측한 오류와 앞의 프록시 CONNECT 증거를 구분합니다. Node 오류만으로 프록시 거부나 거래소 장애를 단정하지 않습니다.

| 요청 후보 | Node 관측 오류 | 실제 상장·계약명 | Bid/Ask·스프레드 | 시각·신선도 |
|---|---|---|---|---|
| `BTC-USDT-PERPETUAL` | DNS · `EAI_AGAIN` | 미검증 | 미관측 | 미관측 |
| `ETH-USDT-PERPETUAL` | `REQUEST_TIMEOUT` | 미검증 | 미관측 | 미관측 |
| `SOL-USDT-PERPETUAL` | `REQUEST_TIMEOUT` | 미검증 | 미관측 | 미관측 |

이 이름들은 기존 SDK에서 유래한 요청 후보이며 실제 상장 목록에서 검증한 이름이 아닙니다. 실패를 상장 폐지나 거래 불가의 확정 증거로 사용하지 않습니다. 원 서버 HTTP 상태는 세 종목 모두 `null`입니다. [실제 공개 조회 JSON](reports/orangex-revalidation-public.json)에 실행 결과를 보존했습니다.

## 공식 명세 확인

공식 문서 본문을 읽을 수 없어 엔드포인트·인증·계약명·응답 구조의 공식 명세 일치를 확인하지 못했습니다. SDK와 공식 명세 사이에 차이가 있다고 결론 내릴 근거도 없습니다. 따라서 API 경로·인증 방식·상장 매핑을 추측해서 변경하지 않았습니다.

기존 `verification.officialSpec:UNVERIFIED`, 상장·주문 단위 미검증, 실제 인증·계좌 조회 차단을 유지합니다. Mock에서 검사한 DNS/TLS/HTTP/스키마 사례는 진단 코드의 회귀 검사이며 실제 OrangeX가 그 응답을 반환했다는 뜻이 아닙니다.

## 확인된 코드 오류와 수정

| 파일 | 기존 문제 | 수정 |
|---|---|---|
| `orangex.mjs` | `NETWORK_ERROR`가 원래 DNS·TLS 원인을 감추고 HTTP 상태를 버림 | 허용 목록의 `transportCode`, 숫자 `httpStatus`, `category`, `responseSource`를 기록. HTTP 200 뒤 스키마 오류와 본문 읽기 오류도 구분 |
| 같은 파일의 상태 표시 | 조회 실패만으로 `BLOCKED`를 표시 | 근거가 없는 프록시 차단 판정 대신 `FAILED` 표시. 자세한 원인은 오류 메타데이터로 제공 |
| `scripts/check-orangex-readonly.mjs` | 종목별 실패 수치가 빠지고 HTTP 오류·스키마 실패도 단순 차단으로 보일 수 있음 | BTC/ETH/SOL별 요청·실패·호가·시각·상장 미검증 상태를 기록. `transport_error`, `http_error`, `schema_error`, `partial`, `stale_data`를 분리 |
| 새 회귀 검사 | 원인·상태 손실과 부분 성공의 오판을 검사하지 못함 | 어댑터 회귀 6개와 공개 점검 보고 회귀 5개 추가. 기존 235개 유지 |

오류 원문·요청 URL·응답 본문·헤더는 어댑터 오류로 전달하지 않습니다. 미등록 오류 코드는 출력하지 않고, HTTP 403만으로 응답 발생원이 프록시인지 거래소인지 확정하지 않습니다. 실제 성공 호가가 없는 종목에는 가격·시각을 만들어 넣지 않습니다.

Binance·이전 공급자 분석, 시그널 조건, 모의매매, PNL, 기존 저장·백업·텔레그램 및 PC·모바일 구성은 수정하지 않았습니다. OrangeX 공개 연결과 기존 분석은 분리되어 있습니다.

## 회귀·화면·Actions

| 검사 | 결과 |
|---|---|
| Linux · Node.js 24.19.0 전체 | **246개 통과**, 실패·건너뜀·취소 0개, 약 14.69초 |
| Linux · Node.js 22.23.3 전체 | **246개 통과**, 실패·건너뜀·취소 0개, 약 14.51초 |
| 기존 235개 | 모두 포함해 통과. 테스트 제외·기대값 완화 없음 |
| 신규 11개 | DNS·TLS·HTTP·스키마·비밀값 제거·종목별 부분 실패와 종료코드 검증 |
| Chromium PC·모바일 | 1440·390·360·720px 모두 통과, JavaScript 오류·가로 넘침 0. GET 전용·강제 503 후 이전 자료 표시와 갱신 복구 확인 |
| 실제 공개 데이터 | 실패, 종료코드 2. 관측 호가 0개 |
| GitHub Actions 실제 결과 | `gh run list`의 `api.github.com` 요청이 `Forbidden`으로 차단되어 미확인 |

자동 검사는 임시 데이터·빈 자격증명·외부 통신 차단을 사용했습니다. 브라우저 검사는 실제 서버와 Mock 거래소 전송으로 수행했고, 외부 폰트·TradingView 요청은 차단했습니다. 실제 OrangeX 연결, Windows OS, 실기기 휴대폰의 성공을 의미하지 않습니다.

Actions 설정의 Ubuntu/Windows × Node.js 22/24 네 조합과 기능 브랜치 Push 트리거는 확인했습니다. 설정이 있다는 사실을 실제 네 작업이 통과했다는 증거로 사용하지 않습니다. 실제 계정 PNL·가상 포지션·백업이나 `%LOCALAPPDATA%\SignalLab`을 수정하지 않았습니다.

## 해결에 필요한 설정과 PAPER 진행 판단

환경 설정 초안에 기존 OrangeX 두 호스트를 보존하고 `api.github.com`을 추가했습니다. 세 호스트를 검토·저장 후 환경을 게시하고, 적용된 정책의 `state:enforced` 및 실제 허용 여부를 다시 확인해야 합니다. 초안 저장 자체는 런타임 반영이 아닙니다. 키를 채팅이나 Git에 제공할 필요는 없습니다.

[클라우드 실행 환경 스킬](skill://plugin_connector_1p_c5b7d5df5d7081918f2c4be5a633ed5d/cloud-environment-runtime/SKILL.md)의 네트워크 지침은 “An explicit destination-policy denial requires the supported configuration workflow; do not bypass the proxy to reach a blocked destination.”라고 명시합니다. 사용자 제한과 이 지침에 따라 우회하지 않았습니다.

**실제 데이터 기반 2단계 PAPER 운영·성과 검증은 보류합니다.** 공식 상장·계약 단위·호가 시각·수수료·펀딩 명세와 실제 응답을 확인한 뒤 진행해야 합니다. 격리된 설계·Mock 검사만으로 실제 연동 준비가 끝났다고 판단하면 안 됩니다. PAPER·LIVE는 활성화하지 않았고 실제 주문·취소·출금·main 수정·병합도 하지 않았습니다.
