#!/usr/bin/env bash
# Signal Lab: set up the daily results upload to the private repository signal-lab-reports.
# Run as root on the cloud server:  bash /opt/signallab/app/deploy/linux/reports.sh
# Makes a key that can write ONLY to signal-lab-reports (added there as a deploy key with write access).
set -euo pipefail
REPO="git@github.com:Rmsidrmfo3531/signal-lab-reports.git"; BASE=/opt/signallab; DIR=$BASE/reports; KEY=$BASE/.ssh/reports_ed25519
sudo -u signallab bash -c "[ -f $KEY ] || ssh-keygen -q -t ed25519 -N '' -C signal-lab-reports -f $KEY"
SSH="ssh -i $KEY -o IdentitiesOnly=yes"
until sudo -u signallab env GIT_SSH_COMMAND="$SSH" git ls-remote "$REPO" >/dev/null 2>&1; do
  echo; echo "아래 공개 키 한 줄을 계실장에게 보내 주세요 (공개 키라 안전합니다). 등록되면 Enter를 누르세요."
  echo; cat $KEY.pub; echo
  read -r -p "등록 확인 후 Enter... " _
done
[ -d $DIR/.git ] || sudo -u signallab env GIT_SSH_COMMAND="$SSH" git clone -q "$REPO" $DIR
systemctl restart signal-lab
echo "설정 완료. 서버가 매일 결과를 signal-lab-reports에 올립니다. 화면에서 활성화를 다시 눌러 주세요."
