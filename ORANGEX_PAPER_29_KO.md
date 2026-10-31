# OrangeX 2.9 — 검증 오류 수정과 실제 데이터 분석의 남은 조건

기준: `Rmsidrmfo3531/signal-lab`, `feat/orangex-readonly`, `e8b71fb`.

**종합 판정: NOT_READY. 새 Windows 연속 진단 JSON 분석은 입력 미전달로 미완료입니다.** 작업 시작과 재시도 후 첨부·작업 경로를 확인했지만, 접근 가능한 원본은 이전 `orangex-public-20261031T005917Z-edaabd29a09c778d6282.json` 하나뿐입니다. 새 파일 ID·경로·본문은 전달되지 않았습니다. 이 한계를 알리고 본문/경로를 요청했으며, 합성 자료로 대신하지 않았습니다.

`ORANGEX_PAPER_28_KO.md`와 `ORANGEX_COSTS_28_KO.md`를 먼저 읽고, 독립적으로 진행할 수 있는 코드 검사·반례 재현·수정·회귀 테스트를 완료했습니다. **READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF, LIVE·계좌 API·API 키·주문 금지**를 유지합니다. 사용자 기록·설정·백업과 실험 Journal은 변경하지 않았습니다.

## 자료와 검증 범위

| 근거 | 이번 상태 | 해석 |
|---|---|---|
| 기존 10월31일 Windows 단발 진단 | 실제 관측 자료 보존 | 11/11 HTTP200, 3개 활성 상장과 정상20단계 호가 관측은 계속 유효한 과거 사실 |
| 최신 Windows 연속 JSON | **UNVERIFIED / 입력 없음** | 연속 요청 성공률·갱신·펀딩 값을 확인했다고 보고하지 않음 |
| 공식 문서 내용 | 2.8에서 사용자가 확인해 제공한 출처 발췌 재사용 | 새 공식 본문을 독립 수집한 증거와 구분 |
| 클라우드 연결 정책 | restricted/enforced, OrangeX 도메인 허용 없음 | 이전 CONNECT403을 반복하거나 우회하지 않음. 이번 OrangeX 요청0건 |
| 합성 테스트 | 코드 결함 반례와 회귀 검사만 사용 | 실제 거래소 가격·체결·성과·연속 운영 증거로 사용하지 않음 |

기존 원본 SHA256은 `cf094ef5d29368a38f3b795f55462fbafa0e13b88ad7d5049c8bcbbb22ac3c41`, 크기는85,233바이트이며 변경하지 않았습니다. 수집 완료는 **2026-10-31 09:59:19.246 KST**입니다. 당시 준비 검사 **11 PASS / 0 FAIL / 43 UNVERIFIED**와 현재 만료 평가 **5 PASS / 6 FAIL / 43 UNVERIFIED**를 구분했습니다. 현재 사용 불가 판정은 그때의 정상 관측을 지우거나 현재 거래소 장애를 의미하지 않습니다.

공개 필드만 추린 [증거·차단 조건 JSON](reports/orangex29-evidence-review.json)에 최신 입력 누락과 과거 사실을 함께 기록했습니다. 기존 2.8 자료와 원본을 수정하지 않았습니다.

## 종목별 계약·비용·시장 조건

아래 값은 **기존 단발 실측**이며 새 연속 실측값이 아닙니다. PASS는 해당 행의 범위에만 해당합니다.

| 항목 | BTC-USDT-PERPETUAL | ETH-USDT-PERPETUAL | SOL-USDT-PERPETUAL |
|---|---|---|---|
| 당시 상장·활성 | PASS, active:true | PASS, active:true | PASS, active:true |
| contract_size | UNVERIFIED, 미수집 | UNVERIFIED, 미수집 | UNVERIFIED, 미수집 |
| 기본 amount 단위 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| min_qty / min_trade_amount | 원값·정의 구분 PASS: 0.001 / 0.001 | 원값·정의 구분 PASS: 0.01 / 0.01 | 원값·정의 구분 PASS: **1 / 0.1** |
| 실제 주문 수량 환산 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| min_notional 원값 | 10 | 10 | 100 |
| min_notional 통화·명목 공식 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| tick_size | 관측0.1, 기존40레벨 수치 격자 PASS | 관측0.01, 기존40레벨 수치 격자 PASS | 관측0.01, 기존40레벨 수치 격자 PASS |
| base_currency / quote_currency | 원값 USDT / BTC, 역할 UNVERIFIED | 원값 USDT / ETH, 역할 UNVERIFIED | 원값 USDT / SOL, 역할 UNVERIFIED |
| 결제·증거금 통화 | 상품별 근거 UNVERIFIED | 상품별 근거 UNVERIFIED | 상품별 근거 UNVERIFIED |
| 표준 Maker / Taker와 원값 일치 | PASS, 0.0002 / 0.0006 | PASS, 0.0002 / 0.0006 | PASS, 0.0002 / 0.0006 |
| 실제 계정 적용 수수료 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 펀딩 식별자·요율·다음 시각·주기 | UNVERIFIED, 새 응답 없음 | UNVERIFIED, 새 응답 없음 | UNVERIFIED, 새 응답 없음 |
| 당시 호가 무결성 | PASS, 20 Bid+20 Ask | PASS, 20 Bid+20 Ask | PASS, 20 Bid+20 Ask |
| 당시 호가 / Mark 로컬 나이 | PASS, 24.418 / 24.897초 | PASS, 24.148 / 24.615초 | PASS, 23.858 / 24.475초 |
| 과거 호가·Mark의 현재 사용 | FAIL, 만료 | FAIL, 만료 | FAIL, 만료 |
| 새 연속 시세·지연·정지·캐시 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 실제 Binance 가격·계약 대응 | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 전체 | **NOT_READY** | **NOT_READY** | **NOT_READY** |

### 수량과 통화의 공식 근거

[get_instruments](https://openapi-docs.orangex.com/#get-instruments)의 사용자 확인 정의에 따라 min_qty는 최소 주문 수량, min_trade_amount는 수량 증분으로 구분합니다. 같은 검증된 단위에서 `q >= min_qty`와 `q / increment가 정수`를 동시에 만족해야 합니다. 이 식만으로 amount가 BTC·ETH·SOL 수량인지 계약 수인지 정하지 않습니다.

[buy](https://openapi-docs.orangex.com/#buy)·[sell](https://openapi-docs.orangex.com/#sell) 문서의 market_amount_order=true는 USDT 가치이며 기본값 false의 정확한 수량 단위는 미확인입니다. 해당 API는 문서 참조만 하며 호출하지 않았습니다. contract_size 원값과 관계가 확인될 때까지 `q×P` 또는 `q×contract_size×P`를 실제 명목 공식으로 선택하지 않습니다.

min_notional 설명의 baseCurrency 표현은 여전히 모호합니다. 실제 base_currency=USDT를 보고 이 필드가 최소 USDT 명목금액이라는 결론을 자동 도출하지 않습니다. quote_currency 값을 기초자산 필드로 임의 변경하거나 결제·증거금 통화를 채우지 않았습니다. PERPETUAL 영역의 실제 목록 발견과 공식 currency 전체 범위·kind=future의 무기한 역할 확인도 별개입니다.

현재 연속 진단은 티커·호가·선택적 펀딩과 Binance 비교를 수집하며 OrangeX get_instruments를 새로 수집하지 않습니다. 따라서 새 연속 JSON만으로 contract_size·최소량 등 계약 규격을 모두 검증할 수 있다고 약속하지 않습니다. 필요한 계약 필드가 누락되면 별도의 공개 상장 응답과 상품별 공식 단위 설명이 필요합니다. 계약 크기 숫자만 있어도 amount와의 환산 의미가 자동 확인되는 것은 아닙니다.

### 표준 비용·펀딩과 실제 적용

[최신 표준 수수료 설명](https://www.orangex.com/support/faq/articles/1764-orangex-maker-taker-fees-explained), 2026-09-16 업데이트의 Maker0.02%, Taker0.06%와 원값0.0002/0.0006의 수학적 일치는 확인된 사실입니다. [2023년 설명](https://support.orangex.com/hc/en-us/articles/16774208296727-Futures-Fee-Structure-Fee-Calculations)의 Taker0.05%와 차이도 보존합니다. 실제 계정 등급·할인은 공개 목록만으로 확인하지 못했으며 키·계좌 API를 사용하지 않았습니다.

[일반 펀딩 설명](https://www.orangex.com/support/1/articles/394-funding-rates-btc-imn?mid=152-1054-1056)에 따르면 양수는 LONG 지급, 음수는 SHORT 지급이며 명목가치는 Mark×기초자산 수량입니다. 일반 UTC00/08/16과 약15초 편차, 1시간·4시간 종목 예외를 보존합니다. 이를 대상3종목의 현재8시간 일정으로 강제하지 않습니다.

공개 coin_gecko_contracts의 실제 식별자, funding_rate·next_funding_rate의 단위, next_funding_rate_timestamp 의미·시각, 현재 종목별 주기를 확인할 새 응답이 없습니다. 이전에 관측하지 않은 값을 합성하거나 다음 예상 요율로 과거 정산 행을 생성하지 않았습니다. 현재 정산 이력 복구 기능이 실제 거래소에서 검증됐다는 주장도 하지 않습니다.

## 발견한 결함과 수정

1. **준비 검사의 펀딩 부호 승인 오류** — `orangex_readiness.mjs`의 `evaluateOrangeXReadiness()`가 positiveRateMeaning=SHORT_PAYS_LONG도 허용했습니다. 비용 검사에서 LONG만 허용하도록 2.8에 수정한 것과 불일치했습니다. 반대 방향을 제출하는 새 테스트에서 **15개 중1개 실패를 재현**하고, 확인된 LONG_PAYS_SHORT만 허용하도록 수정했습니다. 일반 부호 확인으로 실제 종목 요율·일정을 승인하지 않습니다.
2. **종목별 시세 판정의 종료 확인 누락** — `orangex_market_monitor.mjs`의 `OrangeXMarketMonitor.#evaluate()`는 processClosed=false를 막았지만 null/누락은 통과시켰습니다. 전체 진단은 기존에도 INCOMPLETE였으나 개별 시세는 PASS로 표시될 수 있었습니다. 새 테스트에서 **23개 중1개 실패를 재현**하고, 종료 미확인 요청이 있는 시세는 UNVERIFIED·적격성false로 수정했습니다. HTTP200만으로 PASS를 주지 않습니다.
3. **비용 구성 요소별 검증 상태 누락** — `orangex_cost_validation.mjs`의 `evaluateOrangeXCostEvidence()`에 `costComponents`를 추가했습니다. 기존 합성 PAPER 원장을 바꾸거나 새 체결 모델을 넣지 않고 보고만 보완했습니다.

| 구성 요소 | 새 보고 내용 | 미확인 처리 |
|---|---|---|
| fees | 표준 요율과 계정 적용·원필드 정의를 분리 | 실제 비용 추정 null |
| spread | 정상 호가의 숫자 차이·bp 관측, 원시각·현재 나이·만료·무결성 | 숫자 관측 PASS가 주문 크기별 비용 PASS는 아님. 비용은 UNVERIFIED/null |
| slippage | 검증된 주문 크기·수량 환산·체결 모델의 부재 표시 | UNVERIFIED/null |
| funding | 출처·수량 환산·요율·일정·이력 완결성의 상태 | 실제 정산 금액 null |
| total | 미확인 요소가 남아 있다는 상태 | UNVERIFIED/null, 누락 요소를0으로 합산하지 않음 |

호가 최대 나이와 펀딩 최대 나이는 별도 옵션으로 검사합니다. 오래된 호가라도 관측된 숫자 차이는 보존하되 현재 사용은 FAIL입니다. 잘못된 종목·중복·교차 호가도 비용 근거로 통과하지 않습니다. 현재 코드는 검증된 실제 금액 비용 계산기나 자동 진입 활성화 기능이 아닙니다.

## 테스트·Windows·GitHub Actions

| 환경 | 결과 |
|---|---|
| Linux Node.js22.23.4 | **605/605 PASS**, 실패·Skip·취소0 |
| Linux Node.js24.19.0 | **605/605 PASS**, 실패·Skip·취소0 |
| 실제 Windows Node.js22·24 | **UNVERIFIED** — 새 실행 자료 없음, Linux 검사로 대체 주장하지 않음 |
| GitHub Actions 원격 실행 | **UNVERIFIED** — 키 없는 공개 Actions 페이지 조회가 HTTP404. 저장소 부재나 CI 실패로 단정하지 않음 |
| CI 설정 | 기존 Windows/Linux×Node22/24 matrix와 기능 브랜치 push 트리거 유지, 설정 변경 없음 |

기존601개를 유지하고 새4개를 추가했습니다. 펀딩 반대 부호1개, 종료 미확인1개, 비용 분리·호가 오류/만료2개입니다. 테스트를 삭제·Skip하거나 실패 기준을 완화하지 않았습니다. 위 반례의 수정 전 실패 로그와 최종 전체 통과 로그를 보존했습니다.

테스트는 별도 임시 데이터, READ_ONLY, OrangeX 연결OFF, 외부 fetch/WebSocket 차단 상태로 실행했습니다. 로컬 통합 테스트 서버·자식 프로세스에는 필요한 실행 권한을 사용했습니다. 실제 거래소 요청·사용자 Windows 원장·키·알림 전송은 사용하지 않았습니다. 기존 LONG/SHORT·익절·손절·CLOSE·PNL·저장·복구·화면 공통 로직 회귀를 포함하며, 이번 단계 실제 Windows/Chromium 기기 검사를 새로 실행했다고 보고하지 않습니다.

변경은 위3개 검증 모듈과 대응 테스트3개, 이 보고서·README·검증 산출물에 한정합니다. 스캐너·모의매매·PNL·server·adapter·public 화면·Windows 실행기·persistence·설정·백업·Journal·CI 코드는 기준과 동일하게 보존합니다. [최종 검증 기록](reports/orangex29-validation.json)에 코드·보고서·로그 해시와 보존 결과를 기록했습니다.

## 남은 P0 / P1과 PAPER 활성화 조건

1. **P0 입력:** 최신 연속 JSON을 다시 전달해야 합니다. 기대 형식은 `ORANGEX_CONTINUOUS_PUBLIC_DIAGNOSTIC`이며 requests·rounds·monitor·선택적 fundingObservation이 필요합니다. 기존 파일을 전달하면 되며 재실행을 성공으로 가정하지 않습니다.
2. **P0 계약:** 대상별 contract_size 원값, 기본 amount 단위, min_notional 통화·공식, 기초/표시/결제/증거금 역할과 상장 영역·무기한 분류 근거가 필요합니다. 수량·위험 예산·가격 반올림 후 제한을 재검증해야 합니다.
3. **P0 비용:** 표준과 실제 적용 범위를 분리해 검증해야 합니다. 미검증 수수료·스프레드·슬리피지·펀딩이 있는 합계로 위험 한도·수익비를 승인하지 않습니다. 계좌 API·키가 금지된 현재 범위에서 계정 적용률을 확인할 수 없다면 그대로 차단합니다.
4. **P0 펀딩:** 정확한 계약 식별자·요율 단위·현재 주기·다음 시각·정산 가격·누락 내역 복구 범위, 실제 정산 편차를 처리할 검토된 시간 모형이 필요합니다. 예상 값에서 이력을 생성하지 않습니다.
5. **P1 시장:** Mark와 호가의 독립 원시각·PC 시계 상태·monotonic 지연·Date/Age·source 진전·정지 차단·캐시·동시 Binance 가격과 계약 대응을 확인해야 합니다. 기존24초의 원인은 여전히 UNVERIFIED입니다.
6. **P1 운영:** 실제 Windows Node22/24·정확한 커밋의 원격 CI·장기 장애/복구를 확인해야 합니다. 모든 조건이 확인돼도 이번 단계에서 PAPER를 자동 켜지 않으며, 후속 별도 승인과 안전 검토가 필요합니다.

최신 연속 자료를 확인하지 못한 부분은 미완료로 남깁니다. **NOT_READY / READ_ONLY / 실제 데이터 PAPER OFF**를 유지하고 main 변경·Merge와 LIVE 개발은 하지 않습니다.
