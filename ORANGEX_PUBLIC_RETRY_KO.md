# OrangeX 공개 API 재시도와 Windows 진단

기준: `Rmsidrmfo3531/signal-lab`, `feat/orangex-readonly`, `3e51027`. 2026년 10월 27일에 확인했습니다. 기존 `ORANGEX_READONLY_KO.md`와 `ORANGEX_REVALIDATION_KO.md`를 먼저 읽었습니다.

**이번에도 실제 OrangeX 서버 연결은 확인하지 못했습니다.** 클라우드의 인터넷 허용 정책이 아직 적용되지 않았습니다. 우회하지 않고 Windows에서 키 없이 실행하는 공개 API 전용 진단 도구를 추가했습니다.

## 실제 적용 정책과 연결

`environment_status`의 현재 관측은 `observations_current:true`, `network_policy.state:enforced`, `restricted`이며 OrangeX 두 호스트가 유효 허용 목록에 없습니다. 실행 환경의 `/etc/codex/network-policy.json`도 같은 상태입니다. 설정 초안을 저장한 것과 실행 중인 환경에 게시·적용한 것은 다릅니다.

| 실제 요청 | 프록시 CONNECT | 원 서버 HTTP | curl 종료코드 |
|---|---:|---|---:|
| 공식 문서 루트 | 403 | 미관측 | 56 |
| `/public/get_instruments` | 403 | 미관측 | 56 |
| `/public/tickers` | 403 | 미관측 | 56 |
| BTC·ETH·SOL `/public/get_order_book` 각각 | 403 | 미관측 | 56 |

프록시가 연결을 거부했으므로 OrangeX의 HTTP 403으로 보고하지 않습니다. 원 서버의 TLS 연결·인증서·응답 스키마도 관측하지 못했습니다. [시각·URL·오류 계층별 진단](reports/orangex-public-retry-connectivity.json)을 보존했습니다. 이 요청은 상속된 프록시와 TLS 검증을 유지하고 인증 없이 수행했습니다.

`npm run test:orangex`를 실제 재실행한 결과는 **종료코드 2, `transport_error`**입니다.

| 후보 계약 | 기존 Node 클라이언트 관측 | 상장·계약 규격 | 호가·Mark·최소 주문량·수수료 |
|---|---|---|---|
| `BTC-USDT-PERPETUAL` | DNS `EAI_AGAIN` | 미검증 | 미관측 |
| `ETH-USDT-PERPETUAL` | `REQUEST_TIMEOUT` | 미검증 | 미관측 |
| `SOL-USDT-PERPETUAL` | DNS `EAI_AGAIN` | 미검증 | 미관측 |

Node 클라이언트의 DNS·타임아웃 관측과, curl의 프록시 CONNECT 증거는 다른 결과입니다. 전자만으로 프록시 정책 차단이나 OrangeX DNS 장애를 단정하지 않습니다. 세 종목 모두 HTTP 상태·가격·시각은 `null`, `fresh:false`, 실제 호가 관측은 0개였습니다.

## 공식 명세 대조 상태

사용자가 공식 문서에서 확인한 `/public/get_order_book`, `/public/get_instruments`, `/public/tickers` 세 경로를 진단 대상으로 사용했습니다. **경로 확인과 매개변수·응답 필드·단위 확인은 구분합니다.** 이 환경에서는 공식 문서 본문과 실제 API 응답을 읽지 못해 다음을 독립 검증하지 못했습니다.

- 종목 목록·티커의 필수 매개변수와 응답 구조
- BTC·ETH·SOL의 실제 계약명, 상장/활성 상태, 결제 통화 및 계약 크기
- 가격·수량 단위, 최소 주문량과 최소 명목금액의 의미
- Mark Price의 출처·시각, 실제 호가·스프레드·신선도
- 수수료의 단위·적용 범위·계정별 요율

응답이 없는 상태에서 공식 명세를 추측해 기존 어댑터나 화면을 수정하지 않았습니다. 기존 어댑터의 `officialSpec:UNVERIFIED`, `tradable:false`, READ_ONLY 및 비공개 인증 차단은 유지합니다. 후보 계약명을 실제 상장명으로 확정하지 않습니다.

## Windows 공개 진단 도구

[Windows 실행 안내](ORANGEX_WINDOWS_PUBLIC_DIAGNOSTIC_KO.md)에 따라 Node.js 22/24와 기본 `curl.exe`만으로 실행합니다.

```powershell
npm run diagnose:orangex
```

`scripts/diagnose-orangex-public.mjs`는 공식 문서 루트와 확인된 세 공개 경로만 고정 호스트 HTTPS GET으로 요청합니다. `.env`, 서버, 계좌, 사용자 기록을 읽지 않습니다. API 키가 필요 없고 주문·취소·출금·모드 변경 경로가 없습니다. 파일 저장은 사용자가 선택한 Windows 임시 JSON 출력만 안내합니다.

도구는 프록시 CONNECT 거부·프록시 DNS·목적지 DNS·TLS·타임아웃·HTTP·API·스키마·신선도를 구분합니다. `curlrc`를 비활성화해 숨은 인증·전송 옵션을 막고, 프록시·CA 환경은 상속하며 리다이렉트를 따르지 않습니다. 오류 원문·헤더·응답 본문·비공개 필드는 출력하지 않습니다. 본문 크기, 요청 시간, 호가 깊이, 자산당 조회 계약 수에 상한을 둡니다.

이 도구도 클라우드에서 실제 실행했습니다. 문서·종목·티커·세 종목 호가의 6개 요청 모두 `PROXY_CONNECT_REJECTED`, CONNECT 403, 원 서버 HTTP `null`이었으며 종료코드는 2입니다. [실행 JSON](reports/orangex-public-retry-diagnostic.json)에 수치를 남겼습니다. Windows에서의 실제 성공을 검증한 결과는 아닙니다.

최소 수량·수수료·Mark Price는 실제 응답에 있는 허용된 필드만 출처와 함께 관측값으로 남깁니다. 문서와 단위를 확인하기 전에는 검증 완료로 표시하지 않습니다. 누락된 수수료를 0으로 만들거나 중간값을 Mark Price로 바꾸지 않습니다. 상장 목록에 없거나 조회 실패한 계약을 상장 폐지로 단정하지 않습니다.

## 테스트 결과

| 검사 | 이번 결과 |
|---|---|
| Linux · Node.js 24.19.0 | **261/261 통과**, 실패·건너뜀·취소 0, 약 14.72초 |
| Linux · Node.js 22.23.3 | **261/261 통과**, 실패·건너뜀·취소 0, 약 14.50초 |
| 기존 회귀 | 이전 246개 전부 포함. 기대값 완화·제외 없음 |
| 신규 진단 검사 | 15개 통과. Windows curl.exe 호출, 무인증 GET, 오류 분류, 스키마 정보 안전 출력, 계약 불일치·신선도·Mark 시각·조회 상한 등 |
| Chromium PC·모바일 | 1440·390·360·720px 모두 통과. 가로 넘침·JavaScript 오류 0, GET만 사용, 조회 실패 후 이전 관측 유지와 복구 확인 |
| 실제 OrangeX 공개 API | 실패. 프록시 CONNECT 403으로 원 서버 도달 미확인 |
| GitHub Actions의 실제 Windows/Linux 작업 | `gh run list`가 `api.github.com`의 `Forbidden`으로 실패하여 미확인 |

자동 테스트는 임시 데이터·빈 인증값·외부 통신 차단으로 수행했습니다. 브라우저 검사는 격리된 실제 앱 서버와 Mock 거래소를 사용했고 외부 TradingView·폰트 요청은 차단했습니다. 브라우저 화면 검사가 실제 OrangeX 연결, 외부 차트 로딩, 실제 Windows·모바일 OS를 검증한 것은 아닙니다. 기존 모의매매·PNL·기록 보호 회귀를 모두 포함하며 기존 UI 코드는 변경하지 않았습니다.

Actions의 기존 Ubuntu/Windows × Node.js 22/24 행렬과 기능 브랜치 Push 트리거는 유지됩니다. 호스팅된 네 작업이 통과했다는 뜻으로 표시하지 않습니다.

검사별 수치는 [회귀 검사 요약 JSON](reports/orangex-public-retry-tests.json)에 있습니다. 추가·수정 파일은 `scripts/diagnose-orangex-public.mjs`, `tests/orangex_public_diagnostic.test.mjs`, `package.json`, `README.md`, `ORANGEX_READONLY_KO.md`, 이 보고서, Windows 안내 및 `reports/orangex-public-retry-*.json` 세 파일입니다.

## 보존 범위와 다음 단계

이번 변경은 별도 진단 도구·Mock 테스트·실행 명령·문서·공개 진단 결과뿐입니다. 기존 OrangeX 어댑터·서버·화면, Binance/Variational 분석, 시그널·모의매매·PNL·저장·백업·텔레그램 코드는 수정하지 않았습니다. 기존 Windows 기록과 다른 작업 폴더의 미완료 변경도 건드리지 않았습니다.

클라우드에서는 환경 설정의 `openapi-docs.orangex.com`, `api.orangex.com` 허용을 저장한 뒤 **게시·적용**하고 현재 정책을 다시 확인해야 합니다. `api.github.com`은 Actions 조회가 필요할 때 별도 허용 대상입니다. 프록시 우회나 TLS 검증 해제는 하지 않습니다.

Windows 진단 JSON 또는 허용된 환경의 실제 공개 응답을 공식 문서와 대조한 뒤에만 실제 데이터 기반 PAPER 준비 상태를 판단할 수 있습니다. 현재는 **보류**입니다. READ_ONLY 외 모드·실제 주문·취소·출금·main 수정·Merge는 수행하지 않았습니다.
