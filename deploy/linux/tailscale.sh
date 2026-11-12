#!/usr/bin/env bash
# Signal Lab: private HTTPS address for the dashboard, visible only to devices signed in to your
# Tailscale account (phone, PC). Nothing is opened to the public internet. Run as root.
set -euo pipefail
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
tailscale status >/dev/null 2>&1 || { echo "아래 주소를 열어 Tailscale에 로그인하세요."; tailscale up; }
name=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).Self?.DNSName||"").replace(/\.$/,"")))')
[ -n "$name" ] || { echo "Tailscale 이름을 읽지 못했습니다"; exit 1; }
env=/opt/signallab/data/.env
if grep -q '^ALLOWED_HOSTS=' $env; then sed -i "s/^ALLOWED_HOSTS=.*/ALLOWED_HOSTS=$name/" $env; else echo "ALLOWED_HOSTS=$name" >> $env; fi
tailscale serve --bg 3000
systemctl restart signal-lab
echo; echo "휴대폰·PC에 Tailscale 앱을 설치하고 같은 계정으로 로그인한 뒤 열어 보세요:"; echo "  https://$name"
