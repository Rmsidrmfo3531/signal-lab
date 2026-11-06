# PR #7 Windows Node 22 파일 식별·정리 보완

기준 커밋: `7bece82` · 사용자 제공 실행: [#42164799345](https://github.com/Rmsidrmfo3531/signal-lab/actions/runs/42164799345)

## 이전 결과와 확인 범위

사용자 확인 자료에서 Linux Node 22·24와 Windows Node 24는 성공했습니다. Windows Node 22는 저장 집중 검사에서 identity 오류 주입 1건, 전체 검사에서 CI 임시 폴더 삭제 1건이 실패했습니다. 이 결과와 새 커밋의 결과는 구분합니다.

실제 Windows 파일 ID 수치와 EBUSY의 전체 경로·잠금 주체는 확보하지 못했습니다. 아래 원인 재현은 Linux에서 파일 ID와 일시적 Windows 파일 잠금을 모델링한 것이며 실제 Windows 실행으로 표시하지 않습니다.

## 1. 파일 식별자 정밀도

기존 테스트는 `Number(stat.ino)+1`로 다른 파일을 주입했습니다. 그러나 JavaScript Number가 정확하게 표현할 수 없는 큰 파일 번호에서는 다음이 모두 참일 수 있습니다.

```js
const a = 2n ** 60n;
Number(a) === Number(a + 1n); // true
Number(a) + 1 === Number(a);  // true
```

따라서 실제로 다른 ID를 주입하지 못하고 정상 롤백으로 끝날 수 있습니다. 테스트 전용 `distinctStatIdentity()`는 원래 타입을 유지하며 0/1 중 확실히 다른 값으로 변경하고, 실제 비교값이 달라졌는지도 단언합니다. `fstatSync()`의 옵션도 그대로 전달합니다. 해당 검사는 주입 횟수, truncate **0회**, 원래 ENOSPC 원인 보존과 계속되는 쓰기 차단까지 확인합니다. Windows CI 로그에는 임시 파일의 ID 타입·원값·주입값·BigInt 옵션 사용 여부만 문자열로 기록합니다.

이와 별도로 기존 복구 코드도 일반 Number 파일 번호를 문자열로 바꿔 비교했으므로 서로 다른 큰 ID가 같은 값으로 반올림되는 위험이 있었습니다. 테스트만 고치지 않고 다음을 함께 수정했습니다.

- Journal과 Scale이 쓰기 전에 `fstatSync(fd, {bigint:true})`로 정확한 기준 ID를 확보합니다.
- 복구 helper의 모든 경로·핸들 조회도 `{bigint:true}`를 사용하고 `dev/ino`를 끝까지 BigInt로 비교합니다.
- 링크 수와 파일 길이를 BigInt로 확인하며, 변경 감지는 정밀도를 낮추지 않도록 `mtimeNs/ctimeNs`로 수행합니다.
- 숫자 기반 Stat을 반환해 옵션을 무시하는 어댑터는 복구 성공으로 인정하지 않습니다.
- 파일 길이는 안전 범위를 확인한 뒤 진단에만 Number로 변환합니다. 오류·JSON에는 원시 BigInt를 넣지 않습니다.

`2**60n`과 그 다음 파일 ID가 Number로 같아지는 WAL 시나리오를 원본 `7bece82`에 적용하면 기대 `SCALE_COMMIT_UNCERTAIN` 대신 `ENOSPC`가 발생했습니다. 수정 후에는 다른 ID를 감지해 파일을 자르지 않고 원장을 보존하며 재시도를 차단합니다. 장치 ID 충돌, 나노초 변경, BigInt 옵션을 무시하는 어댑터도 검사합니다.

기존 prefix 해시·tail·길이·fsync·close 검증과 불확실 상태 차단은 그대로 유지합니다.

## 2. CI 작업자 종료와 임시 폴더 정리

기존 코드는 작업자의 close를 기다린 뒤에도 `fs.rmSync()`의 재시도 동안 이벤트 루프를 막았습니다. 지연된 파일·파이프 종료 콜백이 필요한 일시적 잠금 상황을 모델로 재현하고, 다음과 같이 보완했습니다.

- 각 작업자의 PID, 프로세스·stdout·stderr·로그 파일의 close 결과와 정리 오류를 기록합니다. 보고 콜백이 실패해도 이 증거를 보존합니다.
- 종료 증거가 불확실하면 trace 디렉터리를 삭제하지 않고 실패를 유지합니다.
- trace 삭제와 실패 테스트의 임시 폴더 삭제를 비동기로 수행해 지연된 종료 콜백이 실행되게 합니다.
- 임시 폴더 삭제 전에 소유 PID가 실제 종료했는지도 확인합니다. 살아 있는 작업자가 있으면 삭제·성공 처리하지 않습니다.
- 재시도 예산은 기존과 같은 **최대 8회 재시도·100ms 선형 간격**입니다. 지속적인 EBUSY나 비대상 오류는 그대로 실패합니다. 워크플로·테스트·작업자 시간제한을 늘리지 않았습니다.

지연된 close 콜백이 잠금을 해제하는 경우, 살아 있는 실제 자식 프로세스, 닫히지 않은 파이프·로그, 지속적인 EBUSY를 각각 검사했습니다. 실제 Windows EBUSY의 잠금 주체는 아직 확정하지 않았으며, 수정 후 Windows CI로 검증해야 합니다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `durable_append_recovery.mjs` | 정확한 BigInt 파일 ID·링크·길이와 나노초 비교 |
| `orangex_paper_journal.mjs`, `orangex_paper_storage_lab.mjs` | append 전 정확한 ID 확보 |
| `scripts/run-node-tests.mjs` | close 증거 수집·불확실 정리 거부·비동기 trace 정리 |
| `tests/helpers/stat_identity.mjs` | 확실히 다른 ID를 주입하는 테스트 도구 |
| `tests/helpers/owned_directory.mjs` | 종료 확인 후 제한된 비동기 정리 |
| 복구·Scale·CI 테스트 | 기존 실패 검사 강화·큰 ID 충돌과 나노초 변경 회귀 |
| `tests/owned_directory_cleanup.test.mjs` | 실제 살아 있는 작업자·지연된 close·영구 잠금 검사 |

## 검증 결과와 남은 확인

| 최종 검사 | Linux Node 22.23.4 | Linux Node 24.19.0 |
|---|---|---|
| 전체 단위·통합 검사 | **800/800**, 36.957초 | **800/800**, 36.998초 |
| GitHub Actions와 같은 CI 실행기 | **101개 파일·800/800**, 38.744초 | **101개 파일·800/800**, 39.101초 |
| CI 작업자 종료 증거 | **101개 모두 프로세스·stdout·stderr·로그 종료** | **101개 모두 프로세스·stdout·stderr·로그 종료** |

실패·취소·건너뛰기는 모두 **0건**입니다. JS/MJS 구문 검사 **208개**도 통과했습니다. 기존 **792개 검사를 유지**하고 새 회귀 8개를 추가했습니다. 모든 원장·장애 주입은 임시 합성 데이터입니다. 실제 Windows 수정 전후 시간은 확보하지 못했습니다.

기계 판독 결과와 파일별 시간은 `reports/pr7-node22-validation.json`, 전체 TAP와 최초 실패 근거는 `/workspace/signal-pr7-node22-evidence`에 기록합니다.

개발 중 추가한 진단 로그의 변수명 오류로 첫 전체 실행에서 identity 테스트 1건이 실패했습니다. 해당 로그를 보존했고 변수명을 수정한 뒤 전체 검사를 다시 실행해 위 결과를 확인했습니다. 실패 테스트를 삭제하거나 판정을 완화하지 않았습니다.

**새 커밋의 GitHub Actions 네 환경 성공은 아직 UNVERIFIED입니다.** 현재 실행환경에 `api.github.com` 허용이 적용되지 않아 지정 실행의 `gh run view`도 `Forbidden`입니다. 로컬 Linux와 모델 검사의 성공을 실제 Windows 성공으로 표시하지 않습니다. 현재 실행환경에 API 허용 정책을 적용한 뒤 정확한 새 커밋의 네 작업 결과를 확인해야 합니다.

- [PR #7](https://github.com/Rmsidrmfo3531/signal-lab/pull/7)
- [기능 브랜치 Actions 목록](https://github.com/Rmsidrmfo3531/signal-lab/actions?query=branch%3Afeat%2Fissue6-integrated)

실제 사용자 PNL·설정·백업은 접근하거나 변경하지 않았습니다. 기존 서버·스캐너·운영 PAPER·Snapshot·PC/모바일 코드·백업 도구를 유지하고, 별도 작업 디렉터리의 기존 미커밋 파일 28개도 SHA256으로 보존을 확인합니다. Journal 운영 전환이나 파일 형식 이관은 하지 않습니다. **READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF, OrangeX 실주문 OFF, main 미병합**을 유지합니다.
