# OrangeX 상장 조회 영역 수정과 Windows 실측 재검증

후속 [2단계 오프라인 PAPER 보고서](ORANGEX_PAPER_OFFLINE_KO.md)를 추가했습니다. 실제 API 검증은 여전히 미완료이며 합성 시뮬레이션만 구현했습니다. 아래는 `ae3f164`까지의 실측 대조·검증 기록입니다.

대상은 `Rmsidrmfo3531/signal-lab`, 기준은 `feat/orangex-readonly`의 `205210b`입니다. 이번 변경은 상장 목록 조회·공개 시장 데이터 검증에 한정합니다. **READ_ONLY를 유지하고 OrangeX PAPER 자동 진입과 실제 주문은 모두 차단합니다.** 기존 Binance·Variational 분석이나 모의매매 기록을 OrangeX 기록으로 전환하지 않습니다.

## 원인과 확인 범위

이전 코드는 `/public/get_instruments`에 `currency=USDT`를 기본으로 보냈습니다. 이는 계약명에 들어 있는 `USDT`를 조회 후보로 사용한 것이며, 현재 사용자가 제공한 공식 문서 내용으로 뒷받침되지 않습니다. 해당 문서에서 `currency`는 거래 영역이며 예시 열거값은 `BTC`, `ETH`, `SPOT`입니다. 결제 자산 이름과 거래 영역을 같은 것으로 취급할 근거가 없습니다.

최신 Windows 자료에서 확인되는 사실은 **USDT 영역 요청에 HTTP 200이 반환됐지만 세 대상 계약의 상장을 찾지 못했다**는 것입니다. 제공된 출력에는 상장 응답의 전체 행·행 수가 없습니다. 따라서 응답이 빈 배열이었는지, 다른 계약만 있었는지까지 판정하지 않습니다. `currency=USDT`가 거래소에서 절대 지원되지 않는다는 결론도 내리지 않습니다. 잘못된 기본값은 수정하되, BTC·ETH 영역에서 원하는 계약이 실제로 반환되는지는 새 Windows 비교 결과로 확인해야 합니다.

또 다른 오류는 구버전 진단의 성공 조건입니다. 공개 요청들이 HTTP 200이면 `exitCode:0`과 `PUBLIC_RESPONSES_OBSERVED`가 가능했고, 상장·활성 상태 확인 실패가 전체 결과에 반영되지 않았습니다. 새 진단은 전송 결과와 상장·호가·Mark 검증을 나눠 기록하며, 대상 상장이 확인되지 않으면 전체 성공으로 표시하지 않습니다.

| 조회 값 | 근거 | 새 기본 조회 | 무기한 계약 처리 |
|---|---|---|---|
| `BTC` | 사용자가 제공한 공식 문서의 거래 영역 예시 | 포함 | 실제 목록의 정확한 계약명·활성 상태를 검사 |
| `ETH` | 같은 문서의 거래 영역 예시 | 포함 | 실제 목록의 정확한 계약명·활성 상태를 검사 |
| `SPOT` | 같은 문서의 거래 영역 예시 | 포함 | 현물 영역을 무기한 계약 승인 근거로 사용하지 않음 |
| `PERPETUAL` | 지원 여부를 별도 확인해야 하는 후보 | 제외, 명시적 비교만 | 관측돼도 검증 전까지 무기한 영역으로 승인하지 않음 |
| `USDT` | 과거 기본값. 현재 제공된 문서 예시에 근거 없음 | 제외, 명시적 비교·기존 설정 호환만 | 관측돼도 검증 전까지 무기한 영역으로 승인하지 않음 |

여기서 문서 근거는 **사용자가 제공한 공식 문서 발췌 내용**입니다. 클라우드에서 공식 문서 전체와 현재 서버 지원 범위를 독립적으로 검증했다고 표시하지 않습니다. 내부 코드의 `LEGACY_UNSUPPORTED` 분류도 문서 근거 없는 과거 값이라는 뜻이며 거래소 미지원 확정이 아닙니다. BTC·ETH 영역에서 관측 조건을 통과해도 공식 단위·수수료 검증이나 PAPER 허용으로 이어지지 않습니다.

## 최신 실제 Windows 관측

새 자료는 합성 Mock이 아닙니다. 사용자가 채팅에 제공한 **2026년 10월 27일 21:37:02.419 한국 시간** 시작 진단입니다. 원문 `checkedAt`은 `2026-10-27T12:37:02.419Z`입니다.

- 공개 GET 8건: 문서 1건, `currency=USDT` 상장 1건, 종목별 티커 3건, 호가 3건.
- 원 기록은 모두 HTTP 200, `exitCode:0`, `responseSource:UNCONFIRMED`입니다.
- 세 종목 모두 `listingObserved:false`, `active:null`, `contractFields:{}`입니다.
- `officialSpecificationVerified:false`, `accountChecked:false`, `ordersSubmitted:false`를 유지합니다.
- [실측 fixture](tests/fixtures/orangex/windows-public-diagnostic-20261027-usdt-mark-depth.json)에 필드와 수치를 보존합니다. 공백·들여쓰기를 정규화한 채팅 JSON이며, 원래 Windows 파일의 바이트 사본이나 거래소 출처의 독립 증명은 아닙니다.

| 요청·응답에서 관측한 계약명 | 상장·활성 | Bid | Ask | 종목별 Mark Price | Bid/Ask 행 수 |
|---|---|---:|---:|---:|---:|
| `BTC-USDT-PERPETUAL` | 목록 미관측 / 미확인 | 80,205.3 | 80,205.4 | 80,205.3 | 20 / 20 |
| `ETH-USDT-PERPETUAL` | 목록 미관측 / 미확인 | 2,326.27 | 2,326.28 | 2,326.27 | 20 / **22** |
| `SOL-USDT-PERPETUAL` | 목록 미관측 / 미확인 | 100.61 | 100.62 | 100.6 | 20 / 20 |

이 표의 계약명은 종목별 공개 조회에서 사용된 이름입니다. 최신 자료의 `contractNameSource`는 모두 `SDK_CANDIDATE_ONLY`입니다. 호가·Mark를 받았다는 사실을 상장 목록에서 검증됐다는 뜻으로 바꾸지 않습니다. Mark는 각 티커의 `result[0].mark_price` 관측값이며 Bid·Ask 중간값으로 보충하지 않았습니다.

| 계약 | 호가 원 타임스탬프 | Mark 원 타임스탬프 | 기록된 호가 age | 기록된 Mark age |
|---|---:|---:|---:|---:|
| BTC | 1793104606846 | 1793104606391 | 16,944ms | 17,400ms |
| ETH | 1793104607142 | 1793104606623 | 16,933ms | 17,452ms |
| SOL | 1793104607385 | 1793104606389 | 16,930ms | 17,926ms |

밀리초로 해석한 호가 시각은 각각 한국 시간 21:36:46.846, 21:36:47.142, 21:36:47.385입니다. Mark 시각은 21:36:46.391, 21:36:46.623, 21:36:46.389입니다. 원 자료의 시각 단위 표시는 `MILLISECONDS_BY_MAGNITUDE_UNVERIFIED`이므로 공식 단위 검증 완료로 바꾸지 않습니다.

당시 도구는 모두 `fresh:true`로 기록했습니다. 이는 수집 당시의 판정이며 현재 실시간 시세가 아닙니다. 시작 시각 `checkedAt`을 모든 종목의 평가 완료 시각으로 간주해 원 `ageMs`를 덮어쓰지 않습니다. 새 코드는 조회가 끝난 시각과 이후 상태 조회 시각에 호가와 Mark 원 시각을 각각 다시 검사합니다. 시각 누락·미래 시각·오래된 데이터는 공개 시장 준비 조건을 통과하지 못하며, PAPER 자동 진입은 신선도와 관계없이 계속 OFF입니다.

### ETH 호가에서 추가로 확인한 점

붙여 준 최신 JSON의 ETH 매도 호가는 요청 `depth=20`과 달리 22행이며, 가격 `2326.35`, `2326.36`이 각각 반복됩니다. 순서도 `2326.36 → 2326.35`로 되돌아갑니다. 원문을 20행으로 자르거나 중복 잔량을 합산해 정상 호가로 바꾸지 않습니다.

이는 **제공된 진단 출력에 존재하는 이상**입니다. 전체 HTTP 원문이 없어 거래소 응답, 진단 도구, 전달 과정 중 어디에서 생겼는지는 확인할 수 없습니다. 새로운 공개 GET 진단에서 원 배열과 유효성 결과를 함께 확인해야 합니다. 중복·역전된 깊이를 안전한 모의체결 잔량으로 사용해서는 안 됩니다.

## 이전 6건 자료와 섞지 않는 항목

[이전 6건 실측 보고서](ORANGEX_WINDOWS_OBSERVATION_KO.md)는 같은 날 14:10:44.056 한국 시간의 별도 자료입니다. 당시에는 상장·활성 상태와 일부 계약 원필드가 관측됐지만 종목별 Mark와 전체 호가 잔량은 없었습니다. 최신 8건 자료는 Mark와 깊이를 제공하지만 상장 목록에서 계약을 찾지 못했습니다. 두 시점의 결과를 합쳐 하나의 완전한 거래 준비 스냅샷으로 만들지 않습니다.

| 항목 | 이전 6건 자료 | 최신 8건 자료의 검증 상태 |
|---|---|---|
| 계약명·활성 | 목록에서 관측됨 | 목록 미관측, 활성 미확인 |
| `min_trade_amount`, `min_notional`, `tick_size` | 일부 원값 관측 | `contractFields:{}`이므로 미관측 |
| Maker/Taker 원값 | 관측됐지만 단위 미검증 | 미관측. 이전 요율로 채우지 않음 |
| `min_qty`, `contract_size`, 수량 증분 | 제공 자료에 없음 | 계속 미관측·미검증 |
| 종목별 Mark·독립 시각 | 없음 | 세 계약에서 관측됨. 공식 시각 단위는 미검증 |
| 호가 가격·잔량 배열 | 없음 | 배열 관측. ETH 매도 측 중복·역전 확인 |

`min_trade_amount`를 `min_qty`나 수량 증분으로 간주하지 않습니다. `min_notional`의 통화를 추정하거나 계약 크기를 1로 채우지 않습니다. Maker/Taker 원값의 비율·%·bp 단위, 계정별 적용 요율도 확인 전까지 환산하지 않습니다. `base_currency`·`quote_currency`는 거래소 필드의 정의를 확인한 뒤 해석해야 합니다.

## 구현과 결과 표시

- `orangex_listing_domains.mjs`: 고정된 조회 영역 후보, 영역별 상장 관측 대조, 계약·활성·필드 충돌 검사, 공개 시장 준비 상태를 공유합니다. 충돌하는 행을 합쳐 새 계약 규격을 만들지 않습니다.
- `orangex.mjs`: 기본 조회를 BTC·ETH·SPOT으로 변경하고, 종목별 호가·티커와 상장 출처를 별도로 보존합니다. 상태를 읽을 때도 호가와 Mark 신선도를 다시 검사합니다.
- `scripts/diagnose-orangex-public.mjs`, `scripts/diagnose-orangex-currencies.mjs`: 고정 HTTPS 공개 GET만 허용하며, 영역별 요청·실패 유형·목록 행 수·대상 일치·원필드를 기록합니다. `.env`나 사용자 PNL 저장소를 읽지 않습니다.
- `server.mjs`, `.env.orangex.example`: 새 복수 설정 `ORANGEX_LISTING_CURRENCIES`를 지원합니다. 실제 설정 파일을 자동 변경하지 않습니다.
- `public/orangex.js`, `public/index.html`, `public/styles.css`: PC·모바일 공통 화면에 영역별 관측, 계약별 거부 사유, 호가·Mark 상태, 거래 준비 미완료와 PAPER OFF를 표시합니다.
- `updater.mjs`: 새 조회 모듈·진단 스크립트가 기존 업데이트 검증 대상에 포함되도록 목록을 보완합니다. 사용자 데이터 경로는 바꾸지 않습니다.

API 연결은 성공했어도 계약 상장 검증은 실패할 수 있습니다. `connected` 같은 연결 표시와 `marketReadiness.publicDataReady`를 구분하세요. 공개 관측 조건이 모두 통과해도 `ready`, `tradingReady`, `paperReady`는 false이며 자동 진입·주문 권한을 의미하지 않습니다.

새 진단의 영역별 `listingDiscovery`는 다음을 구분합니다.

| 결과 | 뜻 |
|---|---|
| `REQUEST_FAILED` | 전송·HTTP·API·응답 구조 등의 이유로 목록 조회 실패 |
| `EMPTY_RESPONSE` | 유효한 목록 응답의 행 수가 0 |
| `NO_TARGET_MATCHES` | 목록은 있지만 BTC·ETH·SOL 무기한 대상과 정확히 일치한 계약이 없음 |
| `TARGET_MATCHES` | 대상 계약명 관측. 활성·충돌·조회 영역·신선도 검사는 별도로 필요 |

`instrumentCount`는 해당 영역 전체 목록 행 수이고 `targetMatchCount`는 찾은 대상 계약 수입니다. `targetMatches`에는 원필드 값과 출처가 있습니다. 중복·상충하는 관측은 별도로 표시하며, 누락 필드를 다른 영역에서 조용히 가져와 채우지 않습니다. `officialSpecificationVerified`와 수수료·수량 단위 검증 상태는 여전히 false입니다.

## Windows에서 비교 진단 실행

Node.js 22 또는 24가 설치된 Signal Lab 프로젝트 폴더에서 PowerShell을 여세요. 아래 명령은 애플리케이션 서버를 시작하지 않고 공개 조회만 실행합니다. 키를 입력할 필요가 없으며 기존 PNL·설정·백업을 읽거나 초기화하지 않습니다.

문서 예시 BTC·ETH·SPOT만 비교합니다.

```powershell
node .\scripts\diagnose-orangex-currencies.mjs
```

PERPETUAL과 과거 USDT도 **미검증 후보로 명시해** 함께 비교합니다.

```powershell
node .\scripts\diagnose-orangex-currencies.mjs --include-unverified --include-legacy
```

JSON을 임시 폴더에 저장하려면 다음을 사용하세요. `npm run`의 안내 머리글이 섞이지 않도록 node를 직접 실행합니다.

```powershell
$orangeXReportPath = Join-Path $env:TEMP ("orangex-currencies-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
node .\scripts\diagnose-orangex-currencies.mjs --include-unverified --include-legacy | Out-File -FilePath $orangeXReportPath -Encoding utf8
$orangeXExitCode = $LASTEXITCODE
$orangeXReport = Get-Content -Raw -Encoding utf8 $orangeXReportPath | ConvertFrom-Json
$orangeXReport.listingDiscovery | Select-Object currency, status, outcome, instrumentCount, targetMatchCount, httpStatus, category
$orangeXReport.markets | Select-Object instrumentName, listingObserved, active, listingConflict, markPrice, markPriceFresh
Write-Output "Exit code: $orangeXExitCode"
Write-Output "Report: $orangeXReportPath"
```

원필드·호가·거부 사유는 저장한 JSON의 `markets`, `listingDiscovery`, `marketReadiness`에서 확인합니다. `currency=USDT`와 새 영역들의 실제 행 수·계약 일치 여부가 핵심 비교 대상입니다. 종료코드 0도 공식 명세·계좌·주문 검증 완료가 아닙니다. 상장·신선도·응답 검증 미완료는 1, DNS·TLS·타임아웃·프록시 연결 거부 등 전송 실패는 2로 보고합니다.

기존 명령도 유지합니다.

```powershell
npm run diagnose:orangex
npm run diagnose:orangex:currencies -- --include-unverified --include-legacy
npm run test:orangex
```

기본 진단은 문서 1건, 상장 영역 3건, 세 계약의 티커·호가 6건으로 보통 10건입니다. 비교 후보 5개를 모두 포함하면 보통 12건입니다. 영역에서 자산별 여러 계약이 발견되면 제한된 추가 계약 조회로 요청 수가 늘 수 있습니다. 이번에 제공된 8건 자료는 과거 USDT 단일 조회 방식의 결과입니다.

서버의 새 샘플 설정은 `ORANGEX_LISTING_CURRENCIES=BTC,ETH,SPOT`입니다. 복수 설정이 있으면 이전 단수 `ORANGEX_LISTING_CURRENCY`보다 우선합니다. 실제 설정에 USDT 단수값만 있으면 호환을 위해 그 값을 유지하고 경고를 표시합니다. 기존 `.env` 전체를 샘플로 덮어쓰지 마세요. 위 독립 진단은 `.env`를 읽지 않으므로 파일 변경 없이 비교할 수 있습니다.

클라우드에서 목적지 정책이 차단되면 프록시를 우회하거나 TLS 검증을 끄지 않습니다. 프록시 CONNECT 거부, DNS, TLS, 타임아웃, HTTP 오류, 응답 구조 오류를 구분해 기록해야 합니다. 과거 CONNECT 403은 OrangeX 자체 HTTP 거부로 해석하지 않습니다.

## 테스트와 실제 연결 결과

2026년 10월 28일 한국 시간에 실행했습니다. 모든 서버·저장 검사는 임시 데이터와 빈 인증 설정을 사용했습니다. 전체 자동 테스트에는 외부 fetch·WebSocket 차단 장치를 적용했습니다. 실제 거래소 접속 검사는 별도 명령으로 분리했습니다.

| 검사 | 이번 최종 결과 |
|---|---|
| Linux Node.js 22.23.3 전체 회귀 | **329개 통과**, 실패·건너뜀·취소 0개, 약 15.64초 |
| Linux Node.js 24.19.0 전체 회귀 | **329개 통과**, 실패·건너뜀·취소 0개, 약 15.90초 |
| 최신 실제 Windows 진단 fixture 재생 | 두 런타임에서 전용 **6개 통과**. 전체 329개에 포함, 현재 실시간 접속 검사가 아님 |
| 합성 API·서버·UI 검사 | 전체 회귀에 포함해 통과. 상장 미확인·영역 충돌·호가/Mark 개별 만료·잘못된 깊이 차단, 설정 우선순위와 기록 보존 검증 |
| PC·모바일 브라우저 회귀 | Linux Chromium, 1440·390·360·720px 모두 통과. 새 영역 카드 3개·준비 상태·거부 사유·기존 패널·갱신 실패 후 복구 확인. JS 예외·가로 넘침 0, OrangeX GET만 사용 |
| 클라우드 실제 curl GET 비교 | **실패, 종료코드 2**. 12건 모두 프록시 CONNECT 403, 목적지 HTTP 상태 미관측. 새 영역의 실제 상장 목록은 미확인 |
| 실제 `npm run test:orangex` | **실패, 종료코드 2**. DNS `EAI_AGAIN`·타임아웃, 실제 호가 관측 0개. 이 명령 자체에 프록시 CONNECT 증거는 없으며 별도 curl 결과와 구분 |
| 실제 Windows Node.js 22/24 실행 | 이번 클라우드에서 실행하지 못함. 제공된 Windows 공개 진단 자료와 Linux 테스트로 대신 통과 표시하지 않음 |
| GitHub Actions Windows·Linux 네 작업 | 기존 Push 트리거와 4환경 행렬 유지. `gh run list`가 HTTP 403으로 거부돼 실제 원격 결과 미확인 |
| 기능 브랜치 | 변경은 `feat/orangex-readonly`에만 커밋·Push. main 직접 수정·Merge 없음 |

기계 판독 결과는 [테스트·화면 검사](reports/orangex-currency-domain-tests.json)와 [실제 클라우드 공개 GET 진단](reports/orangex-currency-domain-connectivity.json)에 보존했습니다. 브라우저 검사는 합성 시세를 사용했고 외부 TradingView·폰트는 차단했습니다. 기존 TradingView 링크·화면 구성은 검사했지만 외부 차트 서비스의 실제 로딩이나 휴대폰 OS·Windows 알림 풍선까지 확인한 결과는 아닙니다.

기준 `205210b`의 294개에서 35개 검사를 추가했습니다. 기존 LONG 분할 익절·재시작·CLOSE·비용 포함 PNL, SHORT 손절·손실 기록, 저장 실패·백업/복원·기존 기록 보존 검사가 전체 회귀에 포함됩니다. `engine.mjs`, `quality.mjs`, `paper.mjs`, `persistence.mjs`, `signal_lifecycle.mjs`, `public/trade_plan.js`와 실제 사용자 설정·기록은 변경하지 않았습니다.

기존 6건 자료의 `exitCode:0`과 최신 8건 자료의 원 종료코드는 수정하지 않습니다. 같은 데이터를 새 준비 상태 기준으로 평가해 보류되는 것과, 당시 HTTP 요청이 실패했다는 것은 다른 이야기입니다. 실제 자료 재생과 합성 Mock 테스트는 서로 구분해 보고합니다.

## OrangeX PAPER 개발 전 남은 조건

1. 새 Windows 비교 진단으로 실제 무기한 상장 영역, 세 정확한 계약명, 활성 상태와 일관된 계약 규격을 확인합니다. 원 응답의 필드·타입·매개변수를 공식 문서와 대조합니다.
2. `min_qty`, `min_trade_amount`, 수량 증분, `contract_size`, `min_notional`, `tick_size`의 의미·단위·적용 범위를 확인합니다. 최소 수량과 주문 증분은 별도 조건이어야 합니다.
3. Maker/Taker 원값의 단위·실제 적용 요율, 펀딩 단위·시각을 확인합니다. 확인되지 않은 비용을 0이나 추정 요율로 채우지 않습니다.
4. Mark와 호가의 원 타임스탬프 단위, 각 신선도, 중복·역전 없는 깊이를 검증합니다. ETH의 이상 배열은 새 관측으로 원인을 좁혀야 합니다. Binance 대응 계약·시각·가격 차이도 검증합니다.
5. 이후 별도 OrangeX PAPER 저장소·잠금·백업을 설계하고, 임시 데이터로 LONG·SHORT, 위험 한도와 최소 주문 조건, 40/35/25% 익절·손절·CLOSE·비용 포함 PNL·재시작·저장 실패를 검증합니다.

**PAPER 설계와 오프라인 검증은 진행할 수 있지만, 자동 모의체결 엔진 활성화 조건은 아직 충족되지 않았습니다.** 이번 작업은 새 실거래 엔진이나 PAPER 자동 진입을 추가하지 않으며 기존 사용자 데이터·설정·백업 경로를 보존합니다.
