# signal-lab 작업 지침

Binance 확정 1H·4H 차트로 신호를 분석하고 BingX·Gate.io 호가로 모의(일부 실거래) 매매하는 로컬 Node 22+ 앱입니다. 외부 npm 패키지 없이 동작합니다. 테스트: `npm test`.

## 작업자 자동 배정 (모델·effort)

메인 대화는 작은 일을 직접 처리하고, 아래 기준에 맞는 일은 해당 작업자(`.claude/agents/`)에게 맡깁니다.

| 작업 | 작업자 | 모델 · effort |
|---|---|---|
| 로그·리포트 요약, 위치 찾기, 설정 조회 (읽기 전용) | quick-helper | Haiku 5.5 |
| 기능 추가, 여러 파일 수정, UI·API·공개 시세 연동 | builder | Opus 5.5 · high |
| 신호 점수·지표·TP/SL·체결·실거래·백테스트 변경 또는 검수, 원인 불명 버그 | signal-reviewer | Opus 5.5 · xhigh |
| 구조 재설계, 대규모 리팩터링, signal-reviewer로 2회 이상 실패한 문제 | architect | Fable 5.2 · high |

- 매매 로직(score_factors, signal_policy, signal_pipeline, paper, live_*, *_execution, volume_*)을 바꾼 작업은 완료 전에 signal-reviewer 검수를 받습니다.
- 한 줄 수정·질문 답변처럼 작은 일은 작업자를 쓰지 않고 직접 처리합니다(작업자는 맥락을 새로 읽어 비용이 더 듭니다).
- architect는 비용이 가장 크므로 위 조건일 때만 씁니다.

## 안전 규칙

- 실제 주문을 실행하거나 실거래를 기본으로 켜지 않습니다.
- 개발·테스트는 별도 `SIGNAL_LAB_DATA_DIR`을 사용하고 운영 `.env`·`store.json`을 건드리지 않습니다.
- `SIGNAL_FINAL_MIN_SCORE` 등 안전 임계값을 완화하지 않습니다. 예외(사용자 승인 2026-11-12): `signal_policy.mjs`의 `TREND_GATE_PATTERNS` 6개 패턴만 90점 대신 4H 추세 일치로 진입합니다(추매 없음). 이 목록을 늘릴 때는 다시 승인을 받습니다.
- 비밀키·토큰을 코드·로그·커밋에 남기지 않습니다.
- 보고는 한국어 합니다체로 합니다.
