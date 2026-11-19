#!/usr/bin/env bash
# Signal Lab: private HTTPS address for the dashboard, visible only to devices signed in to your
# Tailscale account (phone, PC). Nothing is opened to the public internet. Run as root.
set -euo pipefail
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
tailscale status >/dev/null 2>&1 || { echo "아래 주소를 열어 Tailscale에 로그인하세요."; tailscale up; }
name=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).Self?.DNSName||"").replace(/\.$/,"")))')
[[ "$name" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Tailscale 이름을 읽지 못했습니다"; exit 1; }
env=/opt/signallab/data/.env
umask 077
[ -f "$env" ] || install -o signallab -g signallab -m 600 /dev/null "$env"
tmp=$(mktemp /opt/signallab/data/.env.tmp.XXXXXX)
trap 'rm -f "$tmp"' EXIT
awk -v key="ALLOWED_HOSTS" -v val="$name" '
  BEGIN { found=0 }
  $0 ~ "^" key "=" { print key "=" val; found=1; next }
  { print }
  END { if (!found) print key "=" val }
' "$env" > "$tmp"
chown signallab:signallab "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$env"
trap - EXIT
tailscale serve --bg 3000
systemctl restart signal-lab
echo; echo "휴대폰·PC에 Tailscale 앱을 설치하고 같은 계정으로 로그인한 뒤 열어 보세요:"; echo "  https://$name"
