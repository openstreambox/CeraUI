#!/usr/bin/env bash
# Own every unit and process used here. Never signal a process by name.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
unit="ceraui-restart-contract-$$"
cleanup() {
  systemctl --user stop "$unit.service" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/bin"
cc -x c -o "$work/bin/srtla_send" - <<'C'
#include <unistd.h>
int main(void) { for (;;) pause(); }
C
wait_file() {
  for ((i=0;i<300;i++)); do
    [[ -f "$1" ]] && return 0
    sleep 0.1
  done
  journalctl --user -u "$unit" --no-pager -n 80
  return 1
}
for mode in restart kill; do
  unit="ceraui-restart-contract-$$-$mode"
  run="$work/$mode"
  mkdir "$run"
  systemd-run --user --unit="$unit" --collect -p UMask=0022 \
    -p WorkingDirectory="$root" -p KillMode=mixed -p TimeoutStopSec=2 -p Restart=on-failure \
    -p RestartSec=1 -E PATH="$work/bin:$PATH" \
    -E CERAUI_RESTART_CONTRACT_DIR="$run" \
    "$(command -v bun)" test apps/backend/src/tests/restart-adoption-service.test.ts
  wait_file "$run/ready"
  if [[ "$mode" == restart ]]; then
    systemctl --user restart "$unit"
  else
    systemctl --user kill --kill-whom=main --signal=SIGKILL "$unit"
  fi
  wait_file "$run/passed"
  systemctl --user stop "$unit" || true
  echo "$mode: passed"
done
