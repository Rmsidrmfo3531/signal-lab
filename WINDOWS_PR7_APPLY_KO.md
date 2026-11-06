# PR #7 Windows 검증용 적용·복구

PR #7은 main과 별개의 검토 버전입니다. 실제 Windows PC와 `%LOCALAPPDATA%\SignalLab` 접근·실행은 UNVERIFIED입니다. 아래 명령은 PC에서 직접 실행하는 절차입니다. Git이 없다면 PR #7의 `feat/issue6-integrated` 브랜치를 ZIP으로 받아 새 폴더에 모두 풀고 3단계부터 진행합니다.

## 1. 서버 종료 후 전체 데이터 백업

기존 Signal Lab 서버 창마다 Ctrl+C로 종료합니다. 다른 Node 프로그램을 일괄 종료하지 마세요. PowerShell에서 실행합니다.

```powershell
$ErrorActionPreference = 'Stop'
$records = Join-Path $env:LOCALAPPDATA 'SignalLab'
if (-not (Test-Path (Join-Path $records 'store.json'))) { throw '기존 기록 경로를 확인하세요. 적용을 중단합니다.' }
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
$backup = Join-Path $env:USERPROFILE ("SignalLab-Backups\pre-pr7-" + $stamp)
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -Path (Join-Path $records '*') -Destination $backup -Recurse -Force
foreach ($file in @('store.json', '.env')) {
    $original = Join-Path $records $file
    if (Test-Path $original) {
        if ((Get-FileHash $original).Hash -ne (Get-FileHash (Join-Path $backup $file)).Hash) { throw '백업 검증 실패. 적용을 중단합니다.' }
    }
}
Write-Host "전체 백업 위치: $backup"
```

이 복사본은 PNL·포지션·TP·본절 설정·매매일지·Telegram 설정·기존 백업을 함께 보존합니다. `.env` 내용을 출력하거나 공유하지 않습니다. 기존 앱의 자동 백업은 기본 30개 보관 정책이므로 이 별도 전체 복사본도 유지하세요. 잠금 파일을 무작정 삭제하지 마세요.

## 2. 새 코드 폴더 준비

같은 PowerShell 창에서 실행합니다. 기존 코드 폴더나 데이터 폴더 위에 덮어쓰지 않습니다.

```powershell
$release = Join-Path $env:USERPROFILE ("SignalLab-Releases\pr7-" + $stamp)
git clone --single-branch --branch feat/issue6-integrated https://github.com/Rmsidrmfo3531/signal-lab.git "$release"
if ($LASTEXITCODE -ne 0) { throw '다운로드 실패. 기존 버전을 유지하세요.' }
Set-Location $release
git rev-parse HEAD
node --version
```

출력 커밋을 최신 Codex 보고서의 검증 커밋과 비교합니다. 이후 브랜치가 변경됐다면 `git checkout --detach <검증 커밋 SHA>`로 정확히 그 커밋을 선택합니다. Node.js는 22 또는 24가 필요합니다. 외부 npm 의존성이 없어 `npm install`은 필요하지 않습니다.

## 3. READ_ONLY로 시작

기존 `.env`·`store.json`·예제 환경 파일을 새 코드 폴더로 복사하지 않습니다. 중앙 데이터 경로를 그대로 사용합니다. 아래 첫 줄은 현재 프로세스의 개발·테스트용 경로 override만 지우며 실제 폴더를 삭제하지 않습니다.

```powershell
Remove-Item Env:SIGNAL_LAB_DATA_DIR -ErrorAction SilentlyContinue
$env:ORANGEX_ENABLED = 'false'
$env:ORANGEX_MODE = 'READ_ONLY'
$env:AUTO_UPDATE = 'false'
$actualData = node data-cli.mjs path
if ($LASTEXITCODE -ne 0 -or $actualData.Trim() -ne $records) { throw '데이터 경로가 다릅니다. 시작을 중단합니다.' }
.\start.bat
```

`data-cli.mjs path`가 기존 `%LOCALAPPDATA%\SignalLab`인지 확인하고 다르면 시작을 중단합니다. PC는 기본 `http://127.0.0.1:3000`이며 기존 포트 설정이 있으면 그 포트를 사용합니다. 모바일은 PC 서버를 종료한 뒤 같은 창에서 `start_mobile.bat`으로 시작하고 같은 사설 Wi-Fi에서 표시된 주소·접속 암호를 사용합니다.

페이지 이동 후 기존 PNL·미청산 TP1/TP2/TP3·본절 상태·매매일지를 확인합니다. OrangeX는 READ_ONLY, 실제 데이터 PAPER 자동 진입 OFF여야 합니다. Telegram은 최종 신호가 있을 때만 발송하며 미진입 수량은 '미확인'입니다. 실제 수신은 PC에서 별도 확인해야 합니다.

## 4. 문제 발생 시 복구

새 서버와 기존 서버를 모두 종료하고 이전 버전 코드 폴더 또는 검증된 코드 폴더에서 실행합니다. `$backup`은 1단계에서 출력한 실제 경로입니다.

```powershell
node data-cli.mjs restore "$backup\store.json"
```

복원 도구는 실행 중 서버 잠금이 있으면 거부하고 복원 전 현재 기록도 별도로 보존합니다. `.env`는 이 명령으로 변경하지 않습니다. JSON을 초기화하거나 데이터 폴더를 삭제하지 마세요. 업데이트 후 새 거래가 생겼다면 그 기록도 보존하고 두 store 파일을 임의로 합치지 않습니다.

## 실제 메시지 없이 Telegram 검증

다음은 네트워크 발송을 Mock으로 대체한 테스트입니다. 운영 필터를 완화하거나 실제 봇을 호출하지 않습니다. 결과는 실제 Telegram 수신 증거가 아닙니다.

```powershell
node --test tests/telegram_delivery.test.mjs tests/telegram_final_only.test.mjs tests/links.test.mjs tests/news_storage.test.mjs
```
