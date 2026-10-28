# OrangeX 공개 시장 데이터 연동 보완

최신 Windows 8건 JSON 및 거래 영역 기본값 수정은 [거래 영역 보고서](ORANGEX_CURRENCY_DOMAIN_KO.md)를 우선 참고하세요. 아래 내용은 해당 후속 자료 수신 전의 기록입니다.

후속으로 실제 Windows 진단 JSON을 수신했습니다. 수신 전의 아래 기록은 보존하고, 실제 수치·누락 항목·현재 코드 대조는 [Windows 실측 대조 보고서](ORANGEX_WINDOWS_OBSERVATION_KO.md)를 우선 참고하세요.

대상은 `Rmsidrmfo3531/signal-lab`, 기준은 `feat/orangex-readonly`의 `9f80e62`입니다. 최신 지시에 따라 **공개 조회만 구현**했습니다. 거래소 전송과 화면은 READ_ONLY이며 OrangeX PAPER 자동 진입은 비활성입니다.

## 증거와 확인 범위

사용자는 Windows에서 기존 진단이 종료코드 0, 공개 요청 6건 HTTP 200, BTC·ETH·SOL 상장·활성·최신 호가를 관측했다고 알려주었습니다. 이 관측을 클라우드 실패와 구분해 기록합니다.

**현재 대화와 작업 환경에는 첨부 JSON 파일 자체가 전달되지 않았습니다.** 프로젝트·공유 다운로드·첨부 파일 경로를 확인했고 JSON 본문을 요청했습니다. 따라서 그 결과를 실제 응답 fixture로 만들거나 계약별 수치를 읽은 것으로 표현하지 않습니다. 수치가 있는 신규 테스트는 모두 명시적인 합성 Mock입니다.

클라우드 정책은 현재 관측 `observations_current:true`, 적용 `enforced`, 접근 방식 `restricted`이고 OrangeX 문서·API 호스트는 허용되지 않았습니다. 이 환경에서의 공식 문서 원문·실제 API 독립 검증은 미완료입니다. 정책 우회·인증서 검증 해제는 하지 않았습니다.

## 공식 명세 조건과 구현 대조

| 항목 | 이번 반영 | 아직 확인하지 못한 것 |
|---|---|---|
| `/public/get_instruments` | `currency`를 필수 인자로 받고 쿼리에 전송. 누락·경로 주입은 요청 전 거부 | 허용 통화 목록과 통화의 거래소 정의. 기본 `USDT`는 명시적 요청 후보이며 독립 검증값 아님 |
| `/public/tickers` | 계약별 `instrument_name` 필수 조회. 요청과 응답의 정확한 계약명 일치 확인 | 실제 Windows 응답의 컨테이너·필드와 공식 문서 전체 일치 |
| 실제 계약명·활성 상태 | 상장 응답의 `instrument_name`, `is_active`를 그대로 관측. 활성·비활성·상태 미확인·조회 실패를 구분 | 첨부 JSON의 세 계약명과 활성 값 직접 대조 |
| `min_trade_amount`·`min_qty` | 각각 별도 원필드로 보존·표시. 서로 대체하지 않음 | 각각이 거래 금액·기초자산·계약 수 중 무엇을 뜻하는지 |
| 수량 증분 | `qty_step`, `quantity_step`, `quantity_increment` 같은 명시적 원필드만 별도 관측. 최소량을 증분으로 사용하지 않음 | 실제 사용 필드·단위, 상충하는 증분 값의 정확한 해석 |
| `min_notional`·`tick_size`·`contract_size` | 원필드 관측과 누락을 그대로 표시. 최소 금액을 수량으로 나누거나 계약 크기로 누락 값을 생성하지 않음 | 실제 수치·통화·계약 단위의 공식 의미 |
| Maker·Taker | `maker`, `taker`, `maker_fee`, `taker_fee`, `*_commission`, `*_fee_rate` 원값 보존 | 소수 비율·퍼센트·bp 여부 및 계정별 적용 요율. bp 환산값은 `null` |
| `base_currency`·`quote_currency` | API 원필드 이름과 값으로 표시. Binance의 정의로 치환하지 않음 | 해당 거래소의 필드 정의와 계약 결제 통화의 관계 |
| Mark·티커 시각 | 해당 계약 티커의 `mark_price`만 사용. 명시적 `mark_timestamp` 우선, 없을 때 해당 티커의 `timestamp`를 관측. 호가와 별도 신선도 검사 | 실제 시각 필드와 밀리초 단위의 공식 확인. 초·마이크로초를 임의 환산하지 않음 |
| 호가 정밀도 | 관측된 `tick_size`·명시적 증분 후보와 가격·잔량 표본의 격자 일치 여부 표시 | 관측 일치가 공식 주문 단위 승인을 뜻하지 않음. 미확인 증분은 미검증 |

필수 매개변수 이름은 사용자가 제공한 명세 조건을 반영했습니다. 문서 원문을 직접 확인했다고 주장하지 않습니다. 상장 관측도 `tradable:true`나 주문 가능 승인으로 바꾸지 않습니다. 표준화된 `minQty`, `qtyStep`, `priceTick`과 수수료 bp는 의미가 검증되지 않아 계속 `null`입니다.

## BTC·ETH·SOL 검증표

| 대상 | 현재 코드의 조회 후보 | Windows 상장·활성 관측 | 실제 계약명·규격·호가 수치 직접 대조 |
|---|---|---|---|
| BTC | `BTC-USDT-PERPETUAL` | 사용자 보고: 관측 | JSON 미제공으로 미완료 |
| ETH | `ETH-USDT-PERPETUAL` | 사용자 보고: 관측 | JSON 미제공으로 미완료 |
| SOL | `SOL-USDT-PERPETUAL` | 사용자 보고: 관측 | JSON 미제공으로 미완료 |

위 후보명을 사용자의 실제 상장 응답에 있던 계약명으로 확정하지 않습니다. 가격·최소량·계약 크기·수수료를 추정해서 표에 채우지 않았습니다.

## 공개 조회와 화면

서버 상세 조회는 상장 1건 + 계약별 티커 3건 + 호가 3건, 총 **7건**입니다. 독립 진단은 문서 루트 1건을 더해 기본 **8건**입니다. 예전 Windows **6건** 결과를 수정된 8건 검사 결과로 바꾸어 보고하지 않습니다.

상장·티커·호가의 실패를 별도 원인과 HTTP/전송 오류로 기록하고 다른 성공 관측은 보존합니다. Mark 누락·만료·계약명 불일치는 현재가나 호가 시각으로 보충하지 않습니다. 상세 `npm run test:orangex`는 최신 호가뿐 아니라 상장·활성과 Mark 신선도도 검사합니다. 성공도 공식 명세·수수료·체결 가능 승인으로 해석하지 않습니다.

PC·모바일 공통 OrangeX 탭에 원필드 규격 카드, 상장 상태, 독립 Mark 시각, 정밀도 관측, 수수료 미검증과 자료 출처를 추가했습니다. Mock·과거 JSON 재생·공개 응답 표기를 구분합니다. 실제 JSON 재생 API는 이번에 추가하지 않았으며, 화면의 재생 표시는 후속 테스트/호출자가 명시한 출처를 구분하는 기능입니다.

Binance 비교는 후보 계약명과 최신 Binance 이벤트 시각·OrangeX 호가 시각이 모두 있을 때만 중간 호가와의 가격 차이를 관측합니다. 중간 호가를 Mark로 쓰지 않습니다. 통화·계약 대응은 미검증이며 가격 차이를 계산해도 주문이나 PAPER 승인으로 사용하지 않습니다.

## 테스트와 실제 접속 결과

| 검사 | 결과 |
|---|---|
| Linux · Node.js 24.19.0 전체 | **287/287 통과**, 실패·건너뜀·취소 0, 약 16.27초 |
| Linux · Node.js 22.23.3 전체 | **287/287 통과**, 실패·건너뜀·취소 0, 약 15.29초 |
| 이전 261개 | 모두 포함. 공개 요청 수 기대값은 3개 호가에서 7개 상세 조회로 갱신하고 필수 매개변수·무인증 GET도 검사 |
| 신규 26개 | 어댑터 10, 독립 진단 4, 규격 UI 7, Binance 비교 3, PAPER 변수 무효화 1, 상세 smoke 판정 1 |
| Chromium PC·모바일 | 1440·390·360·720px 통과, 가로 넘침·JavaScript 오류 0, GET 전용·갱신 실패 표시·복구 확인 |
| 실제 `npm run test:orangex` | **실패·종료코드 2**, `transport_error`, 실제 호가 관측 0. 상장 DNS, BTC 호가 타임아웃/티커 DNS, ETH 호가·티커 타임아웃, SOL 호가 DNS/티커 타임아웃 |
| 실제 독립 공개 진단 | **실패·종료코드 2**. 8건 모두 프록시 CONNECT 403, 원 서버 HTTP·TLS 미관측 |
| GitHub Actions 실제 Windows/Linux 결과 | `gh run list`가 `api.github.com`의 `Forbidden`으로 실패해 미확인. 기존 4개 행렬·기능 브랜치 트리거 유지 |

Node 클라이언트의 DNS·타임아웃과 curl의 CONNECT 거부는 서로 다른 계층의 관측입니다. OrangeX가 DNS·TLS·HTTP 장애를 반환했다고 단정하지 않습니다. 실제 TLS 오류나 거래소 HTTP 오류를 관측한 결과는 없습니다.

전체 검사는 외부 통신 차단·빈 인증값·별도 임시 데이터로 수행했습니다. 브라우저는 격리된 앱 서버와 합성 거래소 응답을 사용했고 외부 TradingView·폰트 요청은 차단했습니다. 실제 Windows OS·휴대폰·외부 차트·OrangeX 연결 성공을 검증한 것은 아닙니다. 개발 중 신규 UI 테스트의 합성 통화 문자열 노출 실패 1건을 발견해 통화 표시 형식 제한 후 수정했고 최종 결과에 실패·건너뜀은 없습니다.

근거 파일은 [공개 진단](reports/orangex-market-connectivity.json), [실제 npm 공개 점검](reports/orangex-market-public-check.json), [전체 회귀 요약](reports/orangex-market-tests.json), [Windows 증거 전달 상태](reports/orangex-windows-evidence-status.json)입니다. 마지막 파일은 사용자 진술 기록이며 실제 API 응답 fixture가 아닙니다.

주요 변경 파일은 `orangex.mjs`, `orangex_comparison.mjs`, `server.mjs`, `public/orangex.js`, `public/index.html`, `public/styles.css`, 공개 점검·진단 스크립트 2개, Mock·회귀 검사 7개, 설정 샘플·문서·공개 보고 JSON입니다. `updater.mjs`에는 새 조회 모듈과 진단 스크립트를 배포 허용 목록에 추가했습니다. 사용자 기록 경로는 추가하지 않았습니다.

## PAPER 준비와 보존

새 PAPER 엔진·신규 계정 저장·모의 진입 API를 이번 변경에 포함하지 않았습니다. 이전 지시에 따라 진행하던 PAPER 코드는 최신 범위 변경 후 `/workspace/orangex-paper-wip-preserved-20261027`에 소스와 변경 패치로 보존했습니다. 기능 브랜치의 배포 코드와 분리되어 있으며 자동 실행되지 않습니다.

PAPER의 다음 설계는 기존 1H·4H 기술 분석과 LONG/SHORT, 진입·손절, 40/35/25% 분할, 수수료·슬리피지·펀딩을 구분한 PNL, 일간 손실·총 노출·중복 진입 한도를 재사용합니다. 기존 계정과 분리된 파일·잠금·백업을 먼저 설계하고 저장 성공 후에만 가상 체결과 이벤트를 확정해야 합니다. 최소 주문 조건 때문에 위험 한도를 넘겨 수량을 올리면 안 됩니다.

**설계·Mock 검증 준비는 가능하지만 실제 데이터 기반 PAPER 활성화는 보류합니다.** Mark 시각, 계약 크기·주문 수량 단위·증분·최소량, 비용 해석의 확인이 먼저입니다. 모의 비용 가정은 실제 요율과 별도 표기하고 미검증 비용을 0으로 채우지 않아야 합니다.

기존 Binance/Variational 분석·모의매매·PNL·텔레그램·TradingView·TradFi·뉴스·Windows 알림을 보존했습니다. `paper.mjs`, `persistence.mjs`, `engine.mjs`, `quality.mjs`를 변경하지 않았습니다. 기존 `.env`, 거래 기록과 백업을 초기화하거나 복사하지 않았고 테스트는 임시 데이터만 사용했습니다. main 수정·Merge·실제 주문·취소·출금은 하지 않았습니다.

## 다음 단계 Codex 지시문

> `signal-lab`의 `feat/orangex-readonly`에서 `ORANGEX_MARKET_INTEGRATION_KO.md`를 먼저 읽어라. 실제 Windows 공개 진단 JSON 원본과 공식 문서 발췌/접근 가능한 원문을 확보하고, 사용자 보고·원본 관측·합성 Mock을 구분하라. currency의 의미, 종목별 ticker, base/quote 정의, min_trade_amount와 min_qty, 주문 증분·최소 명목금액·계약 크기, Mark 시각과 Maker/Taker 단위를 정확한 필드 출처와 함께 대조하라. 실제 JSON이 없으면 만들어 넣지 마라. 공식 의미가 확인되기 전에는 READ_ONLY와 PAPER OFF를 유지하라. 확인 후에도 PAPER 활성화는 별도 범위로 진행하고 기존 모의 계정·PNL·설정·백업을 보존하라. 실제 주문·취소·출금·main 수정·Merge는 하지 마라. Node.js 22/24와 PC·모바일 회귀를 실행하고 미검증 항목과 실패를 한국어로 보고하라.
