# Windows에서 OrangeX 공개 API만 점검하기

대상은 `signal-lab`의 `feat/orangex-readonly`입니다. `meme-signal-lab`용 도구가 아닙니다. 클라우드의 OrangeX 허용 정책이 아직 적용되지 않아, 사용자의 Windows 인터넷 연결에서 공개 응답을 수집하는 도구를 제공합니다.

## 실행 전 확인

- Node.js 22 또는 24와 Windows의 `curl.exe`가 필요합니다. 별도 npm 패키지는 설치하지 않습니다.
- 최신 기능 브랜치의 `scripts/diagnose-orangex-public.mjs`가 있는 프로젝트 폴더에서 실행하세요. 기존 파일에 수정 사항이 있으면 강제로 덮어쓰거나 `git reset --hard`를 실행하지 마세요.
- API 키는 필요 없습니다. `.env`를 만들거나 변경할 필요도 없습니다. 서버를 켜지 않고 실행합니다.
- 도구는 `.env`, PNL, 설정, 백업, `%LOCALAPPDATA%\SignalLab`을 읽거나 수정하지 않습니다. 기본 출력은 콘솔의 JSON뿐입니다.
- 현재 Windows의 프록시·인증서 설정을 그대로 사용합니다. TLS 검증을 끄거나 클라우드 프록시를 우회하는 기능은 없습니다.

PowerShell에서 프로젝트 경로를 본인 PC의 경로로 바꿔 실행하세요.

```powershell
Set-Location 'C:\본인의경로\signal-lab'
git status --short --branch
node --version
curl.exe --version
npm run diagnose:orangex
$LASTEXITCODE
```

기존 검사도 별도로 실행할 수 있습니다. 이 검사는 현재 어댑터의 공개 호가 조회만 확인하며, 프록시 CONNECT 증거를 수집하는 새 도구와 구분합니다.

```powershell
npm run test:orangex
$LASTEXITCODE
```

## 결과를 임시 파일로 저장하기

아래는 Windows 임시 폴더에 새 JSON 파일을 만드는 선택 사항입니다. 기존 거래 기록 경로에는 저장하지 않습니다. npm의 실행 안내문이 JSON에 섞이지 않도록 `node`를 직접 실행합니다.

```powershell
$diagnosticPath = Join-Path $env:TEMP ('SignalLab-OrangeX-Public-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
node .\scripts\diagnose-orangex-public.mjs | Out-File -FilePath $diagnosticPath -Encoding utf8
$diagnosticExit = $LASTEXITCODE
Write-Host "종료코드: $diagnosticExit"
Write-Host "결과 파일: $diagnosticPath"
```

도구는 인증을 요청하지 않고 원본 응답·헤더·오류 본문을 그대로 출력하지 않습니다. 공유할 때도 이 JSON 결과만 사용하고 `.env`, API 키, 토큰, 계정 화면을 첨부하지 마세요.

## 조회 범위와 검증 한계

고정된 공식 문서 호스트와 OrangeX API 호스트에 HTTPS GET만 전송합니다. 공식 문서 루트와 `/public/get_instruments`, `/public/tickers`, BTC·ETH·SOL의 `/public/get_order_book`을 진단합니다. 인증·계좌·주문·취소·출금 경로는 없습니다. 다른 호스트로의 리다이렉트도 따라가지 않습니다.

사용자가 공식 문서에서 확인한 세 경로와 필수 매개변수 조건을 반영했습니다. `get_instruments?currency=USDT`와 계약별 `tickers?instrument_name=...`를 요청합니다. `USDT`의 통화 의미와 실제 허용값·응답 필드·단위는 독립 검증 전까지 미검증입니다. HTTP 400을 네트워크 차단이나 상장 폐지로 해석하면 안 됩니다. 임의의 비공개 API나 추측한 인증 방식으로 재시도하지 않습니다.

현재 기본 BTC·ETH·SOL 진단은 문서 1 + 상장 1 + 종목별 티커 3 + 호가 3으로 **8건**입니다. 예전 Windows 6건 관측은 이전 버전의 결과입니다. 새로운 검사에서는 해당 종목 티커의 Mark와 그 시각도 별도로 확인하므로 호가만 최신이어도 완료로 표시하지 않습니다. `min_trade_amount`, `min_qty`, 주문 증분과 수수료 원값은 서로 대체하거나 단위 환산하지 않습니다.

호가 후보인 `BTC-USDT-PERPETUAL`, `ETH-USDT-PERPETUAL`, `SOL-USDT-PERPETUAL`은 상장 목록에서 대응 항목이 관측되기 전까지 확정 계약명이 아닙니다. 응답이 성공해도 공식 계약 규격과 비교하기 전에는 주문 가능을 승인하지 않습니다. 응답에 없는 Mark Price·최소 수량·가격/수량 단위·수수료는 미확인입니다. 중간값을 Mark Price로, 최소 명목금액을 최소 수량으로, 누락된 수수료를 0으로 대체하지 않습니다.

정상 종료도 공개 응답 관측을 뜻합니다. 공식 명세 전체 일치, 실제 체결 가능성, 개인 계정별 수수료, PAPER·LIVE 준비 완료를 뜻하지 않습니다. 이 도구는 기존 서버나 OrangeX 화면의 운영 모드를 변경하지 않습니다.

도구는 자산당 중복을 제거한 최대 3개 계약을 조회합니다. 생략된 계약 수는 `additionalContractsOmitted`로 표시하며, 거래소 전체 계약을 무제한 조회하지 않습니다. Mark Price의 시각·신선도는 호가와 별도로 표시합니다. 티커 시각이 없으면 최신 호가 시각을 빌려 쓰지 않습니다.

종료코드는 `0`이면 지원하는 공개 응답 구조와 호가 신선도 관측, `1`이면 HTTP·API·스키마·신선도 등의 검사 실패, `2`이면 전송 실패입니다. HTTP 성공이어도 공식 계약 단위·수수료 검증은 별도입니다. 시각은 응답의 밀리초 형태를 기준으로 신선도를 진단하며, 단위 자체는 공식 문서 대조 전까지 미검증으로 남깁니다.

## 오류별 다음 확인

| 결과 | 의미와 다음 확인 |
|---|---|
| 프록시 CONNECT 거부 | 원 서버 도달 전 프록시가 연결을 거부했습니다. 관리자가 해당 도메인을 허용해야 합니다. 프록시 설정을 제거해 우회하지 마세요. |
| DNS 또는 프록시 DNS | 목적지 또는 프록시 이름 해석 실패입니다. 인터넷·회사망 DNS와 프록시 이름을 확인하세요. |
| TLS | 인증서·TLS 연결 실패입니다. PC 시간, Windows 인증서, 회사 프록시의 공식 인증서 설정을 확인하세요. 검증을 끄지 마세요. |
| 타임아웃 | 제한 시간 안에 연결 또는 응답이 끝나지 않았습니다. 이것만으로 거래소 장애나 정책 차단을 단정할 수 없습니다. |
| HTTP 오류 | HTTP 상태를 관측한 경우입니다. CONNECT 상태와 구분하세요. 403만으로 거래소와 중간 장비 중 누가 응답했는지는 확정할 수 없습니다. |
| API·스키마·신선도 오류 | HTTP 응답은 있어도 API 오류, 예상 구조 불일치, 시각 누락·만료가 있습니다. 공식 문서 및 JSON의 관측 필드를 대조해야 합니다. |

공개 데이터가 실제로 관측되면 계약명·상장 상태·계약 크기와 단위·최소 주문량·가격 단위·호가·Mark Price·수수료 필드를 공식 문서와 다시 비교합니다. 누락 항목은 미검증으로 남깁니다. 그 확인 전에는 기존 READ_ONLY를 유지합니다.
