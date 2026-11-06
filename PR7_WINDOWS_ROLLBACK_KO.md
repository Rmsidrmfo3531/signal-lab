# PR #7 Windows 부분 쓰기 롤백 보완

비교 기준: `d8bef17` · 실패 근거: 사용자가 제공한 GitHub Actions [#42133836869](https://github.com/Rmsidrmfo3531/signal-lab/actions/runs/42133836869) 결과. 당시 Linux Node 22·24는 성공했고, Windows는 각각 **765/767 통과**, 부분 쓰기 ENOSPC 검사 2개가 실패했습니다.

## 원인과 수정

Journal과 실험 segmented 저장소는 로그를 `O_WRONLY | O_APPEND`로 열고, 부분 쓰기 실패 후 같은 핸들에 `ftruncateSync()`를 호출했습니다. Windows용 libuv는 `O_APPEND`를 처리할 때 `FILE_WRITE_DATA`를 제거하고 `FILE_APPEND_DATA`를 부여합니다. 따라서 이 핸들은 추가 쓰기가 가능해도 길이 복구가 거부될 수 있습니다. `O_RDWR | O_APPEND`로만 변경해도 같은 처리를 거칩니다.

Node 22·24에 사용하는 libuv 버전의 공식 소스를 직접 조회해 이 동작을 확인했습니다.

- [libuv 1.51.0 Windows fs.c](https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c): append 접근 권한 변경과 `fs__ftruncate()`의 파일 길이 변경 호출
- [libuv 1.52.1 Windows fs.c](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c#L494): 같은 접근 권한 처리

새 공통 복구 모듈은 다음 조건을 **모두 확인한 뒤에만** 롤백 완료를 인정합니다.

1. 기존 append 핸들을 닫고, 같은 파일을 **`O_RDWR | O_NOFOLLOW`**로 다시 엽니다. APPEND·CREATE·TRUNC는 사용하지 않습니다.
2. 열린 파일과 경로의 파일 식별자, 일반 파일 여부, 링크 수와 길이를 확인합니다.
3. 기존 확정 바이트의 SHA256과 이번에 쓰려던 레코드의 부분 tail이 일치하는지 검사합니다. 다른 내용은 임의로 잘라내지 않습니다.
4. 기존 길이로 truncate하고 일반 파일을 fsync합니다.
5. 파일 식별자·정확한 길이·기존 내용의 SHA256을 다시 확인하고 복구 핸들을 정상 종료합니다.

모든 확인이 성공한 경우 원래 `ENOSPC`를 반환하고 안전한 1회 재시도를 허용합니다. 검사·truncate·fsync·close 중 하나라도 실패하면 기존 `JOURNAL_COMMIT_UNCERTAIN` 또는 `SCALE_COMMIT_UNCERTAIN`으로 쓰기를 계속 차단합니다. 오류 이름만 바꾸어 통과시키지 않습니다.

원래 쓰기 오류와 실제 롤백 오류의 `stage / code / syscall`, 확인된 단계와 정리 오류를 별도로 보존합니다. Journal은 `status().lastAppendFailure`와 테스트 단계 로그에서도 이를 확인할 수 있습니다. 실제 기록 내용이나 인증정보는 진단에 넣지 않습니다.

추가 리뷰에서 정상 append의 `closeSync()`가 핸들을 해제한 뒤 오류를 반환하면 같은 번호를 다시 close할 수 있는 경로도 확인했습니다. 호출 전에 소유권을 넘기고, 이런 경우 재close·truncate·ACK 없이 차단하도록 수정했습니다. 재시작 후 원장을 다시 검증하면 이미 기록된 ID는 중복 처리하지 않습니다.

확정 prefix 해시는 초기화·재시작 적재 때 준비하고 정상 append에서는 새 레코드 바이트만 추가합니다. 매번 전체 원장을 읽거나 복제하지 않습니다. 전체 prefix 재확인은 실패 복구 경로에서만 64KiB 단위로 수행합니다. 기존 파일 형식과 사용자 지정 레코드 크기 설정은 유지합니다.

## 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `durable_append_recovery.mjs` | Windows와 Linux 공통의 검증된 append 실패 복구 |
| `orangex_paper_journal.mjs` | raw prefix 해시, 복구 helper, 실패 진단, close 소유권 처리 |
| `orangex_paper_storage_lab.mjs` | 같은 복구 규칙과 불확실 상태의 지속적인 쓰기 차단 |
| `tests/durable_append_recovery.test.mjs` | 권한 모델, 변조·길이·정체성·동기화·close 실패 및 큰 레코드 |
| Journal·규모 테스트 | ENOSPC 복구, 원인 보존, 재시작·checkpoint·중복 방지와 close 오류 회귀 |
| `updater.mjs`, `tests/updater.test.mjs` | 새 런타임 모듈의 검증된 업데이트 허용 목록 등록 |

## 검증 범위

Windows의 append 핸들 truncate를 `EPERM`으로 거부하는 **Linux상의 권한 모델**에서 수정 전 두 실패를 재현했습니다. 수정 후에는 복구 전용 핸들로 검증된 롤백을 완료하고, 재시도·checkpoint·재시작 후 ID·PNL·펀딩 중복 방지를 검사합니다. 이 모델의 성공과 실제 Windows 실행은 별도입니다.

복구용 open·truncate·fsync·close의 실제 errno, prefix·tail 변조, 경로 교체·링크·길이 이상, 동작하지 않은 truncate, close 후 오류에서도 성공 ACK와 재시도를 거부하는 검사를 추가했습니다. 기존 767개 검사를 삭제하거나 건너뛰지 않았으며 테스트·작업자·워크플로 시간제한을 늘리지 않았습니다.

| 최종 검사 | Node 22.23.4 · Linux | Node 24.19.0 · Linux |
|---|---|---|
| 전체 단위·통합 검사 | **792/792**, 37.164초 | **792/792**, 36.681초 |
| Actions와 같은 CI 실행기 | **100개 파일·792/792**, 38.523초 | **100개 파일·792/792**, 39.484초 |
| CI Journal 파일 | **26/26**, 0.490초 | **26/26**, 0.508초 |
| CI 저장 성능 파일 | **4/4**, 0.862초 | **4/4**, 0.888초 |
| CI 저장 규모 파일 | **23/23**, 0.530초 | **23/23**, 0.557초 |
| CI 공통 복구 파일 | **11/11**, 0.101초 | **11/11**, 0.128초 |

모두 실패·취소·건너뛰기 0건입니다. JS/MJS 구문 검사 **205개**도 통과했습니다. 각 파일 시간에는 CI 실행기의 프로세스 시작·종료 확인이 포함됩니다.

같은 작은 합성 원장에 23바이트 부분 쓰기와 Windows append 권한 제한을 적용한 독립 비교에서도 Node 22·24의 두 저장 모듈 모두 수정 전 실패를 재현하고 수정 후 복구·재시작 검증을 통과했습니다.

| 권한 모델 · 오류 또는 롤백 확인까지 | 수정 전 | 수정 후 |
|---|---|---|
| Node 22 Journal | 4.125ms, 복구 불확실 | 4.185ms, 검증된 롤백 |
| Node 22 segmented | 9.991ms, 복구 불확실 | 8.797ms, 검증된 롤백 |
| Node 24 Journal | 3.746ms, 복구 불확실 | 4.173ms, 검증된 롤백 |
| Node 24 segmented | 9.133ms, 복구 불확실 | 9.073ms, 검증된 롤백 |

이는 단회 Linux 모델 관측이며 Windows 실행시간이나 성능 개선의 근거가 아닙니다. 실제 Windows 수정 전후 시간은 확보하지 못했습니다. 개발 중 샌드박스 안에서 실행한 진단은 자식 프로세스 권한 제한으로 실패한 적이 있으며, 위 최종 결과는 정상적인 자식 프로세스·localhost 권한을 가진 실행에서 다시 확인한 결과입니다.

기계 판독 결과는 `reports/pr7-rollback-validation.json`, 상세 TAP·재현 근거는 클라우드 `/workspace/signal-pr7-rollback-evidence`에 보관합니다.

## 원격 Windows 확인 상태

**새 커밋의 실제 Windows Node 22·24 성공은 아직 UNVERIFIED입니다.** 현재 클라우드 네트워크 정책에는 `api.github.com` 허용이 적용되지 않았고, 지정 실행의 `gh run view`도 `Forbidden`으로 차단됐습니다. Push나 로컬 통과를 원격 성공으로 간주하지 않습니다. 허용 정책을 실행환경에 적용한 뒤 새 커밋과 일치하는 네 작업의 종료 상태를 확인해야 합니다.

- [PR #7](https://github.com/Rmsidrmfo3531/signal-lab/pull/7)
- [기능 브랜치 Actions](https://github.com/Rmsidrmfo3531/signal-lab/actions?query=branch%3Afeat%2Fissue6-integrated)

## 보존 상태

실제 사용자 PNL·설정·백업은 접근하거나 변경하지 않았습니다. 모든 장애 주입과 거래 원장은 별도 임시 폴더의 합성 자료입니다. 기존 서버·스캐너·일반 PAPER·운영 Snapshot·PC/모바일 코드·백업 도구·CI 시간제한은 그대로이며, 기존 별도 작업 디렉터리의 미커밋 파일 28개도 SHA256으로 보존을 확인합니다.

Journal은 계속 실험용이며 운영 저장으로 전환하지 않습니다. **READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF, LIVE OFF, main 미병합**을 유지합니다.
