#!/usr/bin/env bash
# Run only against an exclusive, disposable systemd 257 container without polkit.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
container="${CERALIVE_LOGIND_TEST_CONTAINER:?Set the disposable container name}"
docker exec "$container" test -f /run/logind-contract-disposable
docker exec "$container" sh -c '/lib/systemd/systemd --version | head -1' | grep -Eq '^systemd 257 '
for target in reboot.target poweroff.target; do
  [[ "$(docker exec "$container" systemctl is-enabled "$target" 2>/dev/null || true)" == masked ]]
done
docker exec "$container" test ! -x /usr/lib/polkit-1/polkitd
docker exec "$container" mkdir -p /opt/logind-contract
for source in apps/backend/src/modules/system/logind-inhibitor.ts apps/backend/src/helpers/systemd-watchdog.ts; do
  docker exec -i "$container" tee "/opt/logind-contract/${source##*/}" < "$root/$source" >/dev/null
done
docker exec -i "$container" tee /opt/logind-contract/owner.ts < "$root/scripts/ci/fixtures/logind-owner.ts" >/dev/null
# Keep the shipped watchdog interval/signal/restart policy; replace only binary
# and working directory with the native helper fixture. Bun must be on PATH.
sed -e 's#^WorkingDirectory=.*#WorkingDirectory=/opt/logind-contract#' \
    -e 's#^ExecStart=.*#ExecStart=/usr/local/bin/bun /opt/logind-contract/owner.ts#' \
    "$root/deployment/ceralive.service" | docker exec -i "$container" tee /etc/systemd/system/ceralive.service >/dev/null
docker exec -i "$container" bash -s <<'INNER'
set -euo pipefail
systemctl daemon-reload
systemctl restart ceralive
systemd-inhibit --list --no-pager | grep -q CeraUI
cursor() { journalctl -u systemd-logind -n 0 --show-cursor --no-pager | sed -n 's/^-- cursor: //p'; }
logs() { journalctl -u systemd-logind --after-cursor="$1" --no-pager; }
mark="$(cursor)"
systemctl reboot >/opt/logind-contract/blocked.log 2>&1 && exit 1
! logs "$mark" | grep -q 'The system will reboot now'
echo 'ok 1 native CeraUI descriptor refuses root reboot'
mark="$(cursor)"
systemctl stop ceralive
systemctl reboot >/opt/logind-contract/override.log 2>&1 || true
logs "$mark" | grep -q 'The system will reboot now'
logs "$mark" | grep -q 'reboot.target is masked'
echo 'ok 2 supported stop-service override reaches the masked target'
# A stopped logind must not hold the main loop for seconds on each attempt.
pid="$(systemctl show systemd-logind -p MainPID --value)"
kill -STOP "$pid"
trap 'kill -CONT "$pid"' EXIT
/usr/local/bin/bun /opt/logind-contract/owner.ts probe
kill -CONT "$pid"
trap - EXIT
echo 'ok 3 unavailable logind acquisition is bounded below one second'
systemctl start ceralive
old="$(systemctl show ceralive -p MainPID --value)"
kill -STOP "$old"
# Shipped WatchdogSec=30s plus RestartSec=2s; no shortened test-only interval.
for ((i=0; i<45; i++)); do
  current="$(systemctl show ceralive -p MainPID --value)"
  if [[ "$current" != 0 && "$current" != "$old" ]] && systemctl is-active --quiet ceralive; then break; fi
  sleep 1
done
[[ "$current" != 0 && "$current" != "$old" ]]
! kill -0 "$old" 2>/dev/null
systemd-inhibit --list --no-pager | grep -q " $current "
systemctl show ceralive -p NRestarts | grep -Eq '=[1-9][0-9]*$'
echo 'ok 4 shipped watchdog kills hung owner, closes old lock and restarts'
systemctl stop ceralive
INNER
