# PR #7 Windows 테스트 종료 대기 보완

2026-11-05 · 기능 브랜치 `feat/issue6-integrated` · 비교 기준 `2043ea2`

## 확인한 증거와 확인하지 못한 범위

사용자가 전달한 GitHub Actions **#41976829401** 로그에 따르면 Windows Node.js 22·24 모두 327개 통과 이후 종료하지 못했습니다. Node.js 24의 가장 먼저 취소된 파일은 `tests/orangex_paper_journal.test.mjs`이며 실행 시간은 약 551초, 오류는 `Promise resolution is still pending but the event loop has already resolved`였습니다. 이는 전체 통과가 아니라 **부분 통과 후 취소**입니다.

기존 Linux TAP에서도 해당 구간 바로 다음이 Journal 테스트입니다. 다만 파일별 출력 버퍼링이 있으므로 마지막 출력 번호만으로 Journal 안의 특정 테스트나 Windows OS 내부 원인을 확정하지 않았습니다.

클라우드 환경은 Linux입니다. 실제 Windows를 로컬 실행했다고 표시하지 않습니다. 지정 실행의 직접 API 조회는 현재 네트워크 정책에서 `api.github.com`이 허용되지 않아 **Forbidden**으로 차단됐습니다. 사용자 제공 로그와 직접 수집한 Linux·합성 장애 증거를 구분합니다.

## 수정한 종료 결함

| 파일·함수 | 기존 결함 | 수정 및 검증 |
|---|---|---|
| `tests/orangex_paper_journal.test.mjs` · killed-writer 테스트 | ACK 후 SIGKILL을 보낸 다음 `close` Promise를 무제한 기다렸고 실패 정리도 같은 Promise를 기다림. stderr 미소비 | `tests/helpers/journal_writer.mjs`의 `killAcknowledgedJournalWriter`로 ACK·오류·취소·양쪽 파이프·급정지·종료 확인을 관리. ACK 5초와 원래 테스트 10초 유지. 종료 확인은 1초+1초 상한이며 확인되지 않으면 `CHILD_CLOSE_TIMEOUT` 실패 |
| `tests/helpers/child_process.mjs` · `trackChild`, `stopChild` | 정리 시점에 `close`를 구독하면 이미 끝난 이벤트를 놓침. `exit`만 확인하면 파이프·파일 핸들이 남을 수 있음 | 생성 직후 추적하고 표준 입출력까지 닫힌 `close`를 기다림. 무응답은 제한된 강제 종료 후 실패. Windows 알림 자식은 부모 PID가 살아 있을 때 `/T /F`로 소유 트리 종료 |
| 서버·PNL·알림·TradFi HTTP 통합 테스트 | 종료 직후 짧게 기다리고 폴더 삭제, 무제한 종료 대기, 응답 본문 미소비 | 완전 종료 후에만 삭제·재시작. 상태만 검사하는 응답도 소비. Windows 파일 정리는 유한 횟수 재시도 후 실패하며 오류를 숨기지 않음 |
| `tests/helpers/http_request.mjs` · `fetchLocal` | 바깥 폴링 기한만으로는 진행 중인 HTTP·본문 읽기를 취소할 수 없음 | 개별 요청 기한과 테스트 취소 신호를 합성. 헤더 무응답·본문 미완료의 로컬 서버로 실제 취소 재현 |
| 기존 CLI 회귀 테스트의 `spawnSync` | 일부 자식 실행에 상한이 없고 동기 대기 중에는 바깥 테스트 타이머도 진행하지 못함 | 15초 및 SIGKILL 상한, 실행 오류 확인. 기존 성공·원장·백업·복원 검증을 유지 |
| `orangex_paper_fault_recovery25`, `orangex_process_cleanup27` | 유사한 강제 종료 후 무제한 대기·늦은 `close` 구독 | 동일한 소유 프로세스 정리를 사용. 부분 체결 수량·PID 잠금 회수·중복 체결·펀딩·PNL 검증 유지 |

합성 `close` 누락 조건에서 기존 ACK→SIGKILL→대기 흐름이 끝나지 않는 것을 재현했고, 수정 흐름은 명시적 종료 오류로 끝났습니다. 실제 자식에 256KiB stderr를 기록하는 경우도 검사했습니다. 이는 종료 결함의 재현이며 **Windows에서 원래 `close`가 전달되지 않은 정확한 이유나 원래 오류 문구 전체를 재현했다고 주장하지 않습니다.**

`.git`, 사용자 `.env`·store·업데이트 폴더를 테스트용 복사에서 제외했습니다. Windows 파일 복사·동기 저장 부하가 더 느릴 가능성은 있지만, 이를 실제 551초 정체의 원인이라고 단정하거나 안전한 fsync를 삭제하지 않았습니다.

## GitHub Actions 변경

- `.github/workflows/node-tests.yml`의 **`timeout-minutes: 10`은 그대로**입니다. Linux/Windows × Node.js 22/24 네 환경도 유지합니다.
- Windows는 Journal 파일을 먼저 독립 실행하고, 이후 전체 테스트를 실행합니다. 개별 Journal 검사가 실패해도 취소되지 않은 작업에서는 전체 검사도 수행합니다.
- `npm run test:ci`는 기존과 동일한 `tests/*.test.mjs` 파일 전체를 발견하며 **모든 OS에서 파일 동시 실행 2개**를 사용합니다. 파일 누락·0개 실행·실패·취소·건너뛰기·미완료 결과는 성공으로 처리하지 않습니다.
- `scripts/run-node-tests.mjs`는 파일 프로세스 전체에 별도 상한을 적용합니다. Journal 독립 실행은 60초, 전체 검사에서는 파일당 최대 120초입니다. 제한 위반은 소유 프로세스 트리를 종료하고 **실패**로 기록합니다. 다른 정상 파일의 검사는 계속합니다.
- 이 상한은 정상 결과로 위장하기 위한 시간이 아닙니다. 테스트 본문이 끝나도 타이머·자식이 살아 있으면 기본 Node 테스트 기한만으로 프로세스가 종료되지 않는 조건을 재현했고, 독립 실행기로 해당 파일을 실패 처리하는지 검사했습니다.
- 시작·종료·15초 간격 활성 파일 로그, 각 파일의 TAP, `progress.json`, `summary.json`을 저장합니다. 실패 시에도 GitHub 아티팩트에 보관합니다. 전체 취소는 활성 자식을 정리하고 부분 결과·미실행 파일을 남기며 성공으로 표시하지 않습니다.
- 마지막 결과 직후 취소되는 경계와 시작·종료 로그/진행 파일 쓰기 실패도 검사해, 취소를 성공으로 표시하거나 실행기 자체 오류 때문에 자식을 남기지 않도록 했습니다.

## 최종 검증

| 검사 | 결과 |
|---|---|
| Linux Node.js 22.23.4 기존 방식 전체 회귀 | **747/747 통과**, 실패·취소·건너뛰기 0, 약 34초 |
| Linux Node.js 24.19.0 기존 방식 전체 회귀 | **747/747 통과**, 실패·취소·건너뛰기 0, 약 35초 |
| 새 CI 실행기 · Node.js 22·24 | 각 **97개 파일 / 747개 검사 전체 통과**, 파일 실패 0, 각 약 36초 |
| Journal npm 선행 명령 · Node.js 22·24 | 각 **16/16 통과**, 정상 종료 확인 |
| JavaScript/MJS 구문 | **199개 통과** |
| Windows 프로세스 트리 명령 | Mock 검사 통과, 실제 Windows 실행과 구분 |
| 수정 후 Windows Node.js 22·24 Actions | **UNVERIFIED** — 현재 GitHub API 정책 차단으로 원격 결과 미확인 |

기존 726개 검사에 종료·HTTP·Journal·실행기 장애 재현 21개를 추가했습니다. 테스트를 건너뛰거나 실패 조건을 낮추지 않았습니다. 개발 중 추가한 부분 체결 테스트의 신호 함수 이름 충돌 1건은 수정 후 전체 재검증했습니다. 사용자 제공 Windows 실패·합성 수정 전 무한 대기·최종 정상 결과를 따로 보존합니다.

기계 판독 결과는 `reports/pr7-windows-validation.json`, 원본 TAP·파일별 결과·수정 전 장애 재현 자료는 클라우드 `/workspace/signal-pr7-windows-evidence`에 있습니다.

전체 검사는 별도 임시 데이터 경로와 Mock·합성 자료·로컬 서버로 수행했습니다. 실제 OrangeX 데이터나 실제 주문·취소·계좌 API를 사용하지 않았습니다. Windows `taskkill` 명령 분기는 Mock으로 검사했고 프로세스·파이프·HTTP 장애는 Linux 실제 프로세스에서 검사했습니다. 이 결과를 실제 Windows 성공으로 표시하지 않습니다.

## 보존·제출·남은 확인

서버·스캐너·모의매매·PNL·저장·실험 Journal의 운영 코드는 `2043ea2`와 동일합니다. 변경은 테스트·CI 실행기·워크플로·보고서에 한정합니다. 기존 미커밋 작업 파일 28개도 해시가 동일합니다. 실제 Windows PNL·`.env`·설정·백업에 접근하거나 초기화하지 않았습니다.

OrangeX는 **READ_ONLY / 실제 데이터 PAPER 자동 진입 OFF / LIVE OFF**이며 main 병합은 하지 않습니다.

새 Windows Node.js 22·24의 Journal 개별 실행과 전체 실행이 해당 커밋에서 실제 성공했는지 원격 확인하는 것이 남은 완료 조건입니다. 저장된 환경설정 초안에는 `api.github.com`이 있지만 현재 실행 정책에는 적용돼 있지 않습니다. 허용 정책이 실행환경에 적용된 뒤 GitHub 결과를 다시 조회해야 합니다. Push나 Linux 통과만으로 Windows 성공을 선언하지 않습니다.

로컬 재현 명령은 `npm run test:ci -- --file tests/orangex_paper_journal.test.mjs --concurrency 1 --file-timeout-ms 60000`, 전체 검사는 `npm run test:ci`입니다. 기본 출력은 별도 임시 폴더에 저장되며 기존 `npm test` 명령도 유지합니다.
