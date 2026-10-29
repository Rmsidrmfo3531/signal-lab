# OrangeX PAPER 2.6단계 — 운영 안정성과 Windows 실측 준비

대상은 `Rmsidrmfo3531/signal-lab`, `feat/orangex-readonly`, 기준 커밋 `d3cedee`입니다. 기존 2.5단계 엔진을 재사용하며 전략·신호 조건을 추가하거나 완화하지 않았습니다. **READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF, LIVE 주문 기능 없음**을 유지합니다. 이번 작업에서 OrangeX API·계좌·키·주문·취소·출금은 사용하지 않았고 main 수정·Merge는 하지 않았습니다. 검사 데이터는 임시 디렉터리의 합성 원장입니다.

## 구현과 기존 기능 보존

| 범위 | 구현 |
|---|---|
| 저장 구조 분석 | 현재 엔진의 전체 상태 복제·직렬화 비용, 16MiB 저장 제한, 거래 이력 증가에 따른 RAM·복구 비용을 같은 합성 조건으로 측정 |
| 별도 저장 실험 | `orangex_paper_journal.mjs`: 델타 Append-only Journal, 해시 연결, 순번·거래 ID, fsync, Snapshot, 잠금, 손상 감지, 명시적 백업·복원 |
| 운영 저장 표시 | 기존 저장 파일의 바이트·16MiB 한도·80% 용량 주의를 PC·모바일에 표시. 한도·형식·실제 저장 경로는 그대로 |
| Windows 진단 | ZIP 압축 해제 후 `diagnose_orangex.bat` 더블클릭. Git·API 키·서버 시작 없이 공개 GET 및 환경 검사, 임시 JSON 자동 저장 |
| 운영 준비 검사 | 독립 `evaluateOrangeXReadiness()`, 파일 CLI, 캐시 GET, PC·모바일 조건표. 필수 정보 하나라도 미검증·불일치이면 NOT_READY |
| 장기 장애 검증 | 고빈도 중복·역순·지연 메시지, 장기 포지션·펀딩·재시작·손절 갭, 실제 자식 프로세스 SIGKILL·저장 실패 검사 |

기존 `OrangeXPaperEngine`, 신호 연결·모의체결·회계 감사·재생·성과·기존 원자 저장·백업을 재사용합니다. LONG/SHORT, 40/35/25% 익절, 손절, CLOSE, 비용·PNL, 위험 제한은 기존 구현을 검사합니다. `engine.mjs`, `quality.mjs`, `execution.mjs`, `markets.mjs`, `paper.mjs`, `persistence.mjs`, `signal_lifecycle.mjs`, `public/trade_plan.js`, 기존 OrangeX 계약 어댑터와 실제 사용자 파일은 이번 단계에서 변경하지 않았습니다. 실제 사용자 Windows 디스크는 이 환경에서 직접 검사하지 못했으며 접근하지 않았습니다. PNL·설정·백업 보존 검사는 별도 임시 폴더의 기존 형식 fixture로 수행했습니다.

Journal은 실험 파일과 부하 검사에서만 사용합니다. 서버·PAPER 서비스에서 선택할 수 없고 자동 변환·자동 복구 덮어쓰기·로그 정리 기능도 추가하지 않았습니다. 기존 사용자 원장을 Journal에 입력하는 이관 도구를 제공하지 않습니다.

### 중단 작업 복구와 보존

원래 `/workspace/signal-lab-orangex`에 접근해 `feat/orangex-readonly`, HEAD `d3cedee`와 미커밋 33개 파일을 확인했습니다. 초기화·재복제·강제 checkout을 하지 않았습니다. 수정 전에 변경 파일 아카이브, staged/unstaged binary diff, Git 상태, SHA256 목록과 기준 브랜치 bundle을 `/workspace/signal-lab-orangex-recovery-20261029T083258Z`에 별도 보존하고 아카이브 내부 파일 해시를 검증했습니다. 원본 백업은 이후 수정하지 않았습니다. 별도 `/workspace/signal-lab`의 기존 작업물도 건드리지 않았습니다.

중단 당시 테스트 로그는 Node22/24 각각 516개 통과였습니다. 복구 후 최종 리뷰에서 아래 실제 결함과 Windows 테스트 이식성 문제를 발견해 수정했으므로, 최종 결과는 수정 후 다시 수행한 전체 검사로 기록합니다.

- Journal의 읽기 캐시를 보유한 인스턴스 A가 있고 B가 백업을 복원한 뒤 A가 쓰기를 시작하면, A가 이전 세대 로그에 ACK를 반환할 수 있었습니다. 새 writer lease 획득 직후 활성 manifest와 처리 ID를 재읽어 현재 세대에만 저장하도록 고쳤습니다. 재현 테스트는 새 거래·펀딩·재시작 후 영속성과 중복 거부를 검사합니다. 기존 writer의 매 append에 전체 재생을 추가하지 않았습니다.
- 디렉터리 fsync 순서 테스트가 Windows의 디렉터리 열기 지원 여부에 의존했습니다. 디렉터리 핸들만 가상화하고 실제 데이터 파일 fsync는 유지하여 호출 순서를 OS 독립적으로 검사합니다. Windows 미지원 오류 5종과 ENOSPC 실패를 별도 주입 검사합니다. 검사 skip이나 저장 성공 조건 완화는 없습니다.


## 발견한 저장 한계와 복구 보완

기존 엔진은 변경 처리 시 전체 원장을 복제하고, 저장 콜백은 전체 JSON을 다시 만듭니다. 거래 이력을 보존하므로 거래 수에 따라 시간·메모리가 증가합니다. 16MiB 한도를 초과하면 정상 저장으로 처리하지 않습니다. 이번 변경은 이 한도를 올리거나 과거 거래를 삭제하지 않고 용량 주의를 먼저 표시합니다.

실험 Journal은 작은 변경만 직렬화·추가하고 파일 동기화 후 성공을 반환합니다. 같은 ID·같은 내용 재시도는 중복으로 처리하며, 같은 ID의 다른 내용, 이미 처리한 신호·펀딩 키 변경·삭제, 종료 거래 키 중복은 거부합니다. 상태 총량은 증분 바이트 예산으로 ACK 전에 제한하고, 배치 일부가 실패하면 메모리 변경도 되돌립니다.

부분 기록·ENOSPC는 기록 바이트와 상태를 되돌린 뒤 실패를 알립니다. 디스크 동기화와 롤백 결과가 불확실하면 추가 쓰기를 동결합니다. 손상된 마지막 줄·해시 불일치·manifest 없는 잔존 파일을 빈 원장으로 초기화하거나 잘라내지 않습니다. 명시적 자체 백업 복원은 손상 파일을 보존하고 새 세대로 전환합니다. 백업·복원 파일뿐 아니라 해당 디렉터리와 부모 디렉터리도 manifest 발행 전에 동기화합니다. Linux SIGKILL 재시작은 검사했지만 실제 Windows 전원 차단·파일시스템 내구성은 미검증입니다. Windows가 디렉터리 fsync를 지원하지 않는 경우의 허용 분기는 실제 디렉터리 동기화 성공을 보장하지 않습니다.

**Journal도 전체 상태·중복 방지 ID를 RAM에 보유합니다.** checkpoint는 전체 직렬화를 하고, 재시작은 유지된 전체 체인을 검증하며 반환 상태를 복제합니다. 백업·이전 세대·로그를 자동 삭제하지 않아 디스크가 증가합니다. 델타 저장의 성능을 운영 엔진 전체 성능 향상이나 무제한 운영 보장으로 해석하면 안 됩니다.

## 같은 조건의 저장 성능 비교

측정은 동일 머신의 Linux x64, Node.js 22.23.3 / 24.19.0에서 백엔드별 분리 프로세스로 순차 실행했습니다. 각각 동일한 거래 수·원장 해시·수수료·펀딩 ID 뒤에 변경 5회를 적용하고, 재시작·checkpoint·백업·복원 및 독립 회계 감사를 수행했습니다. 구현 SHA256이 결과에 포함됩니다. 외부 API는 호출하지 않았습니다.

거래 1,000·10,000·10,001건 이력은 엔진으로 실제 생성한 **합성** 펀딩 거래 템플릿을 고유 ID·시각으로 확장한 것입니다. 10,000개의 전략 시그널을 발견하거나 실시간으로 체결했다는 뜻이 아닙니다. `heartbeat`는 이력을 유지한 시각·연결 갱신 5회, `append_trade`는 종료 거래·신호 ID·펀딩 ID를 5회 추가합니다. CPU는 프로세스 사용량, 쓰기 바이트는 애플리케이션 payload이며 물리 디스크 I/O가 아닙니다. RAM은 단계별 표본과 프로세스 maxRSS이며 GC·머신에 의존합니다.

### 이력 유지 heartbeat 5회

| Node | 초기 거래 | 저장 방식 | 결과 | 변경 5회 ms / CPU ms | 변경 쓰기 KiB | 최고 heap / RSS MiB | 최종 파일 MiB | 재시작 / 복원 ms |
|---|---:|---|---|---:|---:|---:|---:|---:|
| 22 | 1,000 | 기존 Snapshot | PASS | 266.27 / 273.75 | 27958.58 | 49.0 / 144.7 | 8.19 | 20.43 / 98.32 |
| 22 | 1,000 | 실험 Journal | PASS | 1.97 / 2.89 | 1.92 | 59.1 / 147.6 | 13.53 | 52.94 / 193.80 |
| 22 | 10,000 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 272.7 / 569.5 | 0.00 | — |
| 22 | 10,000 | 실험 Journal | PASS | 2.32 / 5.17 | 1.92 | 272.6 / 609.9 | 135.14 | 645.25 / 2340.36 |
| 22 | 10,001 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 272.7 / 537.5 | 0.00 | — |
| 22 | 10,001 | 실험 Journal | PASS | 2.32 / 4.42 | 1.92 | 272.8 / 618.6 | 135.15 | 619.72 / 2197.94 |
| 24 | 1,000 | 기존 Snapshot | PASS | 230.98 / 252.55 | 27958.58 | 54.3 / 187.9 | 8.19 | 17.92 / 84.52 |
| 24 | 1,000 | 실험 Journal | PASS | 1.69 / 1.97 | 1.92 | 89.1 / 228.9 | 13.53 | 49.25 / 179.22 |
| 24 | 10,000 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 388.0 / 557.6 | 0.00 | — |
| 24 | 10,000 | 실험 Journal | PASS | 1.89 / 4.07 | 1.92 | 388.3 / 667.9 | 135.14 | 531.66 / 1890.84 |
| 24 | 10,001 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 413.2 / 598.1 | 0.00 | — |
| 24 | 10,001 | 실험 Journal | PASS | 1.77 / 3.92 | 1.92 | 388.1 / 661.7 | 135.15 | 524.83 / 1873.60 |

### 종료 거래·펀딩 ID 추가 5회

| Node | 초기 거래 | 저장 방식 | 결과 | 변경 5회 ms / CPU ms | 변경 쓰기 KiB | 최고 heap / RSS MiB | 최종 파일 MiB | 재시작 / 복원 ms |
|---|---:|---|---|---:|---:|---:|---:|---:|
| 22 | 1,000 | 기존 Snapshot | PASS | 290.92 / 301.56 | 28028.43 | 46.7 / 146.2 | 8.23 | 20.01 / 92.40 |
| 22 | 1,000 | 실험 Journal | PASS | 3.22 / 3.58 | 12.42 | 54.3 / 152.9 | 13.61 | 53.75 / 200.31 |
| 22 | 10,000 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 234.0 / 580.5 | 0.00 | — |
| 22 | 10,000 | 실험 Journal | PASS | 5.06 / 7.11 | 12.42 | 272.7 / 622.5 | 135.21 | 608.45 / 2156.99 |
| 24 | 1,000 | 기존 Snapshot | PASS | 270.84 / 289.24 | 28028.43 | 41.1 / 211.7 | 8.23 | 16.83 / 92.89 |
| 24 | 1,000 | 실험 Journal | PASS | 3.02 / 3.80 | 12.42 | 53.9 / 235.6 | 13.61 | 46.21 / 179.14 |
| 24 | 10,000 | 기존 Snapshot | CAPACITY_LIMIT | — | — | 388.2 / 585.3 | 0.00 | — |
| 24 | 10,000 | 실험 Journal | PASS | 4.78 / 7.56 | 12.42 | 389.4 / 640.3 | 135.21 | 529.61 / 1901.27 |

최종 파일 크기는 초기 파일뿐 아니라 검사 중 만든 checkpoint·백업·복원 후 보존 세대를 포함합니다. 서로 다른 저장 구조의 총 보존량이며 journal 한 파일 크기만을 비교하지 않습니다. CPU 열은 해당 변경 단계의 user+system 합계입니다.

### 남아 있는 전체 원장 비용

아래는 기존 엔진 비용을 Journal 성능에서 제외해 숨기지 않기 위해 별도로 측정한 값입니다. 디스크 저장 없이도 기존 엔진 트랜잭션의 복제 비용은 남습니다. 동일 seed의 기존 Snapshot worker 측정값이며 두 백엔드 원본에 각각 기록되어 있습니다.

| Node | 거래 이력 | 전체 복제 5회 ms | 전체 직렬화 5회 ms | 기존 엔진 구성+호가 변경 5회 ms | 기존 형식 크기 MiB |
|---|---:|---:|---:|---:|---:|
| 22 | 1,000 | 73.18 | 83.21 | 132.44 | 2.73 |
| 22 | 10,000 | 665.52 | 951.93 | 1691.97 | 27.29 |
| 22 | 10,001 | 723.29 | 941.93 | 1699.33 | 27.29 |
| 24 | 1,000 | 51.76 | 62.36 | 110.51 | 2.73 |
| 24 | 10,000 | 606.39 | 749.82 | 1269.82 | 27.29 |
| 24 | 10,001 | 599.86 | 749.23 | 1258.31 | 27.29 |

10,000건에서 기존 저장 방식이 한도를 초과한 결과는 **CAPACITY_LIMIT 실패**입니다. 이 경우 기존 방식의 실제 저장·재시작·복원 값은 없으며 Journal 대비 배속을 계산하지 않습니다. Journal과 기존 방식 모두 상태 생성·엔진 복제·직렬화 비용은 별도로 측정했습니다. 기존 엔진의 전체 상태 복제 경로는 이번 단계에서도 남습니다.

측정 원본: [Node22 heartbeat](reports/orangex26-storage-node22.json), [Node24 heartbeat](reports/orangex26-storage-node24.json), [Node22 거래 추가](reports/orangex26-storage-append-node22.json), [Node24 거래 추가](reports/orangex26-storage-append-node24.json).

운영 전환은 아직 권하지 않습니다. 향후 별도 제안에는 엔진의 원자 델타 연결, Windows 강제 종료·디렉터리 동기화, 새/구 원장 병행 비교, 이관 dry-run·원본 백업·복원, 펀딩·체결 재실행 경계, 보존·보관 정책과 운영자 승인 절차가 필요합니다. 이번 코드에는 이관·활성화 경로가 없습니다.

## Windows 원클릭 공개 API 검사

1. [기능 브랜치 ZIP](https://github.com/Rmsidrmfo3531/signal-lab/archive/refs/heads/feat/orangex-readonly.zip)을 다운로드해 **별도 새 폴더에 전체 압축 해제**합니다. 기존 `.env`·데이터·백업을 복사하거나 교체할 필요가 없습니다.
2. Node.js 22 또는 24가 설치된 PC에서 `diagnose_orangex.bat`를 더블클릭합니다. Git·npm 설치·PowerShell 명령·API 키는 필요하지 않습니다. Node가 없으면 설치 필요 상태를 기록하며 자동 설치하지 않습니다.
3. 완료 창에 표시된 JSON을 보관합니다. 기본 위치는 `%TEMP%\SignalLab-OrangeX-Diagnostics\orangex-public-*.json`입니다. Node가 없거나 지원 버전 미만인 경우 같은 폴더의 고유 하위 디렉터리에 `environment.json`만 저장하고 API 요청은 하지 않습니다. 환경 폴더가 없거나 안전하게 기록할 수 없으면 실패를 표시합니다.

기본 요청은 문서 1건, 거래 영역 `BTC·ETH·SPOT` 및 **별도 미검증 후보 `PERPETUAL`** 4건, BTC·ETH·SOL 종목별 티커·호가 6건으로 11건입니다. 상장 결과의 추가 계약 후보가 있으면 종목당 최대 3개 이내에서 추가 공개 GET을 할 수 있습니다. `USDT`를 정상 거래 영역 기본값으로 되돌리지 않습니다. 인증·개인·주문 API는 사용하지 않습니다.

계약명·상장·활성, `contract_size`, `min_qty`, `min_trade_amount`, `min_notional`, 수량 증분 필드, `tick_size`, Maker/Taker **원값**, 호가 깊이·정렬·중복·잔량, 독립 Mark·호가 시각·누락·지연과 Node·OS·curl 환경을 기록합니다. 없는 필드는 만들지 않고 최소량·증분을 서로 대신 쓰지 않습니다. 프록시 CONNECT 차단, DNS, TLS, 타임아웃, 거래소 HTTP·스키마 오류는 기존 진단 분류를 재사용합니다.

실제 도구 결과는 `REAL_PUBLIC_OBSERVATION_SUMMARY`, `ALLOWLISTED_SUMMARY_NOT_RAW_RESPONSE`입니다. **실제 공개 응답의 선택 필드 요약이며 원문 HTTP 응답 전체가 아닙니다.** 합성값으로 보충하지 않습니다. 주입 응답 테스트는 `SYNTHETIC_TEST`, `actualRequestsRun:false`이며 실제 접속 성공으로 표시하지 않습니다. stdout·JSON에는 인증 정보·임의 응답 필드를 내보내지 않습니다. JSON은 고유 이름으로 만들며 기존 파일을 덮어쓰지 않습니다. 사용자 기록 폴더·링크 경로로 출력이 향하면 거부합니다.

공개 관측 종료코드 0은 거래 준비 완료를 뜻하지 않습니다. 같은 JSON 안의 `readiness.status`가 NOT_READY일 수 있습니다. 준비 상태 파일 재검사는 네트워크 없이 다음 명령으로 합니다. 이 검사는 입력을 읽기만 하며 NOT_READY이면 종료코드 1, 파일 오류이면 2를 반환합니다.

```text
npm run check:orangex:readiness -- --input "C:\진단결과\orangex-public-....json"
```

**이번 클라우드에서는 실제 Windows BAT·실제 OrangeX GET을 실행하지 않았습니다.** CMD 분기·공백/한글 경로·설치된 curl·보안 프로그램·프록시·실제 계약 단위는 Windows 실측 후 확인해야 합니다. Linux에서 Windows 런타임을 주입한 단위 검사는 실제 Windows 실행이 아닙니다.

## 운영 준비 상태와 필요한 실측

`orangex_readiness.mjs`는 공통 3개 + 종목별 17개 = 54개 조건을 평가합니다. 하나라도 FAIL/UNVERIFIED이면 NOT_READY입니다. 출력은 상태뿐이며 READY라도 `activationAllowed:false`, `realDataAutoEntryEnabled:false`, `liveOrdersEnabled:false`입니다. 공식 문서 URL·검토 시각·원값과 일치하는 명시적 검토 근거를 받아 평가하며, 숫자 존재·HTTP 200·SDK 후보를 단위 검증으로 승격하지 않습니다. 근거 해시는 자료 연결을 위한 것이고 출처의 독립 인증 수단은 아닙니다.

기존 사용자 제공 2026-10-27 Windows 8건 요약은 새 접속 결과로 재사용하지 않았습니다. 수집 당시 재평가는 **10 PASS / 1 FAIL / 43 UNVERIFIED**, 현재는 과거 시세 만료로 **4 PASS / 7 FAIL / 43 UNVERIFIED**, 전체 NOT_READY입니다. 기존 실측 파일을 수정하거나 이전 6건 자료와 합쳐 누락 필드를 채우지 않았습니다. 상세 결과는 [기존 실측 재평가 JSON](reports/orangex26-readiness.json)에 있습니다.

| 조건 | 기존 8건 실측 평가 | 남은 확인 |
|---|---|---|
| 입력 형식·READ_ONLY | PASS | 새 Windows 실행에서도 계좌·주문 없이 검사 |
| 공개 응답 출처 | UNVERIFIED | 공식 문서와 실제 응답의 검토 근거, 수집 출처·시각·자료 해시 |
| 정확한 계약명·상장·활성 | UNVERIFIED | 올바른 거래 영역의 실제 목록과 무기한 계약·활성 상태 |
| 계약 크기·주문 수량 단위 | UNVERIFIED | `contract_size`와 수량이 계약 수/기초자산 중 무엇인지 공식 의미 |
| 최소 수량·수량 증분 | UNVERIFIED | `min_qty`, `min_trade_amount`, 증분의 별도 원값·단위·정의 |
| 최소 명목금액·가격 단위 | UNVERIFIED | `min_notional`, `tick_size`의 값·통화 단위 |
| Maker/Taker 단위 | UNVERIFIED | 요율 원값과 FRACTION/%/bp 해석, 실제 적용 조건 |
| 펀딩 정산 | UNVERIFIED | 요율 단위·부호·주기·기준 시각·누락 복구 |
| 시각 단위 | UNVERIFIED | 호가·티커의 밀리초 등 공식 의미 |
| Mark·호가 독립 신선도 | 수집 당시 PASS, 현재 FAIL | 새 요청에서 각각의 원 시각·수신 시각·지연 확인 |
| 호가 잔량·정렬 | BTC/SOL PASS, ETH FAIL | ETH Ask가 22행이며 중복 가격·순서 역전 존재. 정리·추정으로 통과시키지 않음 |
| 가격·수량 정밀도 | UNVERIFIED | 검토된 단위 격자와 실제 모든 호가 레벨 대조 |
| Binance 계약 대응 | UNVERIFIED | 기초·표시·정산 통화의 거래소 정의, 선형 계약 대응, 양쪽 신선한 가격 |

일반 화면의 기존 공개 연결 상태와 새 운영 준비 상태를 별도로 표시합니다. `/api/orangex/readiness`는 캐시만 검사하며 새 외부 요청·저장·자동 진입을 만들지 않습니다. 웹에는 키·토큰·활성화 버튼을 추가하지 않았습니다. UI는 허용한 조건명·상태만 렌더링합니다.

## 회귀·장기 검사 결과

검사마다 기존 사용자 경로 대신 임시 폴더를 사용했습니다. HTTP 서버 검사는 Mock preload와 localhost만 사용하고 외부 fetch/WebSocket을 차단했습니다. 자동 업데이트·텔레그램·OrangeX 계좌 인증은 비활성 상태입니다. 기존 테스트 삭제·skip·실패 조건 완화는 없습니다.

| 검사 | 실제 실행 결과 |
|---|---|
| Linux v24.19.0 전체 회귀 | **518/518 통과**, 실패·취소·skip·todo 0, 20.18초 |
| Linux v22.23.3 전체 회귀 | **518/518 통과**, 실패·취소·skip·todo 0, 20.72초 |
| 기존 469개 | 삭제·skip 없이 유지, 신규 49개 포함 |
| 최종 Journal 집중 검사 | Node22·24 각각 16/16 통과. SIGKILL, ENOSPC, 손상·부분 저장, ACK 세대 전환, 상태 한도·중복 ID |
| Chromium | Linux Chromium 154.0.8037.57 / Node24, 1440·390·360·720px 모두 통과. 페이지 오류·가로 넘침 0 |
| 화면 보존·복구 | 기존 8개 패널·TradingView 링크, 합성 LONG/SHORT·40/35/25·손절·PNL·BACKTEST, API 실패 3경로·용량 경고 복구 |
| 사용자 기록 보호 | 임시 fixture의 기존 PNL·진행 포지션·설정·백업 동일성, 새 GET의 무저장·읽기 전용, 기존 업데이트 파일 보호 |

[최종 검증 JSON](reports/orangex26-validation.json), [Chromium 결과](reports/orangex26-browser.json), [장기 재생](reports/orangex26-endurance.json), [운영 부하](reports/orangex26-operational-stress.json). 실제 실행은 임시 데이터였으며 원본 Windows 사용자 디스크를 직접 검사한 결과가 아닙니다.

### 매 이벤트 저장을 포함한 가상 7일·30일

| 가상 기간 | 종료 거래 | 시장 메시지 | 원장 쓰기 / 재시작 | 실행 초 | 최고 heap / RSS MiB | 원장 KiB | 회계 감사 |
|---|---:|---:|---:|---:|---:|---:|---|
| 7일 | 28 | 433 | 510 / 7 | 1.13 | 30.65 / 85.47 | 93.39 | valid·complete |
| 30일 | 120 | 1845 | 2175 / 30 | 16.56 | 131.72 / 259.19 | 395.98 | valid·complete |

신호는 엔진 부하를 위한 합성이며 전략 백테스트 수익률이 아닙니다. 각각 28·120개 거래의 수량 보존·중복 거래 없음·저장 상태와 메모리 일치·독립 회계 감사가 통과했습니다. 기존 엔진의 보존 이력 증가에 따라 속도와 메모리가 증가하는 모습도 그대로 기록했습니다.

### 고빈도 메시지·장기 미청산 포지션

각 사례는 원 입력 10,000건에 장애 메시지를 더해 **11,805건**을 전달했습니다. 진입 체결 1회·종료 거래 1개만 남았고 중복·역순·지연·오래된 Mark·재시작 뒤에도 수량·신호 ID가 유지됐습니다. 고빈도 구간은 **중간·마지막 checkpoint 3회 저장**이며 매 메시지 디스크 내구성 수치로 표시하지 않습니다. 장기 포지션 구간은 변경마다 저장합니다.

| 장기 사례 | 고빈도 구간 초 / CPU 초 | 고빈도 최고 heap / RSS MiB | 고빈도 원장 KiB | 포지션 종료·펀딩·복구 |
|---|---:|---:|---:|---|
| 7일 | 18.28 / 18.40 | 70.69 / 175.55 | 191.05 | TIME_LIMIT, 펀딩 21회, 쓰기 81회, 재시작 8회 |
| 30일 | 18.15 / 18.26 | 74.43 / 183.27 | 191.05 | STOP, 펀딩 90회, 쓰기 192회, 재시작 2회 |

7일 사례는 기존 최대 보유 7일을 유지한 채 펀딩 21회 후 TIME_LIMIT로 종료했습니다. 30일 사례는 7일 제한을 늘린 것이 아니라 **30일간 체결 가능한 시세가 없던 단절**입니다. 허구의 7일 청산을 만들지 않고 첫 신선한 호가로 STOP 처리하며 펀딩 90회·중복 차감 방지를 확인했습니다. 계획 손실 $5.9630 대비 실현 손실 $15.2131, 초과액 $9.2501을 기록했습니다. 갭·장애 상황에서 위험 예산 이하 손실을 보장한다고 표시하지 않습니다.

기존 GitHub Actions는 이 기능 브랜치 Push에서 Linux/Windows × Node22/24를 실행하도록 설정돼 있습니다. 위 통과 수치는 클라우드 Linux에서 직접 실행한 결과이며, 새 커밋의 원격 CI 결과·실제 Windows BAT 성공으로 대신 해석하지 않습니다.

확인하지 않은 항목은 실제 Windows BAT 실행·파일시스템 내구성, 새 OrangeX 공개 응답, 계좌·주문·수익률입니다. 7일·30일은 가상 시간이며 실제 연속 가동·거래소 성과가 아닙니다. 짧은 유한 부하 검사로 메모리 누수가 없거나 무한 보존이 가능하다고 주장하지 않습니다.

신규 통합 검사 작성 중 Mock 상장 정보를 PASS로 예상한 assertion이 한 차례 실패했습니다. 공식 검토 근거가 없는 자료는 UNVERIFIED가 맞으므로 검사 기대를 수정했으며 운영 판정을 완화하지 않았습니다. 기존 저장 방식의 10,000건 이상 CAPACITY_LIMIT는 해결된 것으로 숨기지 않고 유지한 한계입니다.

## 변경 파일과 재현 명령

| 파일 | 역할 |
|---|---|
| `orangex_paper_journal.mjs` | 운영 미연결의 Journal·Snapshot 실험 |
| `scripts/check-orangex-storage-performance.mjs` | 분리 프로세스·동일 이력/변경의 저장 성능 비교 |
| `scripts/check-orangex-operational-stress.mjs` | 고빈도 메시지·7/30일 포지션·펀딩·복구 검사 |
| `scripts/check-orangex-ui.mjs` | 로컬 Playwright·Chromium을 지정하는 재현 가능한 합성 화면 검사 |
| `diagnose_orangex.bat`, `scripts/diagnose-orangex-windows.mjs` | ZIP 원클릭·환경·공개 GET·임시 JSON |
| `orangex_readiness.mjs`, `scripts/check-orangex-readiness.mjs` | 별도 읽기 전용 준비 상태 평가·파일 재검사 |
| `orangex_paper_store.mjs`, `orangex_paper_service.mjs` | 기존 저장 용량 상태 노출만 추가 |
| `server.mjs`, `public/orangex*.js`, `public/index.html`, `public/styles.css` | 캐시 상태 GET, PC·모바일 조건표·용량 표시 |
| `updater.mjs`, `package.json` | 새 코드의 명시적 업데이트 허용 목록·검사 명령 |
| `tests/orangex_*`, `tests/updater.test.mjs` | 저장·모드·복구·진단·회귀 검사 |
| `reports/orangex26-*`, 본 보고서·README·이전 보고서 링크 | 측정 원본·검증 범위 |

```text
npm test
npm run test:orangex:storage
npm run test:orangex:storage -- --trades 1000,10000 --pattern append_trade
npm run test:orangex:operational -- --messages 10000
npm run test:orangex:paper:endurance -- --save-every-event
```

Chromium 재현 도구는 별도로 설치된 Playwright와 Chromium 경로를 명시합니다. npm test에 브라우저 설치 의존성을 추가하거나 자동 다운로드하지 않습니다. 결과 JSON과 스크린샷은 고유 임시 폴더에 기록합니다. 개발 도구이므로 저장소/ZIP의 tests fixture가 필요합니다.

```text
node scripts/check-orangex-ui.mjs --playwright-module <로컬 playwright-core 경로> --chromium <Chromium 실행파일>
```

위 명령은 오프라인 합성 검사입니다. `diagnose:orangex:windows`와 BAT만 Windows 실측 때 공개 API를 호출합니다. 어떤 명령도 실제 데이터 PAPER 활성화·LIVE 주문을 제공하지 않습니다.

## 순방향 PAPER와 실거래 개발 전 남은 조건

1. Windows 새 원클릭 JSON과 공식 문서에서 위 계약·수수료·펀딩·시각·출처 조건을 확인합니다. 현재 자료는 NOT_READY이며 비용 미검증을 0으로 놓지 않습니다.
2. Windows 네트워크·파일 잠금·강제 종료·저장 실패·장기 가동을 별도 임시 데이터로 검사합니다. Journal 전환 여부는 이와 별도의 검토 사항입니다.
3. 준비 정보가 모두 확인된 뒤에도 실제 시세 PAPER는 별도 승인·전용 모드와 실시간 순방향만 허용하는 경계가 필요합니다. 과거 JSON 단일 스냅샷을 연속 실시간 시세로 사용하지 않습니다.
4. 실제 시세 PAPER의 비용·펀딩·중복·복구·위험 제한·오랜 표본을 확인한 뒤 실거래 설계를 별도로 검토합니다. 보호성 손절·reduce-only·부분 체결·불명확 주문 상태·거래소 대조·Kill Switch 등 실거래 안전 장치는 이번 구현 범위가 아닙니다.

### 다음 Codex 지시문

> `Rmsidrmfo3531/signal-lab`의 `feat/orangex-readonly`에서 `ORANGEX_PAPER_26_KO.md`와 첨부한 새 Windows 원클릭 JSON을 읽어라. 새로운 API 호출을 반복하기 전에 실제 관측과 합성 결과를 구분하고, 거래 영역·계약 규격·수량 단위·수수료·펀딩·독립 시각·호가 무결성·Binance 대응을 공식 문서와 대조하라. 누락은 UNVERIFIED로 유지하라. 먼저 준비 조건별 PASS/FAIL/UNVERIFIED와 Windows 내구성 검사 결과를 보고하고 발견한 결함만 현재 기능 브랜치에서 수정하라. 실제 데이터 PAPER는 별도 승인 전까지 OFF, READ_ONLY 유지, 키·실제 주문·main 변경·Merge·기존 기록 변환/삭제를 금지한다. Journal은 운영 저장에 연결하지 말고 필요한 전환 조건을 별도 제안하라. Node.js 22·24 전체 회귀와 PC·모바일 검사를 다시 수행하라.
