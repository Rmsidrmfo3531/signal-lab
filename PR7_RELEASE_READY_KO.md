# PR #7 최종 검증·Windows 적용 준비

검증 기준: `94f73ae2c3fd684544045290c439d488cf23a0af` · 브랜치: `feat/issue6-integrated` · [PR #7](https://github.com/Rmsidrmfo3531/signal-lab/pull/7)

페이지 분리는 기존 구현을 유지했습니다. 발견한 Telegram 표시·오류 처리와 낡은 안내 문구만 수정했으며 새 거래 전략·실주문·운영 필터 우회 기능은 추가하지 않았습니다.

## 결과

| 항목 | 결과 | 근거·한계 |
|---|---|---|
| 저장소·PR head | PASS | `Rmsidrmfo3531/signal-lab`, 기능 브랜치와 `refs/pull/7/head`의 기준 커밋 일치 |
| PR OPEN/Draft 상태 | UNVERIFIED | GitHub API가 현재 클라우드 정책의 `Forbidden`으로 차단됨. Draft 변경 확인도 별도 필요 |
| 기존 최신 커밋 재검사 | PASS | 과거 결과를 재사용하지 않고 `94f73ae`를 별도 임시 복사본에서 Node 22·24 각각 **803/803** 통과 |
| 수정본 Linux Node 22.23.4 | PASS | **808/808**, 37.176초 |
| 수정본 Linux Node 24.19.0 | PASS | **808/808**, 37.386초 |
| CI 실행기 Linux Node 22·24 | PASS | 각각 **104개 파일·808/808**, 38.818초 / 39.613초 |
| 실제 GitHub Actions 네 환경 | UNVERIFIED | 위 결과는 로컬 Linux 실행. 최신 원격 Windows/Linux Node 22·24 결과는 API 차단으로 확인하지 못함 |
| Telegram 집중 검사 | PASS · Mock | 두 Node 버전에서 각 **23/23**, 실제 메시지 0건 |
| 페이지 분리·반응형 | PASS · Mock API | Chromium 1440×1000, 390×844, 360×800, 720×1024에서 각 8개 경로 이동·표시·설정 보존, pageerror·가로 넘침 0건 |
| 실제 localhost API | PASS · 합성 외부 시세 | 임시 서버 GET 25개: API 18개와 정적 파일 6개 HTTP 200, POST 전용 설정의 GET은 404 정상 |
| 기존 데이터 호환·백업·복원 | PASS · 임시 자료 | 두 Node 버전의 전체 기록 fixture 검사 및 기존 집중 검사 각 **52/52** 통과 |
| 실제 Windows 사용자 폴더 | UNVERIFIED | 접근·변경하지 않음. Windows 경로 계산만 모델 검사 |
| OrangeX 실주문 OFF | PASS | READ_ONLY, 주문·실제 데이터 PAPER 자동 진입 차단. 실제 거래소·계좌·주문 호출 0건 |
| 구문 검사 | PASS | JS/MJS **213개** |
| 실제 Telegram 수신·TradingView 외부 연결 | UNVERIFIED | 실제 발송하지 않음. 외부 TradingView 스크립트는 브라우저 테스트에서 차단, 내부 기본 차트만 검사 |

최종 자동 검사는 실패·취소·건너뛰기 **0건**입니다. 기존 803개를 유지하고 실제 발송 경로의 회귀 5개를 추가했습니다. 상세 기계 판독 보고서는 `reports/pr7-release-validation.json`, 원본 TAP·스크린샷·초기 실패 자료는 클라우드 `/workspace/signal-pr7-release-evidence`에 있습니다.

## 수정한 문제

1. **미확인 배율·계획 수량:** `risk.leverage`는 BTC·ETH·SOL 등의 엔진 기본 추천값일 수 있었습니다. 이제 같은 종목·방향·패턴·확정봉의 실제 열린 PAPER 원장만 참조합니다. formatter도 진입 시각·체결가·기초자산 단위·잔여 수량을 다시 확인합니다. 미진입이면 '미설정·미확인'으로 표시하며 원장·설정을 새로 만들거나 변경하지 않습니다.
2. **메시지 생성 오류 격리:** 최종 목록 조회와 메시지 생성도 Telegram 오류 처리 안에 포함했습니다. 네트워크·HTTP·메시지 형식 오류가 전체 발행·후속 신호를 중단하지 않으며, 오류 문자열에 포함될 수 있는 토큰을 로그로 출력하지 않습니다.
3. **낡은 UI 안내:** 빈 신호 화면·스캔 요약에 남아 있던 '관찰 알림은 Telegram 전용' 안내를 최종 신호 전용 정책으로 수정했습니다.

## Telegram 판정·형식

`/api/results.signals`와 Telegram은 같은 `relevantSignals()`와 `evaluateSignal()`의 현재 판정을 사용합니다. 발송 직전에 목록을 다시 평가하므로 이전 스캔이 통과했어도 현재 호가·신선도·위험·목표가 검증에서 탈락하면 발송하지 않습니다. 85점 관찰과 뉴스 발송 경로는 없습니다. 점수·TP/SL·지표·뉴스·URL·버튼은 본문에 넣지 않습니다.

```text
종목: ASTERUSDT
방향: 숏 (SHORT)
배율: 미설정
포지션 수량(모의): 미확인
```

실제 신호와 정확히 대응하는 열린 모의 포지션이 있으면 확인된 배율과 **잔여 수량**을 표시합니다. 일반 PAPER 엔진은 레버리지를 별도로 기록하지 않으므로 배율이 '미설정'인 경우가 정상입니다. 진입 계획 수량을 체결된 포지션 수량으로 표시하지 않습니다.

`tests/telegram_delivery.test.mjs`는 실제 서버의 최종 판정·발행·발송 함수를 오프라인 VM에서 실행하고 네트워크만 Mock으로 대체합니다. 최종 미통과·85점·발송 직전 호가 만료, 최종 통과, 반복 스캔·재시작 중복 방지, 저장 실패, 네트워크·HTTP·형식 오류 이후 후속 신호, 정확한 모의 원장 연결을 검증합니다. 뉴스는 기존 polling 회귀로 미발송을 확인합니다. 운영용 테스트 발송 API나 우회 스위치는 추가하지 않았습니다. [안전한 실행 명령](WINDOWS_PR7_APPLY_KO.md#실제-메시지-없이-telegram-검증)을 사용하면 실제 수신자가 없어도 검증할 수 있습니다.

중복 방지는 기존대로 발송 시도 전에 저장합니다. Telegram 장애나 수신 여부 불확실 시 같은 신호를 자동 재전송하지 않습니다. 이는 중복을 막지만 실제 수신을 보장하지 않는 한계입니다. 실제 수신은 UNVERIFIED입니다.

## 페이지와 API

| 논리적 기능 | 기존 경로·구성 | 확인 |
|---|---|---|
| 시장·차트·지표·관심종목 | `#overview`, `#chartPanel` 별칭 | 기본 차트·종목 선택·지표, 페이지 복귀 시 유지 |
| 최종 판단 신호·스캔 | `#scanner` | 최종 신호 전용·정렬·진단·스캔 요청 |
| 모의매매·PNL | `#paper` | 보존된 PNL·포지션·본절 ON/OFF·설정 |
| TP/SL·매매일지 | `#journal` 및 모의매매·차트의 기존 상세 | 기록·설정 표시 유지 |
| 한국어 뉴스·시황 | `#news` | 번역 표시, 번역 실패 시 원문·오류 유지 |
| 설정·Telegram·시스템 상태 | `#alerts` 및 `#paper`의 기존 설정 | Telegram 연결 설정 여부와 시스템 상태 |
| OrangeX·TradFi | `#orangex`, `#tradfi` | READ_ONLY·기존 TradFi 기록·비활성 상태 |

페이지는 hash 경로로 전환하고 기존 패널을 계속 유지합니다. 같은 기능을 새 페이지로 중복 구현하지 않았습니다. 브라우저 검사에 사용한 시세·API는 Mock이며, 별도 HTTP 검사에서는 실제 로컬 서버를 띄우고 외부 시세만 합성 fixture로 대체했습니다. 실제 뉴스 번역 서비스·실시간 거래소 연결의 성공을 이 결과로 주장하지 않습니다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `links.mjs` | 네 줄 형식 유지, 추천·계획값 대신 정확한 모의 원장 사용 |
| `server.mjs` | 정확한 원장 선택, 최종 조회·형식·전송 오류 격리 |
| `public/app.js` | 낡은 관찰 알림 안내 2곳 수정 |
| `tests/telegram_delivery.test.mjs` | 발송·저장·판정·중복·장애 통합 회귀 5개 |
| `tests/links.test.mjs`, `tests/telegram_final_only.test.mjs`, `tests/issue6_ui.test.mjs` | 기존 검사 강화·새 문구와 원장 정보 검증 |
| `README.md`, `ISSUE6_INTEGRATION_KO.md` | 배율·수량의 확인 기준과 적용 안내 |
| 본 보고서·`reports/pr7-release-validation.json`·`WINDOWS_PR7_APPLY_KO.md` | 검증 결과와 백업·설치·복구 명령어 |

## 데이터 보존과 적용 조건

운영 저장·백업·복원·PAPER 엔진·Journal 형식은 변경하지 않았습니다. 임시 fixture에서 PNL, 미청산 포지션의 TP1·TP2·TP3, 본절 설정, 매매일지, 관심종목, Telegram 설정·이력과 확장 필드가 새 버전 준비·CLI 백업·복원 후 동일하게 유지되는지 확인했습니다. `.env`와 기존 백업도 바이트 단위로 보존했습니다. 기존 별도 작업 디렉터리의 미커밋 파일 28개도 그대로입니다.

실제 Windows 적용은 자동 실행하지 않았습니다. [Windows 명령어 안내](WINDOWS_PR7_APPLY_KO.md)에 따라 서버를 종료하고 `%LOCALAPPDATA%\SignalLab` 전체를 별도 위치에 복사한 뒤 새 코드 폴더에서 실행해야 합니다. 기존 자동 백업의 30개 보관 정책 때문에 전체 외부 복사본도 필요합니다. `.env`·`store.json`을 예제 파일로 덮어쓰지 않습니다.

개발 중 VM fixture 누락으로 4개 집중 검사가 실패했고, 브라우저 메뉴와 HTTP 필드명을 잘못 가정한 검사 스크립트도 실패했습니다. 각각 원본 실패 근거를 보존하고 검사 도구를 수정한 뒤 최종 검사를 재실행했습니다. 이를 제품 통과 결과로 덮어쓰지 않습니다.

GitHub의 [기능 브랜치 Actions](https://github.com/Rmsidrmfo3531/signal-lab/actions?query=branch%3Afeat%2Fissue6-integrated)에서 정확한 새 커밋의 네 환경 결과를 확인하고 Draft 상태도 확인해야 합니다. 현재 클라우드에는 `api.github.com` 허용이 적용되지 않아 원격 상태 검증이 막혀 있습니다. **main 미병합, READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF, OrangeX 실주문 OFF**를 유지합니다.
