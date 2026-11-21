#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
awk '/^cat > dist\/debian\/preinst << '\''EOF'\''$/ {inside=1;next} inside && /^EOF$/ {exit} inside {print}' "$repo/scripts/build/build-debian-package.sh" > "$work/preinst"
test -s "$work/preinst"
mkdir -p "$work/root/opt/ceralive"
printf '%s' '{"hw":"rk3588","srt_forward":{"host":"127.0.0.1","passphrase":"test-only-secret"}}' > "$work/root/opt/ceralive/setup.json"
CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
snapshot="$work/root/data/ceralive/srt-forward-legacy-setup.json"
cmp "$work/root/opt/ceralive/setup.json" "$snapshot"
test "$(stat -c %a "$snapshot")" = 600
printf '%s' '{"hw":"rk3588"}' > "$work/root/opt/ceralive/setup.json"
CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
grep -q 'test-only-secret' "$snapshot"
# Persistent operator state makes the package migration inert.
rm "$snapshot"
printf '{}' > "$work/root/data/ceralive/srt-forward.json"
CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
test ! -e "$snapshot"
grep -q -- '--before-install preinst' "$repo/scripts/build/build-debian-package.sh"
printf '%s\n' 'forward migration package contract passed'
