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
# No forwarding configuration: do not even create a migration directory.
rm -rf "$work/root/data"
CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
test ! -e "$work/root/data"
# A stale snapshot is removed even on a box without forwarding.
mkdir -p "$work/root/data/ceralive"
printf 'stale credential' > "$snapshot"
printf '{}' > "$work/root/data/ceralive/srt-forward.json"
CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
test ! -e "$snapshot"
rm "$work/root/data/ceralive/srt-forward.json"
printf '%s' '{"srt_forward":{"host":"127.0.0.1"}}' > "$work/root/opt/ceralive/setup.json"
# Every snapshot I/O failure must be non-fatal, and temporary bytes cleaned.
mkdir -p "$work/bin"
for operation in mkdir mktemp cat sync mv; do
    printf '#!/bin/bash\nexit 1\n' > "$work/bin/$operation"
    chmod +x "$work/bin/$operation"
    PATH="$work/bin:$PATH" CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root" bash "$work/preinst" upgrade
    test -z "$(find "$work/root/data/ceralive" -name '.srt-forward-legacy-setup.*' -print)"
    rm "$work/bin/$operation"
    rm -f "$snapshot"
done
printf '%s\n' 'forward migration package contract passed'
