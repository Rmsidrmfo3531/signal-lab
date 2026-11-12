# 클라우드 서버에서 24시간 실행하기

PC를 꺼도 서버가 계속 돌도록 작은 리눅스 클라우드 서버(1GB 메모리)에 설치합니다.

## 1. 서버 만들기 (한 번)
- 지역: **서울 또는 도쿄** (미국 지역은 바이낸스 선물 조회가 막힐 수 있습니다)
- 운영체제: **Ubuntu 24.04 LTS**
- 사양: 1 vCPU · **1GB 메모리** · 25GB 디스크 (512MB는 부족할 수 있습니다)
- 만든 뒤 업체 화면의 **웹 콘솔(Console)** 로 접속합니다 (root).

## 2. 설치 (한 번, 약 5분)
웹 콘솔에서 아래처럼 설치 파일을 만들고 실행합니다(저장소가 비공개라 파일 내용을 붙여 넣습니다).
```
nano install.sh      # deploy/linux/install.sh 내용을 붙여 넣고 저장
bash install.sh
```
`install.sh`는 진행 중에 **공개 키 한 줄**을 보여 줍니다.
GitHub → signal-lab 저장소 → Settings → Deploy keys → Add deploy key 에 붙여 넣고(쓰기 권한 체크 안 함) Enter를 누르면 계속됩니다.

## 3. 키 입력
```
nano /opt/signallab/data/.env
```
PC의 `%LOCALAPPDATA%\SignalLab\.env` 값을 옮겨 적고 저장(Ctrl+O, Enter, Ctrl+X) 후:
```
systemctl restart signal-lab
```

## 4. 화면 보기 (휴대폰·PC 전용 비공개 주소)
```
bash /opt/signallab/app/deploy/linux/tailscale.sh
```
휴대폰·PC에 Tailscale 앱을 설치하고 같은 계정으로 로그인하면 표시된 `https://...ts.net` 주소로 열립니다. 인터넷에 공개되지 않습니다.

## 업데이트
```
bash /opt/signallab/app/deploy/linux/update.sh
```

## 주의
- 클라우드 서버를 켠 뒤에는 **PC 서버를 켜지 마세요** (주문이 두 번 들어갈 수 있습니다).
- 서버가 다시 켜지면 실매매는 비활성으로 시작합니다. 화면에서 **활성화**를 눌러 주세요.
- BingX API 키에 이 서버의 IP만 허용하도록 설정하면 더 안전합니다.
