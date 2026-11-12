#!/usr/bin/env bash
# Signal Lab: get the latest version from GitHub and restart (run as root).
set -euo pipefail
APP=/opt/signallab/app
before=$(sudo -u signallab git -C $APP rev-parse --short HEAD)
sudo -u signallab git -C $APP pull --ff-only
after=$(sudo -u signallab git -C $APP rev-parse --short HEAD)
[ "$before" = "$after" ] && { echo "이미 최신 버전입니다 ($after)."; exit 0; }
node --check $APP/server.mjs
systemctl restart signal-lab
sleep 3; systemctl is-active --quiet signal-lab && echo "업데이트 완료: $before → $after. 화면에서 활성화를 다시 눌러 주세요." || { echo "서버가 시작되지 않았습니다: journalctl -u signal-lab -n 50"; exit 1; }
