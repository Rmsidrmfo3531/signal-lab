#!/usr/bin/env bash
# Signal Lab: copy trading of a Telegram channel on the BingX TESTNET (user 2026-11-13).
# Run as root on the cloud server:  bash /opt/signallab/app/deploy/linux/copy.sh
# What it does: Python + Telethon in its own folder, your Telegram login (phone + code, typed here
# on the server, never sent to anyone else), a background listener service, and a restart.
set -euo pipefail
umask 077
BASE=/opt/signallab; APP=$BASE/app; DATA=$BASE/data; VENV=$BASE/copy-venv; ENVF=$DATA/.env
CHANNEL_DEFAULT="${COPY_CHANNEL_ID:--1003995199859}"
say(){ printf '\n== %s\n' "$*"; }
setenv(){ # key value: replace or add one line in .env safely without sed metacharacter expansion
  [ -f "$ENVF" ] || install -o signallab -g signallab -m 600 /dev/null "$ENVF"
  local tmp; tmp=$(mktemp "$DATA/.env.tmp.XXXXXX")
  ENV_KEY="$1" ENV_VAL="$2" awk '
    BEGIN { k=ENVIRON["ENV_KEY"]; v=ENVIRON["ENV_VAL"]; found=0 }
    index($0, k "=") == 1 { print k "=" v; found=1; next }
    { print }
    END { if (!found) print k "=" v }
  ' "$ENVF" > "$tmp"
  chown signallab:signallab "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENVF"
}

say "1/5 Python · Telethon 설치"
apt-get install -y -qq python3-venv >/dev/null
[ -d $VENV ] || python3 -m venv $VENV
$VENV/bin/pip install -q --upgrade pip telethon
chown -R signallab:signallab $VENV

say "2/5 텔레그램 API 키 (https://my.telegram.org → API development tools 에서 만든 값)"
[ -f "$ENVF" ] || install -o signallab -g signallab -m 600 /dev/null "$ENVF"
if ! grep -qE '^TELEGRAM_API_ID=[0-9]+' "$ENVF"; then
  read -r -p "api_id (숫자): " APIID; read -r -s -p "api_hash (입력은 화면에 보이지 않습니다): " APIHASH; echo
  setenv TELEGRAM_API_ID "$APIID"; setenv TELEGRAM_API_HASH "$APIHASH"
else echo "이미 설정됨 (바꾸려면 nano $ENVF)"; fi
grep -q '^COPY_CHANNEL_ID=' "$ENVF" || setenv COPY_CHANNEL_ID "$CHANNEL_DEFAULT"
grep -qE '^COPY_LISTENER_TOKEN=.{24,}' "$ENVF" || setenv COPY_LISTENER_TOKEN "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
chown signallab:signallab "$ENVF"; chmod 600 "$ENVF"

say "3/5 텔레그램 로그인 (휴대폰 번호 → 텔레그램 앱으로 온 코드 → 2단계 비밀번호가 있으면 입력)"
sudo -u signallab env SIGNAL_LAB_DATA_DIR=$DATA $VENV/bin/python $APP/deploy/linux/copy_listener.py --login
chmod 600 "$DATA"/copy.session* 2>/dev/null || true

say "4/5 수신 서비스 등록"
cat > /etc/systemd/system/signal-lab-copy.service <<UNIT
[Unit]
Description=Signal Lab copy-trading listener
After=network-online.target signal-lab.service
Wants=network-online.target
[Service]
User=signallab
UMask=0077
WorkingDirectory=$APP
Environment=SIGNAL_LAB_DATA_DIR=$DATA
ExecStart=$VENV/bin/python $APP/deploy/linux/copy_listener.py
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$BASE
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable signal-lab-copy >/dev/null

say "5/5 재시작"
systemctl restart signal-lab; sleep 3; systemctl restart signal-lab-copy
echo "설정 완료. 채널에 새 알림이 오면 테스트넷에서 1달러 증거금으로 따라갑니다."
echo "상태 확인: journalctl -u signal-lab-copy -n 20 --no-pager"
