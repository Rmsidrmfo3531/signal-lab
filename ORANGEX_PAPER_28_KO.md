# OrangeX 2.8 — 공식 계약·비용과 연속 공개 시세 검증

대상은 `Rmsidrmfo3531/signal-lab`, `feat/orangex-readonly`, 기준 `2c91c6b`입니다. `ORANGEX_PAPER_27_KO.md`, 기존 Windows 검토 보고서·review.json·첨부 원본을 재사용했습니다. **종합 판정은 NOT_READY입니다.**

계약 검증 오류를 수정하고, 사용자 확인 공식 출처 등록·표준 비용 대조·읽기 전용 수량 검사·연속 공개 진단을 구현했습니다. **READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF**를 유지합니다. 키·계좌·주문·취소·출금 API 사용, LIVE 구현, 사용자 데이터 변경, Journal 운영 연결, main 변경·Merge는 없습니다.

## 증거의 종류와 범위

| 자료 | 실제 확인 내용 | 한계 |
|---|---|---|
| 2026-10-31 Windows 공개 진단 | 실제 공개 요청 11/11 HTTP200, BTC·ETH·SOL 활성 상장, 정상 20단계 호가와 종목별 Mark | 사용자 제공 정규화 관측 요약이며 전체 HTTP 응답 원문·서버 출처 독립 인증 자료는 아님 |
| 사용자 확인 공식 출처 발췌 | 필드 정의, 최신 표준 요율, 일반 펀딩 원리, 과거 문서와 차이 | 사용자가 2026-10-31 직접 확인해 전달한 자료. 에이전트의 원문 독립 재수집은 아님 |
| 합성 단위·통합 검사 | 수량·비용·호가·시각·실패 처리 반례, 연속 source 정지 시 차단 | 거래소 실측·수익률·실제 체결 정확성의 증거가 아님 |
| 이번 클라우드 실제 GET | 문서와 BTC 호가 각각 CONNECT403, curl56, 거래소 HTTP 응답 없음 | 프록시 정책 실패이며 DNS·TLS·OrangeX 서버 장애로 해석하지 않음 |

Windows 원본 `orangex-public-20261031T005917Z-edaabd29a09c778d6282.json`의 SHA256은 **`cf094ef5d29368a38f3b795f55462fbafa0e13b88ad7d5049c8bcbbb22ac3c41`**입니다. 원본·이전 검토 파일을 수정하지 않았습니다. 공개 필드만 선별한 [2.8 증거 JSON](reports/orangex28-evidence.json)에 출처와 판정을 분리했습니다.

수집 완료는 **2026-10-31 09:59:19.246 KST**입니다. 당시 준비 검사 **11 PASS / 0 FAIL / 43 UNVERIFIED**를 보존했고, 현재 재평가는 시세 만료로 **5 PASS / 6 FAIL / 43 UNVERIFIED**입니다. 만료는 당시 정상 관측을 취소하지 않으며, 과거 시세를 현재 진입에 사용할 수도 없습니다. 이 54개 항목과 신규 문서·비용 검사는 범위가 달라 PASS 수를 합산하지 않습니다.

## 공식 명세와 실제 상장 영역

사용자 확인 [get_instruments](https://openapi-docs.orangex.com/#get-instruments)의 의미를 반영했습니다.

- `min_qty`: 최소 주문 수량. `min_trade_amount`: 최소 거래 수량 **증분**.
- `contract_size`: 계약 크기. `tick_size`: 최소 가격 변동 단위.
- `min_notional`: 설명에 **baseCurrency**가 등장하나 기준 통화는 불명확. USD/USDT로 확정하지 않음.
- `is_active`: 거래 가능 상태. `kind`: 상품 유형.

문서의 currency 예시 `BTC·ETH·SPOT`와 실제 목록을 구분했습니다. 실측에서 BTC·ETH 영역은 0개, SPOT은 357개이며 대상 무기한 계약은 없었습니다. **PERPETUAL 영역 601개 중 대상 3개**를 발견했습니다. 이는 실제 목록 발견 PASS이지만 전체 공식 enum·PERPETUAL 영역 의미가 확인됐다는 뜻은 아닙니다. 기존 PERPETUAL 후보의 운영 적격성 차단을 자동 해제하지 않았습니다.

문서 `kind=future`와 관측 `kind=perpetual`을 같은 것으로 가정하지 않습니다. future에는 만기 계약도 포함될 수 있습니다. 검토된 무기한 역할·실제 settlement_period·정확한 계약명·상장 영역 근거가 함께 없는 일반 future는 UNVERIFIED입니다.

[USDT 증거금 선물 설명](https://www.orangex.com/support/faq/articles/390-margined-futures-contracts)은 선형 계약과 BTC/USDT·ETH/USDT 기초자산 예시를 안내합니다. 이를 SOL 계약 크기·기본 주문 수량 단위에 자동 적용하지 않습니다. [buy](https://openapi-docs.orangex.com/#buy)·[sell](https://openapi-docs.orangex.com/#sell) **문서**의 `market_amount_order=true`는 amount를 USDT 가치로 해석하고 기본값은 false입니다. false일 때 계약 수/기초자산 수량의 구분은 여전히 UNVERIFIED입니다. 사설 API 호출·주문 구현은 없습니다.

## 종목별 실제 값과 판정

다음 표의 실제 값은 Windows 수집 시점의 값입니다. 문서 근거는 모두 사용자 확인 발췌이며, 에이전트가 독립적으로 다운로드한 원문으로 표시하지 않습니다.

### BTC-USDT-PERPETUAL

| 항목 | 실제 값 | 공식 근거 | 판정 |
|---|---|---|---|
| 계약 유형·크기 | 활성 상장, kind=perpetual. contract_size는 첨부에 미수집 | get_instruments 계약 크기 정의, 일반 USDT 선형 선물 설명 | 상장·활성 관측 PASS / 계약별 크기·유형 대응 UNVERIFIED |
| 주문 수량 단위 | 미수집 | buy/sell: 금액 모드 true는 USDT, 기본 false 단위는 불명확 | UNVERIFIED |
| 최소 수량·증분 | **min_qty=0.001 / min_trade_amount=0.001**. min_notional=10, 통화 미확인 | get_instruments: 최소량과 증분은 별도 조건, baseCurrency 설명은 불명확 | 원값·정의 구분 PASS / 실제 단위·명목 통화 UNVERIFIED |
| 가격 단위 | tick_size=0.1, 양쪽 40레벨 수치 격자 일치 | get_instruments tick_size 정의 | 수치 격자 PASS / 상품별 표시 통화 의미 UNVERIFIED |
| Maker/Taker 비용 | 원값 0.0002 / 0.0006 | 최신 2026-09-16 표준 0.02% / 0.06% | 최신 표준·수학 일치 PASS / 계정 적용률 UNVERIFIED |
| 펀딩 | 실제 요율·정산 일정·이력 미수집 | 2026-09-16 일반 Mark 기준·부호·정산 설명. 종목별 예외 존재 | 일반 원리 PASS / 현재 종목 요율·일정·복구 UNVERIFIED |
| 시세 신선도 | Bid / Ask / Mark: 77514.6 / 77514.7 / 77514.6. 호가 24.418초 / Mark 24.897초. 정상 20+20 레벨 | 로컬 최대 나이 90초 검사. 원 timestamp 의미·시계차 미확인 | 수집 당시 PASS / 현재 FAIL / 연속 실측 UNVERIFIED |
| Binance 대응 | BTCUSDT는 이름 후보. 동시 Binance 관측 없음 | 양쪽 계약 유형·기초/표시/정산 통화와 수량 단위 필요 | UNVERIFIED |

### ETH-USDT-PERPETUAL

| 항목 | 실제 값 | 공식 근거 | 판정 |
|---|---|---|---|
| 계약 유형·크기 | 활성 상장, kind=perpetual. contract_size는 첨부에 미수집 | get_instruments 계약 크기 정의, 일반 USDT 선형 선물 설명 | 상장·활성 관측 PASS / 계약별 크기·유형 대응 UNVERIFIED |
| 주문 수량 단위 | 미수집 | buy/sell: 금액 모드 true는 USDT, 기본 false 단위는 불명확 | UNVERIFIED |
| 최소 수량·증분 | **min_qty=0.01 / min_trade_amount=0.01**. min_notional=10, 통화 미확인 | get_instruments: 최소량과 증분은 별도 조건, baseCurrency 설명은 불명확 | 원값·정의 구분 PASS / 실제 단위·명목 통화 UNVERIFIED |
| 가격 단위 | tick_size=0.01, 양쪽 40레벨 수치 격자 일치 | get_instruments tick_size 정의 | 수치 격자 PASS / 상품별 표시 통화 의미 UNVERIFIED |
| Maker/Taker 비용 | 원값 0.0002 / 0.0006 | 최신 2026-09-16 표준 0.02% / 0.06% | 최신 표준·수학 일치 PASS / 계정 적용률 UNVERIFIED |
| 펀딩 | 실제 요율·정산 일정·이력 미수집 | 2026-09-16 일반 Mark 기준·부호·정산 설명. 종목별 예외 존재 | 일반 원리 PASS / 현재 종목 요율·일정·복구 UNVERIFIED |
| 시세 신선도 | Bid / Ask / Mark: 2248.76 / 2248.77 / 2248.76. 호가 24.148초 / Mark 24.615초. 정상 20+20 레벨 | 로컬 최대 나이 90초 검사. 원 timestamp 의미·시계차 미확인 | 수집 당시 PASS / 현재 FAIL / 연속 실측 UNVERIFIED |
| Binance 대응 | ETHUSDT는 이름 후보. 동시 Binance 관측 없음 | 양쪽 계약 유형·기초/표시/정산 통화와 수량 단위 필요 | UNVERIFIED |

### SOL-USDT-PERPETUAL

| 항목 | 실제 값 | 공식 근거 | 판정 |
|---|---|---|---|
| 계약 유형·크기 | 활성 상장, kind=perpetual. contract_size는 첨부에 미수집 | get_instruments 계약 크기 정의, 일반 USDT 선형 선물 설명 | 상장·활성 관측 PASS / 계약별 크기·유형 대응 UNVERIFIED |
| 주문 수량 단위 | 미수집 | buy/sell: 금액 모드 true는 USDT, 기본 false 단위는 불명확 | UNVERIFIED |
| 최소 수량·증분 | **min_qty=1 / min_trade_amount=0.1**. min_notional=100, 통화 미확인 | get_instruments: 최소량과 증분은 별도 조건, baseCurrency 설명은 불명확 | 원값·정의 구분 PASS / 실제 단위·명목 통화 UNVERIFIED |
| 가격 단위 | tick_size=0.01, 양쪽 40레벨 수치 격자 일치 | get_instruments tick_size 정의 | 수치 격자 PASS / 상품별 표시 통화 의미 UNVERIFIED |
| Maker/Taker 비용 | 원값 0.0002 / 0.0006 | 최신 2026-09-16 표준 0.02% / 0.06% | 최신 표준·수학 일치 PASS / 계정 적용률 UNVERIFIED |
| 펀딩 | 실제 요율·정산 일정·이력 미수집 | 2026-09-16 일반 Mark 기준·부호·정산 설명. 종목별 예외 존재 | 일반 원리 PASS / 현재 종목 요율·일정·복구 UNVERIFIED |
| 시세 신선도 | Bid / Ask / Mark: 96.71 / 96.72 / 96.71. 호가 23.858초 / Mark 24.475초. 정상 20+20 레벨 | 로컬 최대 나이 90초 검사. 원 timestamp 의미·시계차 미확인 | 수집 당시 PASS / 현재 FAIL / 연속 실측 UNVERIFIED |
| Binance 대응 | SOLUSDT는 이름 후보. 동시 Binance 관측 없음 | 양쪽 계약 유형·기초/표시/정산 통화와 수량 단위 필요 | UNVERIFIED |

세 종목 모두 원필드 `base_currency=USDT`, `quote_currency=BTC/ETH/SOL`입니다. 일반적인 필드 이름 관행으로 뒤집거나 정산 통화를 채우지 않았습니다. `contract_size`는 **첨부에 미수집**이며 API 자체에 없다고 단정하지 않습니다. 호가 40레벨의 tick 격자 일치는 관측 사실이지 주문 수량·계약 규격 전체 인증은 아닙니다.

## 수량·가격 검증과 수정 내용

기존 readiness가 min_trade_amount를 최소량 proof로 허용하면서 증분에서는 제외하던 오류를 수정했습니다. 최소량은 min_qty만 허용하고, min_trade_amount는 검토된 수량 증분 원필드로 지원합니다. 다른 qty_step을 선택해 충돌하는 min_trade_amount를 숨기지 못하게 했습니다. 단위 대응이 없거나 상충하면 차단합니다.

읽기 전용 `orangex_contract_validation.mjs`는 BigInt 기반 소수 연산으로 지원 가능한 검토 규칙을 검사합니다.

```text
q >= min_qty
q / reviewed_increment 는 정수
price / reviewed_tick 는 정수
검토된 단위·명목 공식으로 계산한 명목금액 >= 검토된 최소 명목금액
```

SOL의 원값에서 순수 산술상 0.9는 최소량1 미달, 1.05는 증분0.1 위반, 1.1은 두 숫자 규칙을 만족합니다. **1.1 SOL 또는 1.1계약의 진입 승인이 아닙니다.** 실제 단위·계약 크기·명목 통화가 없으므로 실제 증거의 notional은 null, 결과는 NOT_READY입니다.

수량은 검토된 위험 예산으로 계산한 뒤 증분 아래로 절삭해야 합니다. 최소량을 맞추려고 올리지 않습니다. 0.99를0.1 격자로 절삭하면0.9이며 최소1 미달로 거부합니다. 가격 목적별 반올림은 다음과 같습니다.

| 목적 | BUY / LONG | SELL / SHORT |
|---|---|---|
| 지정가 가격 한도 보존 | 최대 매수가를 넘지 않도록 내림 | 최소 매도가보다 낮아지지 않도록 올림 |
| 보수적 위험 계획 | LONG 진입 올림·손절 내림 | SHORT 진입 내림·손절 올림 |

반올림 후 위험·수량·가격 구조를 다시 계산해야 합니다. 거래소 stop trigger를 검증하거나 주문을 보내는 기능은 아닙니다. 선형 계약과 단위가 검토된 경우에만 기초자산 수량 `N=q×P`, 계약 수 `N=q×contract_size_base×P`를 지원합니다. 미확인 contract_size를1로 채우지 않습니다.

## 표준 수수료와 펀딩: 확인된 사실·미확인 적용

상세 출처는 [비용·펀딩 보고서](ORANGEX_COSTS_28_KO.md), 코드상 출처·날짜는 `orangex_official_sources.mjs`에 있습니다.

| 출처 | 시기 | 확인한 내용 | 적용 한계 |
|---|---|---|---|
| [최신 Maker/Taker 설명](https://www.orangex.com/support/faq/articles/1764-orangex-maker-taker-fees-explained) | 2026-09-16 업데이트 | 표준 Maker0.02%=0.0002 / Taker0.06%=0.0006. 실제 체결 명목금액×적용 요율 | 실제 계정 등급·할인 UNVERIFIED |
| [API get_instruments](https://openapi-docs.orangex.com/#get-instruments) | 버전일 미제공 | commission 관련 필드, 파생상품 거래대금 비율에 따른 USDT 수수료 설명 | API 원값과 계정 최종 적용률 관계 별도 확인 |
| [과거 Futures Fee Structure](https://support.orangex.com/hc/en-us/articles/16774208296727-Futures-Fee-Structure-Fee-Calculations) | 2023년, 정확한 날짜 미제공 | Taker0.05%=0.0005 | 최신0.06%와 차이 보존. 임의로 낮은 요율 선택 안 함 |

1,000USDT 체결의 **문서 예시**는 표준 Maker0.20USDT, Taker0.60USDT입니다. 실제 사용자 청구액이 아닙니다. 한 주문에 Maker·Taker 부분 체결이 섞일 수 있으므로 체결별 명목·유동성 역할을 구분해야 합니다. 지정가가 항상 Maker인 것은 아닙니다.

[공식 일반 펀딩 설명](https://www.orangex.com/support/1/articles/394-funding-rates-btc-imn?mid=152-1054-1056), 2026-09-16 업데이트:

- 펀딩=포지션 명목가치×요율, 명목가치=Mark×기초자산 보유 수량.
- 양수 요율은 LONG이 SHORT에게 지급, 음수는 SHORT이 LONG에게 지급.
- 정산 시점에 포지션을 보유해야 참여.
- 일반 UTC00:00·08:00·16:00, KST09:00·17:00·다음 날01:00, 실제 정산 약15초 편차 가능.
- [1시간 정산 공지](https://www.orangex.com/support/help/articles/1196-funding-rates-sign), [4시간 정산 공지](https://www.orangex.com/support/help/articles/1193-funding-rates-zora)가 있으므로 BTC·ETH·SOL에8시간을 강제하지 않음.

일반 원리는 확인했지만 현재 종목 요율·단위·주기·다음 정산·실제 정산 행과 복구 범위는 미확인입니다. 비용 검증에서 양수 지급자를 SHORT으로 제출해도 통과하던 오류를 반례로 재현하고, 확인된 LONG 지급 규칙과 충돌하면 실패하도록 수정했습니다.

공개 `/public/coin_gecko_contracts`의 문서상 funding_rate·next_funding_rate·next_funding_rate_timestamp는 선택적인 공개 관측 도구로 추가했습니다. **아직 실제 응답을 수집하지 못했습니다.** 정확한 instrument_name만 대응시키고 ticker_id를 추측하지 않습니다. 예상 요율을 실제 정산으로 바꾸거나 로컬 수신 시각을 펀딩 시각으로 쓰지 않습니다. 필드 단위·스키마·다음 시각 의미는 계속 UNVERIFIED입니다.

현재 요율 하나로 누락 정산 내역을 복구할 수 없습니다. 현재 비용 복구 검사는 검토된 정확한 명목 정산 슬롯 모형만 지원합니다. 실제 정산 시각 의미·nonzero tolerance가 주어지면 `UNSUPPORTED_SETTLEMENT_TIME_MODEL / UNVERIFIED`입니다. 일반 문서의15초를 상품별 허용 오차로 자동 적용하지 않습니다.

각 실제 종목의 **문서 검사 4 PASS / 0 FAIL / 5 UNVERIFIED**와 **운영 비용 검사 3 PASS / 0 FAIL / 9 UNVERIFIED**를 분리했습니다. 문서 출처는 `USER_CONFIRMED_OFFICIAL_SOURCE_EXCERPTS`, 독립 재수집·자동 운영 proof 주입은 false입니다. 표준 수수료 확인을 실제 계정 적용으로 승격하지 않았습니다. 실제 수수료·펀딩 추정치는 **0이 아닌 null**이며 실행 권한은 false입니다.

## 약24초의 원인과 연속 공개 진단

Windows 단발 자료의 요청 창은 약1.898초이고 시세 나이는 약24초였습니다. **24초를 요청 지연이라고 단정할 근거가 없습니다.** API 마지막 갱신 의미·거래량·캐시·PC 시계차·요청 지연 중 원인은 UNVERIFIED입니다. 원본에는 endpoint별 monotonic 시간·HTTP Date/Age·독립 시각 관측이 없습니다.

이번 클라우드에서 문서·BTC 호가를 각각 한 번 GET했으나 **PROXY_CONNECT_REJECTED / CONNECT403 / curl56**, 거래소 httpStatus=null이었습니다. 정책은 restricted/enforced이고 두 도메인은 허용되지 않습니다. 우회·반복 재시도하지 않았습니다. Windows 성공을 취소하지 않으며, 프록시 거부 시간을 거래소 RTT로 기록하지 않습니다. 실제 연속 성공률·응답시간·갱신 정지 원인은 아직 UNVERIFIED입니다.

`orangex_market_monitor.mjs`와 연속 진단 CLI는 다음을 계측합니다.

- 고정된 OrangeX 공개 티커·호가 GET과 선택적 공개 펀딩, 선택적 Binance exchangeInfo·bookTicker·time. 키·.env·임의 URL·서버·원장 접근 없음.
- HTTP 성공률과 신선·정상 시세 비율 분리, 로컬 시작/종료 시각·monotonic 소요시간·curl전체/TTFB·원본 source timestamp 기록.
- Date/Age·제한된 cache 지시자만 출력. Date는 edge/cache 시각일 수 있으며 시세 적격성 시간을 보정하지 않음. 로컬 시각 오류 시 오차 추정은 null.
- Mark와 호가의 나이·역행·갱신 정지를 독립 검사. 일반 ticker.timestamp를 공식 Mark 갱신 시각으로 확정하지 않음.
- 중복·역순·교차·무효 레벨 차단. BTC/ETH 등 종목이 섞인 가격 비교·Mark/호가를 거부.
- HTTP200이어도 스키마·시각·요청 종료 확인 또는 선택한 Binance/펀딩 관측이 실패하면 완료 성공으로 처리하지 않음.
- 첫 프록시/정책/연결/정리 실패에서 확장 요청 중지. 401·403·429·451도 중지. 최대12round, 새 요청 시작 예산180초이며 마지막 timeout/정리는 전체 wallclock을 더 늘릴 수 있음.
- 합성 모드에는 주입된 가짜 transport가 필수. 합성 표식을 붙여 실제 공개 요청을 보내는 경로 차단.

Windows 새 ZIP 폴더에서 키 없이 실행할 수 있습니다. 실제 Windows 실행은 이번 작업에서 하지 않았습니다. stdout JSON은 기존 데이터 경로와 다른 새 임시 파일로 보관하세요.

```text
npm run --silent diagnose:orangex:continuous -- --rounds 8 --interval-ms 5000 --funding
```

`--funding`은 새 공개 펀딩 원필드 관측을 추가합니다. 실제 응답의 식별자가 지원 스키마와 다르면 UNVERIFIED로 남기며, 실패를0원으로 대체하지 않습니다. Binance 공개 비교는 기본 포함하고 `--without-binance`로 제외할 수 있습니다. 이 경우 대응 검증 근거는 확보되지 않습니다.

최대 나이 기본90초, 갱신 정지 한도 기본30초이며90초를 넘겨 차단을 완화하는 옵션은 거부합니다. 충분한 관측 창이 없는 짧은 실행은 정지 정책 검증 기간이 부족하다고 표시합니다. 몇 회의 성공은 장기 운영 검증이 아닙니다. 새 보고 형식은 `ORANGEX_CONTINUOUS_PUBLIC_DIAGNOSTIC`이며 기존 단발 review CLI의 입력 형식과 다릅니다.

합성 결과 [JSON](reports/orangex28-continuous-synthetic.json)은4round·15초 간격·가짜 요청5ms의 두 시나리오입니다. 정상 진전은 완료되고, source가 멈춘 경우 마지막 나이가69.120초로90초 이내여도30초 정지 규칙 때문에 거부됩니다. 첫 수집 PASS는 보존됩니다. **이5ms·성공률은 가짜 시계의 테스트 값이며 실제 거래소 성능이 아닙니다.**

## 테스트·보존·변경 파일

Linux에서 임시 데이터·외부 거래소 연결 차단 조건으로 기본 Node 테스트 실행기를 사용했습니다.

| 실행 환경 | 전체 | 통과 | 실패 | Skip/취소 |
|---|---:|---:|---:|---:|
| Linux Node.js22.23.4 | 601 | 601 | 0 | 0 |
| Linux Node.js24.19.0 | 601 | 601 | 0 | 0 |
| 실제 Windows / 원격 GitHub Actions 4환경 | — | — | — | 이번 작업에서 미확인 |

기존 테스트를 제거하거나 실패 조건을 약화하지 않았습니다. 실제 테스트 케이스 수이며 파일 수74를 테스트 수로 보고하지 않았습니다. 기존 LONG/SHORT·분할 익절·손절·CLOSE·PNL·복구·화면 공통 로직 회귀를 포함합니다. 이번 단계 Chromium 실기기/4화면 재실행은 하지 않았고 public 화면 파일은 변경하지 않았습니다.

초기 제한 sandbox에서는 localhost EPERM·자식 프로세스 출력/테스트 집계 제약으로 실패했습니다. 로컬 테스트 서버·IPC 실행 권한을 확보한 뒤 같은 검증을 재실행해 해결했습니다. 외부 거래소 연결 차단은 유지했습니다. 최종 리뷰에서 펀딩 부호 반례는 수정 전9개 중1개 실패를 실제 확인한 뒤 수정했고, 최종 전체 재실행은 위처럼 통과했습니다. 실패를 숨기거나 테스트를 건너뛰지 않았습니다.

- 수정: `orangex_readiness.mjs`, `package.json`, `updater.mjs`, 관련 readiness/updater 테스트, README.
- 신규 계약 검사: `orangex_contract_validation.mjs`와 테스트.
- 신규 비용·출처 검사: `orangex_cost_validation.mjs`, `orangex_official_sources.mjs`와 테스트, 비용 보고서.
- 신규 공개 계측: `orangex_market_monitor.mjs`, `orangex_funding_observation.mjs`, `scripts/diagnose-orangex-continuous.mjs`와 테스트.
- 검증 산출물: 이 보고서와 `reports/orangex28-*.json`.

기존 engine·quality·execution·markets·paper·signal_lifecycle·persistence·server·OrangeX adapter/PAPER/store/Journal·public 화면·trade_plan·Windows 실행/백업 도구·CI 설정은 기준 커밋과 바이트 동일하게 보존했습니다. 신규 모듈은 서버·체결 경로에 연결하지 않았습니다. updater는 새 코드 경로만 허용하고 사용자 설정·거래·백업 경로 금지는 유지합니다. [검증 요약](reports/orangex28-validation.json)에 테스트 로그 해시·코드 해시·보존 확인을 기록했습니다.

## 남은 차단 조건과 다음 작업

1. **P0 계약:** BTC·ETH·SOL별 contract_size 원값, 기본 amount 단위, min_notional 통화, 기초/표시/정산 통화, 공식 currency 전체 범위·PERPETUAL 역할, future/무기한 분류 근거를 확보해야 합니다. 현재 상장 발견 PASS만으로 계약 환산을 승인하지 않습니다.
2. **P0 비용:** 최신 표준은 확인했으나 실제 적용 범위·계정 등급/할인과 API 원필드의 관계는 미확인입니다. 공개 자료만으로 확인할 수 없다면 이번 키 미사용 범위의 한계로 남겨야 합니다. 미확인 비용을0으로 두지 않습니다.
3. **P0 펀딩:** 종목별 실제 요율 단위·정산 주기/시각·Mark 기준 수량·누락 이력 복구 범위가 필요합니다. 공개 예상 요율만으로 실제 정산을 만들지 않습니다. 실제 정산 편차를 처리할 검토된 시간 모형도 필요합니다.
4. **P1 시세:** Windows에서 연속 JSON과 PC 시간 동기화 상태를 확보해 endpoint별 지연·source 진전·Date/Age·명시적 Mark 시각·Binance 동시 비교를 확인해야 합니다.24초 원인을 한 번의 관측으로 결론내리지 않습니다.
5. **P1 운영:** Windows·Node22/24·프록시·프로세스 종료·장기 실행과 원격 CI 상태를 별도로 확인해야 합니다. 연속 진단 성공도 실제 데이터 PAPER 활성화 승인이나 실거래 안전 확인을 대신하지 않습니다.

다음 Codex 지시문:

> feat/orangex-readonly의 OrangeX2.8 보고서와 새 Windows 연속 공개 진단 JSON을 검토하라. 실제 과거 관측·현재 적격성·사용자 확인 문서·합성을 분리하라. BTC/ETH/SOL 계약 크기·amount/min_notional 단위·상장 영역·펀딩 스키마/주기/부호/이력과 종목 식별자를 공식 출처와 대조하라. 원값이 없으면 채우지 말고 UNVERIFIED를 유지하라. 시각·캐시·요청 지연·갱신 정지를 계측값으로 분리하고 Windows Node22/24 테스트를 확인하라. READ_ONLY, 실제 데이터 PAPER OFF, LIVE·키·주문 금지, 사용자 기록·Journal·main 보존 상태에서 검증 오류만 수정하라.

모든 필수 근거를 확인하고 별도 승인을 받기 전까지 **NOT_READY / 실제 데이터 PAPER OFF**를 유지합니다.
