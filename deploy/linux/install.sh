#!/usr/bin/env bash
# Signal Lab: install on a fresh Ubuntu 22.04/24.04 cloud server, run as root:
#   bash install.sh
# Safe to run again (each step skips what is already done).
# - Node.js 22, a 'signallab' user, the app from GitHub (read-only deploy key made on this server)
# - data and .env in /opt/signallab/data (never in the app folder, never in git)
# - systemd service: starts at boot, restarts if it stops
# - optional Tailscale: the dashboard only on your own devices, over HTTPS, never open to the internet
set -euo pipefail
REPO="git@github.com:Rmsidrmfo3531/signal-lab.git"
BASE=/opt/signallab; APP=$BASE/app; DATA=$BASE/data; SVC=signal-lab
say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "root로 실행하세요: sudo bash install.sh"; exit 1; }

say "1/6 기본 도구 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl ca-certificates openssh-client
timedatectl set-timezone Asia/Seoul 2>/dev/null || true

say "2/6 Node.js 22 설치"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "3/6 전용 사용자와 폴더"
id signallab >/dev/null 2>&1 || useradd --system --create-home --home-dir $BASE --shell /bin/bash signallab
mkdir -p $DATA && chown -R signallab:signallab $BASE && chmod 700 $DATA

say "4/6 GitHub에서 프로그램 받기 (읽기 전용 배포 키)"
sudo -u signallab bash -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh && [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C signal-lab-server -f ~/.ssh/id_ed25519"
sudo -u signallab bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
until sudo -u signallab git ls-remote "$REPO" >/dev/null 2>&1; do
  echo
  echo "아래 한 줄(공개 키)을 GitHub에 등록해 주세요. 비밀이 아닌 공개 키라 안전합니다."
  echo "  GitHub → signal-lab 저장소 → Settings → Deploy keys → Add deploy key"
  echo "  Title: signal-lab-server,  'Allow write access'는 체크하지 마세요."
  echo; cat $BASE/.ssh/id_ed25519.pub; echo
  read -r -p "등록했으면 Enter를 누르세요... " _
done
if [ -d $APP/.git ]; then sudo -u signallab git -C $APP pull --ff-only; else sudo -u signallab git clone --depth 50 "$REPO" $APP; fi

say "5/6 설정 파일(.env)"
if [ ! -f $DATA/.env ]; then
  cat > $DATA/.env <<'ENV'
# Signal Lab 설정 (이 파일은 이 서버에만 있습니다. 채팅·GitHub에 올리지 마세요)
# PC의 %LOCALAPPDATA%\SignalLab\.env 에 있는 값을 그대로 옮겨 적으면 됩니다.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BINGX_API_KEY=
BINGX_API_SECRET=
LIVE_TRADING_MODE=TESTNET
LIVE_VENUES=BINGX
PAPER_VENUES=BINGX
ALLOWED_HOSTS=
ENV
  chown signallab:signallab $DATA/.env; chmod 600 $DATA/.env
  echo "설정 파일을 만들었습니다: $DATA/.env  →  nano $DATA/.env 로 키를 입력하세요."
fi

say "6/6 자동 시작 서비스"
cat > /etc/systemd/system/$SVC.service <<UNIT
[Unit]
Description=Signal Lab
After=network-online.target
Wants=network-online.target
[Service]
User=signallab
WorkingDirectory=$APP
Environment=SIGNAL_LAB_DATA_DIR=$DATA
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$BASE
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable $SVC >/dev/null
if grep -qE '^BINGX_API_KEY=.+' $DATA/.env; then systemctl restart $SVC; echo "서버를 시작했습니다."; else echo "키를 입력한 뒤: systemctl restart $SVC"; fi

cat <<DONE

설치가 끝났습니다.
- 상태 확인:  systemctl status $SVC      기록 보기: journalctl -u $SVC -f
- 업데이트:   bash $APP/deploy/linux/update.sh
- 화면 보기:  bash $APP/deploy/linux/tailscale.sh  (휴대폰·PC에서만 보이는 비공개 주소)
서버가 다시 켜질 때마다 실매매는 '비활성' 상태로 시작합니다. 화면에서 활성화를 눌러 주세요.
DONE
