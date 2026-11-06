# PR #7 백업 fsync·프로세스 종료 확인 보완

비교 기준 `3b7ffe5` · 분석 근거 GitHub Actions **#42121369005**의 사용자 제공 로그

## 실패 원인

### Windows: 복사한 일반 파일의 읽기 전용 핸들

기존 `OrangeXPaperJournal.#copyFile()`은 복사 대상을 `O_RDONLY`로 열고 `fsyncSync(fd)`를 실행했습니다. Windows의 일반 파일 flush에 필요한 쓰기 접근 권한이 없어 사용자 로그의 `EPERM / fsync / backup()`과 일치합니다. 디렉터리 fsync의 Windows 지원 제한과는 다른 문제입니다.

복사 대상만 **`O_RDWR | O_NOFOLLOW`**로 열도록 변경했습니다. `O_CREAT`·`O_TRUNC`는 사용하지 않습니다. 복사 대상과 열린 핸들이 일반 파일이고 링크 수·크기가 유효한지 확인한 뒤 동기화하고, 성공·실패에 관계없이 닫습니다. 일반 파일의 `EPERM`·`EIO`는 계속 백업·복원 실패로 전달하며 예외를 무시하지 않습니다. 기존 디렉터리 fsync 예외 정책과 백업 무결성 검사는 유지합니다.

Windows 권한 모델을 적용한 별도 임시 프로세스에서 기존 커밋과 수정본을 비교했습니다. 실제 Windows 실행과는 구분합니다.

| 동일 합성 작업자 | 기존 커밋 | 수정본 |
|---|---|---|
| 저장 성능 · Journal | 종료 1, `FAILED`, `phase:backup`, `code:EPERM` | 종료 0, `PASS` |
| 저장 규모 · Journal | 종료 1, `FAILED`, `phase:backup`, `code:EPERM` | 종료 0, `PASS` |
| Snapshot·segmented 제어군 | 모두 `PASS` | 모두 `PASS` |

따라서 Journal 백업 오류가 성능·규모 작업자의 종료 코드 1로 파생되는 흐름도 재현했습니다. Snapshot과 segmented 백업은 원래 쓰기 핸들로 기록·동기화하므로 동일한 읽기 전용 flush 결함이 없었습니다.

추가 회귀에서는 새 쓰기 핸들의 fsync가 실제로 `EPERM` 또는 `EIO`를 내도록 주입했습니다. 백업 실패·핸들 종료·기존 파일 바이트와 PNL 보존, 복원 실패 시 새 원장 미공개 및 불확실 상태 차단을 확인했습니다. 성공 모델에서는 복사 파일 8개의 flush와 백업·복원·중복 ID·PNL 검증이 통과했습니다.

### Linux: 신호 전송 직후의 종료 상태 경합

기존 `tests/ci_runner.test.mjs`의 `assertTerminated()`는 PID가 존재하면 `/proc/PID/stat`에서 즉시 `Z`를 기대했습니다. 신호를 보낸 직후 커널이 종료 상태를 반영하기 전에는 잠깐 `R`이 보일 수 있어 사용자 로그의 실패와 일치합니다.

새 테스트 전용 `waitForProcessTermination()`은 단조 시계 기준 최대 **1초** 동안 **20ms 이내 간격으로 조건을 재확인**합니다. 이미 종료됐으면 즉시 반환합니다. `ESRCH` 또는 Linux `Z`만 종료로 인정하고, 살아 있는 `R/S`는 통과시키지 않습니다. `/proc`이 사라지는 경합은 PID를 다시 조회하며, 기한까지 살아 있으면 관측 상태와 함께 실패합니다. 고정 sleep이나 종료 검사 삭제로 처리하지 않았습니다.

결정적인 `R→S→Z` 시퀀스, `/proc` 삭제 경합, 권한 오류·잘못된 상태, 실제 살아 있는 자식의 기한 실패와 SIGKILL 후 종료를 검사했습니다. 운영 CI 실행기의 종료 코드는 변경하지 않았습니다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orangex_paper_journal.mjs` | 복사 대상의 쓰기 가능한 flush 핸들·일반 파일 검증·확실한 close |
| `tests/orangex_paper_journal.test.mjs` | Windows 일반 파일 flush 모델, 실제 파일 fsync 오류의 전파·백업/복원·기록 보존 회귀 |
| `tests/helpers/process_termination.mjs` | 종료 상태의 제한된 조건 재확인 |
| `tests/process_termination.test.mjs` | 경합·살아 있는 자식 거부·실제 종료 확인 |
| `tests/ci_runner.test.mjs` | 두 자식 종료 검사를 새 조건 확인 방식으로 유지 |
| `scripts/storage-worker.mjs` | 요청과 일치하는 명시적 실패 JSON의 원래 `phase/code`와 종료 코드를 보존 |
| 저장 성능·규모 스크립트 | 종료 1을 일반 파싱 오류로 덮지 않고 실제 백업 실패 원인을 전달 |
| `tests/storage_worker.test.mjs` | 실패 원인 보존·요청 불일치·시간초과·비영 종료의 `PASS` 거부 회귀 |

실패 JSON은 종류·백엔드·거래 수·변경량이 요청과 일치할 때만 보존합니다. 작업자 오류·신호 종료·시간초과 또는 비영 종료의 `PASS`는 성공으로 인정하지 않습니다. 테스트·작업자·워크플로 시간제한은 늘리지 않았습니다.

## 최종 로컬 검증

| 검사 | 결과 |
|---|---|
| Linux Node.js 22.23.4 전체 단위·통합 검사 | **767/767 통과**, 실패·취소·건너뛰기 0 |
| Linux Node.js 24.19.0 전체 단위·통합 검사 | **767/767 통과**, 실패·취소·건너뛰기 0 |
| GitHub Actions와 같은 CI 실행기 · Linux 22·24 | 각 **99개 파일 / 767개 검사 통과**, 파일 실패 0 |
| Journal 집중 · Node.js 22·24 | 각 **22/22 통과** |
| CI 종료 확인·새 회귀 집중 · Node.js 22·24 | 각 **12/12 통과**, 신규 종료 확인 4개 포함 |
| 저장 성능·규모·작업자 집중 · Node.js 22·24 | 각 **25/25 통과** |
| JavaScript/MJS 구문 | **203개 통과** |
| 수정 후 실제 Windows Node.js 22·24 | **UNVERIFIED — 원격 CI 결과 확인 필요** |

모든 검사는 별도 임시 폴더와 합성 원장·모델·로컬 프로세스를 사용했습니다. Windows 권한 모델과 실제 Windows CI를 구분합니다. 테스트를 건너뛰거나 일반 파일 동기화·백업 검증·종료 검사를 제거하지 않았습니다.

## 실제 GitHub Actions 확인 상태

새 커밋의 **Windows Node.js 22·24 및 네 환경 모두의 실제 성공 확인은 아직 UNVERIFIED**입니다. 현재 실행환경의 네트워크 정책이 `api.github.com`을 허용하지 않아 원격 Actions 조회가 차단됩니다. 저장된 환경설정의 허용을 실행환경에 적용한 뒤 정확한 새 커밋의 결과를 조회해야 합니다. 로컬 통과나 Push를 원격 성공으로 표시하지 않습니다.

- 원래 실패 실행: https://github.com/Rmsidrmfo3531/signal-lab/actions/runs/42121369005
- 기능 브랜치 Actions 목록: https://github.com/Rmsidrmfo3531/signal-lab/actions?query=branch%3Afeat%2Fissue6-integrated

## 데이터 보존

일반 PAPER·PNL·기술 분석·서버·기존 Snapshot·설정·백업/복원 도구는 그대로입니다. 실험 Journal의 형식·잠금·무결성·중복 방지 규칙과 운영 저장 연결 상태를 바꾸지 않았습니다. 실제 사용자 기록을 읽거나 변경하지 않았고, 기존 별도 작업 디렉터리의 미커밋 파일 28개도 보존했습니다.

**READ_ONLY, 실제 시세 PAPER 자동 진입 OFF, LIVE OFF, main 미병합**을 유지합니다.

기계 판독 보고서는 `reports/pr7-fsync-exit-validation.json`, 상세 TAP·권한 모델 재현 자료는 클라우드 `/workspace/signal-pr7-fsync-race-evidence`와 관련 집중 검사 폴더에 있습니다.
