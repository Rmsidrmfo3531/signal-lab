# OrangeX 2.8 — 확인된 표준 수수료·일반 펀딩 원리와 남은 검증

기준은 `feat/orangex-readonly`, `2c91c6b`입니다. 아래 공식 웹사이트 내용은 **사용자가 2026-10-31 직접 확인해 전달한 공식 출처 발췌**입니다. 에이전트는 클라우드 CONNECT403으로 원문을 독립 재수집하지 못했습니다. 따라서 문서 정의 확인과 서버 응답·계정 적용의 독립 검증을 구분합니다.

2026-10-31 Windows의 11개 HTTP200, BTC·ETH·SOL 활성 계약과 정상 20단계 호가는 실제 관측으로 보존합니다. 과거 시세가 현재 만료됐다고 그 관측을 합성으로 바꾸거나 삭제하지 않습니다. 실제 계좌·주문 API·키·사용자 원장에는 접근하지 않았습니다.

## 최신·과거 공식 수수료 출처 병렬 대조

| 출처 | 문서 시기 | 제공된 공식 설명 | 판정·범위 |
|---|---|---|---|
| [Maker/Taker Fees Explained](https://www.orangex.com/support/faq/articles/1764-orangex-maker-taker-fees-explained) | **2026-09-16 업데이트** | 표준 무기한 Maker **0.02%=0.0002**, Taker **0.06%=0.0006**. 수수료=실제 체결 명목금액×적용 요율 | **PASS — 사용자 확인 최신 표준 정의**, 실제 계정 적용은 UNVERIFIED |
| [API get_instruments](https://openapi-docs.orangex.com/#get-instruments) | 버전/업데이트일 미제공 | maker_commission·taker_commission, 파생상품은 거래대금 비율에 따라 USDT로 수수료 징수 | 사용자 확인 API 설명. 종목 응답 원값과 실제 계정 최종률의 관계는 별도 확인 |
| [Futures Fee Structure & Fee Calculations](https://support.orangex.com/hc/en-us/articles/16774208296727-Futures-Fee-Structure-Fee-Calculations) | **2023년 문서**, 정확한 날짜 미제공 | Taker **0.05%=0.0005** | **과거·최신 서술 차이 확인**. 현재 계정 요율로 선택하지 않음 |

최신·과거 자료의 Taker 0.06%/0.05%를 한 값으로 합치지 않았습니다. 사용자 제공 자료에는 과거 Maker 수치가 없으므로 만들어 채우지 않습니다. 이 차이를 단위 오류라고 임의 결론내리지 않으며, 문서 시기와 적용 범위를 보존합니다. 최신 표준이 확인됐다는 사실만으로 실제 계정에 최신 표준이 적용된다고 확정하지 않습니다.

## 실제 원값과 표준의 수학적 일치

Windows 진단의 `diagnostic.markets[*].contractFields`에서 세 종목 모두 Maker **0.0002**, Taker **0.0006**을 관측했습니다. 원행 출처는 PERPETUAL 목록의 `result[17]`/`result[31]`/`result[66]`입니다. 이 값은 최신 문서의 표준 요율을 분수로 표현한 값과 **수학적으로 일치 — PASS**입니다.

그러나 실제 계정의 VIP 등급·할인·프로모션·리베이트와 API 원값의 최종 적용 여부는 **UNVERIFIED**입니다. `accountChecked:false`인 공개 목록으로 계정 적용률을 확인한 것처럼 보고하지 않습니다. 과거 요율 0.0005를 더 낮은 비용이라는 이유로 선택하지도 않습니다.

명세가 없던 초기 검토에서는 FRACTION/%/bp를 가정별로 비교했지만, 새 사용자 확인 문서에 따라 **공개 표준 정의는 FRACTION 0.0002/0.0006으로 기록**합니다. 이는 계정별 실제 수수료를 계산하기 위한 자동 승인과 다릅니다.

## 계산식과 부분 체결 역할

공식 최신 표준 설명의 계산식은 `수수료 = 실제 체결 명목금액 × 적용 수수료율`입니다. 1,000 USDT 체결이라는 문서 예시에서 표준 Maker는 **0.20 USDT**, 표준 Taker는 **0.60 USDT**입니다. 이 예시는 실제 사용자 거래·계정 청구액이 아닙니다.

한 주문도 일부 Taker·일부 Maker로 체결될 수 있습니다. 실제 체결별 명목금액과 유동성 역할을 나누어 `sum(N_fill × r_applicable_role)`로 계산해야 합니다. **지정가 주문이라는 이유만으로 전체에 Maker 요율을 적용하면 안 됩니다.** 현재 합성 PAPER의 Taker 가정도 실제 거래소의 체결 역할 확인 결과가 아닙니다.

주문 수량에서 명목금액을 만드는 공식은 아직 확정하지 않았습니다. [USDT 증거금 선물 일반 설명](https://www.orangex.com/support/faq/articles/390-margined-futures-contracts)은 선형 계약과 BTC/USDT·ETH/USDT 기초자산 단위 예시를 안내하지만, SOL의 계약 크기나 개별 상품의 주문 단위를 자동 확정하는 근거로 쓰지 않습니다.

[buy](https://openapi-docs.orangex.com/#buy) / [sell](https://openapi-docs.orangex.com/#sell) 문서의 `market_amount_order=true`는 amount를 USDT 가치로 해석하고 기본값은 false입니다. **false일 때 amount가 계약 수인지 기초자산 수량인지 해당 설명만으로 확정되지 않습니다.** 해당 사설 API는 문서만 기록했으며 호출·주문 기능을 구현하지 않았습니다. 요청 성공이 실제 체결 완료를 뜻하지 않는다는 설명도 보존했습니다.

따라서 q가 기초자산이면 `Q_base=q`, 계약 수이면 `Q_base=q×contract_size_base`라는 수식은 그 관계가 상품별로 검증된 뒤에만 사용할 수 있습니다. 현재 실제 계약 크기·기본 주문 단위가 미확인이라 어느 식도 실제 주문 크기로 적용하지 않았고 1을 기본 계약 크기로 넣지 않았습니다.

`min_notional` 설명의 **baseCurrency** 표현도 독립적으로 불명확합니다. BTC10/ETH10/SOL100의 원값을 USD/USDT로 강제 해석하지 않습니다. min_qty·min_trade_amount·min_notional은 각각 최소 수량·증분·최소 명목 조건이며 서로 대체하지 않습니다.

## 확인된 일반 펀딩 원리와 시각

사용자가 확인한 [공식 펀딩 설명](https://www.orangex.com/support/1/articles/394-funding-rates-btc-imn?mid=152-1054-1056)은 **2026-09-16 업데이트**이며 다음을 안내합니다.

- `펀딩 금액 = 포지션 명목가치 × 펀딩 요율`
- `포지션 명목가치 = Mark Price × 포지션 기초자산 수량`
- **양수 요율은 LONG이 SHORT에게 지급**, 음수는 SHORT이 LONG에게 지급
- 해당 정산 시점에 포지션이 있어야 지급·수령 대상
- 일반 UTC **00:00·08:00·16:00**, KST **09:00·17:00·다음 날 01:00**
- 실제 정산 시각에 약 **15초 편차**가 있을 수 있음

이 일반 원리는 **문서 정의 PASS**입니다. 요율을 검증된 분수 r로 변환했다면 지급 비용의 부호를 `direction × abs(Q_base × Mark) × r`로 표현할 수 있습니다. direction은 LONG +1, SHORT -1이며 음수 비용은 수령입니다. 그러나 **BTC·ETH·SOL 각각의 현재 r·실제 수량 변환·일정·정산 행은 여전히 UNVERIFIED**이므로 실제 금액은 계산하지 않습니다.

8시간을 모든 종목의 불변 규칙으로 적용하지 않습니다. 공식 공지의 [1시간 정산 사례](https://www.orangex.com/support/help/articles/1196-funding-rates-sign), [4시간 정산 사례](https://www.orangex.com/support/help/articles/1193-funding-rates-zora)를 별도 출처로 기록했습니다. 이 사례를 BTC·ETH·SOL의 현재 일정으로 복사하지 않았습니다.

## 공개 펀딩 필드와 누락 내역 복구

사용자가 확인한 API 문서의 CoinGecko → Contracts는 `/public/coin_gecko_contracts`의 `funding_rate`, `next_funding_rate`, `next_funding_rate_timestamp`를 안내합니다. endpoint·필드 문서와 실제 응답 수집은 다릅니다. 다음은 아직 미확인입니다.

- 응답 스키마·상품 식별자와 BTC/ETH/SOL의 정확한 대응
- 요율의 단위, 현재/예상 요율의 차이와 최신성
- next_funding_rate_timestamp가 실제 다음 정산 시각을 의미하는지
- 상품별 현재 주기·예정/실제 정산 행·변경 공지 적용
- 과거 정산 내역 endpoint·보존 기간·페이지 완결성·누락 복구 가능 범위

현재 또는 다음 예상 요율 하나로 과거 지급/수령·사용자 계좌 정산을 복구할 수 없습니다. 실제 계정 정산 원장은 이번 키 미사용 범위 밖입니다. 확인하지 못한 funding을 0원으로 넣지 않습니다.

기존 비용 복구 검증은 **정확한 명목 슬롯 timestamp 모형**만 지원합니다. 일반 문서의 ±15초를 모든 상품에 자동 적용하지 않습니다. 실제 정산 시각 의미나 명시적인 nonzero tolerance를 입력하면 `UNVERIFIED / UNSUPPORTED_SETTLEMENT_TIME_MODEL`로 구분합니다. 실제 정산 행의 10초 편차를 무조건 누락/위조로 FAIL 처리하거나, 확인되지 않은 15초 grace를 자동 허용하지 않습니다. 실제 시각 허용 오차·현재 마지막 확정 슬롯·동일 슬롯 중복 검사 구현은 별도 상품 증거와 검증이 필요합니다.

## 코드의 문서 확인과 운영 준비 분리

`orangex_official_sources.mjs`는 위 출처·날짜·버전 차이·공식 일반 정의를 기록합니다. provenance는 `USER_CONFIRMED_OFFICIAL_SOURCE_EXCERPTS`, `independentlyRetrievedByAgent:false`, `automaticOperationalProof:false`입니다. 문서의 실제 본문을 내려받았거나 서버 출처를 인증했다고 표현하지 않습니다.

`reviewOrangeXDocumentedStandards()`는 표준 수수료·원값 수학 일치·일반 펀딩 원리를 별도 documentary PASS로 보고합니다. `evaluateOrangeXCostEvidence()`의 `documentaryStandards`에서 이를 확인할 수 있습니다. 기존 operational checks는 별도의 응답 출처·원필드 의미·계정 적용·계약 환산·실제 펀딩 관측·복구 근거가 필요하므로 자동 승격하지 않았습니다.

명시적 operational proof가 없는 실제 세 종목은 기존 operational **3 PASS / 0 FAIL / 9 UNVERIFIED, NOT_READY**를 유지합니다. documentary 결과의 PASS를 합쳐 운영 준비가 확인됐다고 표시하지 않습니다. `publicFeeRateFractions`는 운영 원필드 proof가 없으면 null이며, `documentaryStandards.standardFees`에는 문서상 표준 값이 있습니다. `effectiveAccountFeeRates`, 실제 수수료·펀딩 추정치는 null입니다.

모든 경로에서 PAPER·LIVE 활성화는 false입니다. 기존 합성 PAPER 회계·PNL·설정·백업과 실제 데이터 자동 진입 OFF를 변경하지 않았습니다. 테스트의 hypothetical proof나 synthetic funding을 실제 규격·계정 적용·실제 정산 결과로 기록하지 않습니다.
