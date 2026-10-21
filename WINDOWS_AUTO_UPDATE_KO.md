# Windows PC 무중단 기록 보존 자동 업데이트 (검증용 초안)

기존 Signal Lab 수정 브랜치에 종속된 PR #2 안에 포함됩니다. **PR이 draft이고 CI 검사 결과가 확인되지 않았으므로 바로 설치하거나 자동 업데이트를 켜지 마세요.**

## 이후 최초 1회 준비
1. PR #1과 PR #2의 코드를 검토하고 GitHub Actions 4개 (Windows/Linux × Node22/24) 모두 성공한 후 변경사항을 **main**에 병합합니다.
2. Windows에서 GitHub CLI 설치: `winget install --id GitHub.cli -e`. 새 터미널에서 `gh auth login`을 수행해 본인 비공개 저장소 접근을 허용합니다.
3. 이 자동업데이트를 지원하는 검증된 코드를 **한 번만** 기존 Windows 설치 폴더에 넣습니다. `%LOCALAPPDATA%\SignalLab_v6_Test\store.json`과 일반 `%LOCALAPPDATA%\SignalLab\store.json`의 원본을 별도로 백업합니다.
4. 기존 Signal Lab을 완전히 종료하고 `enable_auto_update.bat`을 실행합니다. main의 최신 커밋에 대한 4개 통과 결과가 없다면 활성화되지 않습니다.
5. 기존 테스트(3100번 포트와 별도 PNL)를 계속하려면 `start_auto_test.bat`을 사용합니다. 정식 데이터(기본 3000번)를 쓰려면 `start_auto.bat`을 사용합니다. 두 프로그램을 동시에 켜지 마세요.

## 이후 15분마다 자동 처리
- GitHub `main`의 **동일 커밋 SHA**에 대한 `Node.js tests`의 **push** CI가 성공해야 하고 Windows/Linux 각각 Node22·24 테스트가 모두 성공해야 승인됩니다.
- 비공개 저장소는 GitHub CLI 자격증명을 사용하고 `git blob` SHA-1과 다운로드된 SHA-256을 각각 검증합니다. 인증이 안 되거나 원본 변조 가능성이 있으면 설치하지 않습니다.
- 독립 폴더에서 다운로드된 전체 테스트를 실행한 뒤 감독자가 서버의 데이터 저장 완료를 요청하고 종료를 기다립니다.
- 기존 PNL `store.json`은 데이터 디렉터리에 별도 백업하고, 코드 전체를 복사한 후 교체합니다. 서버 헬스체크가 30초 안에 통과해야 업데이트 완료로 기록합니다.
- 새 서버가 구동되지 않으면 이전 코드로 복구한 후 재실행합니다. `.env`, `store.json`, `backups` 등 사용자 데이터는 코드 업데이트에서 덮어쓰지 않습니다.
- 업데이트 조회나 테스트 실패 시에는 **기존 서버를 계속 실행**합니다.

**중요:** PC를 끄면 스캔이 중단됩니다. 기존 Node.js 22 이상과 GitHub CLI 인증이 필요합니다. 앱이 새 버전에서 사용자 데이터 형식을 변경하는 경우 구버전 롤백 호환성을 별도로 테스트해야 합니다. 실제 주문은 보내지 않습니다.