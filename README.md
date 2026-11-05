# Signal Lab — Issue #6 통합 개발판

Windows CI 종료 문제 후속 검증: [PR7_WINDOWS_TEST_HANG_KO.md](PR7_WINDOWS_TEST_HANG_KO.md).

PR #7 후속 수정·최신 테스트: [공급자 의존성 제거 및 점수 설정 검증](PR7_PROVIDER_REMOVAL_KO.md).

Binance USDT 무기한 선물의 확정 1H·4H 데이터로 분석하는 로컬 PC·모바일 대시보드입니다. 최신 구현·검증 이력은 [ISSUE6_INTEGRATION_KO.md](ISSUE6_INTEGRATION_KO.md)를 참고하세요. 거래 점수는 승률이 아니며 **새 전략의 실전 성능은 미검증**입니다.

이 버전은 이전 공급자의 네트워크·API·UI·링크 의존성을 제거합니다. 대체 시세 공급자가 없는 **TradFi 수집·스캔·신규 모의 진입은 비활성**입니다. 기존 TradFi 포지션·PNL·매매일지는 보존하지만 시세를 갱신하지 못하므로 마지막 관측값을 현재 가격으로 해석하면 안 됩니다.

## Windows 설치와 기록 보존

1. 이전 서버 창을 종료하고 필요하면 기존 `backup_data.bat`으로 백업합니다.
2. 새 ZIP을 별도 폴더에 모두 풉니다. 압축파일 내부에서 실행하지 마세요.
3. [Node.js](https://nodejs.org/) 22 또는 24를 설치하고 `start.bat`을 실행합니다. 기본 주소는 `http://127.0.0.1:3000`입니다.
4. 기존 `%LOCALAPPDATA%\SignalLab\.env`와 `store.json`을 덮어쓰거나 초기화하지 마세요. 서버는 기존 중앙 저장 경로를 계속 사용합니다. 예제 환경 파일을 기존 `.env` 위에 복사하지 마세요.

macOS/Linux에서는 `node server.mjs`로 실행합니다. 기본 데이터 경로는 `~/.signal-lab`이며 개발·테스트는 별도 `SIGNAL_LAB_DATA_DIR`을 사용해야 합니다. 설치에 외부 npm 패키지는 필요하지 않습니다.

모바일은 동일한 신뢰할 수 있는 사설 Wi-Fi에서 `start_mobile.bat`을 실행한 뒤 명령창의 PC 주소·임시 암호로 접속합니다. PC 서버가 계속 켜져 있어야 합니다. 공용 인터넷에 포트를 개방하지 마세요. 자세한 내용은 [MOBILE_GUIDE.txt](MOBILE_GUIDE.txt)를 참고하세요.

기존 관심종목, Telegram `.env`와 발송 이력, PNL, 미청산 포지션, 매매일지, Windows 알림, 백업·복원 경로를 유지합니다. 과거 포지션의 TP/SL은 신규 규칙으로 다시 계산하지 않습니다. 데이터 복원은 서버를 종료한 뒤 `node data-cli.mjs restore "백업 JSON 경로"`로 수행하며, 현재 파일은 먼저 보존됩니다. 실험 Journal은 운영 저장에 연결하지 않습니다.

## 분석·최종 신호

- 스캔 대상은 Binance의 `TRADING`·`USDT`·`PERPETUAL` 계약입니다. 완전히 마감된 4H 250개 이상이 필요하며 서버는 미확정봉을 제외할 수 있도록 301개를 요청합니다.
- 단일 100점: 4H EMA200 15, EMA100 5, 1H EMA20 10, 패턴·확정봉 강도 25, ADX/DMI 15, RSI 10, MACD 5, 패턴 거래량 10, ATR 5점입니다. 평가 불가능하면 점수는 `null / 평가 불가`입니다.
- **`SIGNAL_FINAL_MIN_SCORE=90`은 제안 기본 임계값이며 검증 상태는 `UNVERIFIED`입니다.** 실측 수익률·기간 외·워킹 포워드 결과로 최적화된 값이 아닙니다. 점수 통과와 기술·신선도·손절·호가·위험·매물대 검증 및 실거래 승인은 별개입니다. 설정은 90~100의 정수만 허용하며 잘못된 값이면 서버 시작을 차단합니다. 기존보다 낮은 기준으로 완화하거나 설정 변경으로 OrangeX 주문을 승인하지 않습니다.
- 기본 60초 보완 스캔은 관심종목·거래대금 상위 12개·순환 18개와 확정봉 이벤트를 처리합니다. 전체 종목을 매초 재분석하는 시스템이 아닙니다. 화면의 실제 처리 건수와 연결 상태를 확인하세요.
- 메인에는 검증 완료된 최종 신호만 점수 내림차순 → 최신 확정봉 → 종목명 순으로 표시합니다. Telegram 전용 80점 이상 알트 관찰 알림은 BTC 제외·중복 차단하며 신규 진입을 생성하지 않습니다.

## 매물대 TP·모의매매

실제 Binance aggTrades 체결량을 가격별로 집계해 POC·HVN·Value Area와 기간·커버리지·갱신 시각을 기록합니다. 1H 캔들 거래량을 실제 가격별 매물대로 대체하지 않습니다. 기술 후보·보유 포지션 중심의 제한된 공개 조회만 수행합니다.

신규 거래에는 LONG 진입가 위 또는 SHORT 아래의 서로 다른 매물대 세 개가 필요합니다. 틱·스프레드·비용·최소 수량·순손익비를 검증하고 40% / 35% / 25%로 분할합니다. 데이터 부족·지연·목표 순서·수량 오류는 `TP_PROFILE_UNAVAILABLE`로 보류하며 고정 2R·3R·4R을 자동 생성하지 않습니다.

TP1의 실제 **모의 체결 누적 수량 40%**가 완료된 뒤에만 잔량 손절을 한 번 본절로 이동합니다. `TP1_MOVE_STOP_TO_BREAKEVEN=true`와 `TP1_BREAKEVEN_MODE=ENTRY_FILL`이 제안 기본값입니다. `COST_COVERED` 모형도 선택할 수 있지만 비용 보전은 가정이며 갭 손실·무손실을 보장하지 않습니다. PC·모바일 설정 변경은 신규 포지션부터 적용합니다.

PNL은 모의 체결·명시된 비용 가정이며 실제 거래소 체결·실제 계정 수수료·현재 펀딩 정산과 다릅니다. 기존 원장의 펀딩 미반영 여부는 화면에 표시합니다. 시세 단절·PC 종료 중에는 포지션 평가에 공백이 생깁니다. 실제 수익률로 해석하지 마세요.

## OrangeX 범위

OrangeX는 기본 비활성·`READ_ONLY`이며 공개 진단과 별도 합성 PAPER 엔진을 제공합니다. 실제 시세 PAPER 자동 진입은 OFF이고 LIVE 주문 전송 기능은 활성화하지 않습니다. API 키가 있거나 점수가 높다는 이유로 모드를 전환하지 않습니다.

계약 단위, 최소량·증분·명목 통화, 실제 비용, 펀딩, 시세 신선도와 보호 주문·reduce-only·안전한 손절 수정 등 필요한 증거가 없으면 준비 상태는 `NOT_READY`입니다. 실제 Windows 공개 응답·과거 자료·합성 테스트를 구분하며 과거 정상 관측을 현재 거래 가능한 호가로 사용하지 않습니다. 사용법은 `.env.orangex.example`과 OrangeX 단계별 검증 보고서를 참고하세요.

## 환경설정

기존 중앙 `.env`를 유지하고 필요한 항목만 수동으로 추가합니다. [`.env.issue6.example`](.env.issue6.example)은 선택 설정 예시입니다.

| 이름 | 기본값 | 의미 |
|---|---:|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 로컬 서버 |
| `SCAN_INTERVAL_MS` | `60000` | 보완 스캔 간격, 최소 30000ms |
| `SCAN_HOT_BATCH` / `SCAN_ROTATING_BATCH` | `12` / `18` | 스캔 범위 |
| `SIGNAL_FINAL_MIN_SCORE` | `90` | 제안 분석 임계값, 실전 성능 `UNVERIFIED` |
| `PAPER_MAX_RISK_USD` | `6` | 신규 모의 포지션 계획 위험 한도 |
| `TP1_MOVE_STOP_TO_BREAKEVEN` | `true` | 신규 거래 TP1 완료 후 본절 이동 |
| `TP1_BREAKEVEN_MODE` | `ENTRY_FILL` | 평균 진입가 또는 `COST_COVERED` 가정 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 없음 | 기존 비공개 Telegram 설정 |
| `TELEGRAM_WATCH_MIN_SCORE` | `80` | 관찰 알림 기준, `0`은 비활성 |
| `TELEGRAM_SCORE_WATCH_ENABLED` | `true` | 관찰 알림 허용 |
| `NEWS_TRANSLATION_URL` | 없음 | 선택 LibreTranslate 호환 서비스 |
| `ORANGEX_ENABLED` / `ORANGEX_MODE` | `false` / `READ_ONLY` | OrangeX 공개 조회 |

폐기된 공급자·TradFi API 키 설정은 기능에서 참조하지 않습니다. 기존 `.env`에 남아 있더라도 이 업데이트가 파일을 삭제·수정하지 않습니다. 키·토큰을 브라우저·로그·Git에 넣지 마세요.

## 검증 명령

```text
npm test
node --check server.mjs
npm run test:market
npm run diagnose:orangex:windows
npm run test:strategy:compare -- --input 과거데이터.json
```

`npm test`는 Mock·합성 데이터 기반 회귀 검사입니다. `test:market`은 별도 실제 Binance 공개 GET 진단으로 주문·계좌 API를 사용하지 않습니다. 네트워크 정책·거래소 지역 제한이 있으면 실패할 수 있으며 회귀 통과가 실제 연결 성공을 의미하지 않습니다. OrangeX 진단도 공개 API만 사용하고 기존 PNL은 수정하지 않습니다.

실제 과거 캔들·aggTrades·호가와 체결 원장에 기반한 새 전략의 성능 개선, 실제 Windows 기능 및 원격 CI 결과는 해당 검증 자료가 있을 때만 통과로 보고합니다. 이전 단계 문서는 과거 개발 이력이며 현재 활성 기능 안내가 아닙니다.

## 주요 공식 자료

- [Binance 선물 Exchange Information](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information)
- [Binance 선물 Kline](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)
- [OrangeX 공개 API 문서](https://openapi-docs.orangex.com/)
