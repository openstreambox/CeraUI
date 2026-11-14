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

# The failure handler must survive failure of its own diagnostic output.
printf '#!/bin/bash\nexit 1\n' > "$work/bin/mkdir"
chmod +x "$work/bin/mkdir"
export PATH="$work/bin:$PATH" CERALIVE_FORWARD_MIGRATION_TEST_ROOT="$work/root"
python3 - "$work/preinst" <<'PYTEST'
import os
import subprocess
import sys

failures = []
for name in ("full", "closed", "broken-pipe"):
    if name == "full":
        fd = os.open("/dev/full", os.O_WRONLY)
        result = subprocess.run(["bash", sys.argv[1], "upgrade"], stderr=fd)
    elif name == "closed":
        result = subprocess.run(["bash", "-c", 'exec 2>&-; exec bash "$1" upgrade', "test", sys.argv[1]])
        fd = None
    else:
        read_fd, fd = os.pipe()
        os.close(read_fd)
        result = subprocess.run(["bash", sys.argv[1], "upgrade"], stderr=fd)
    if fd is not None:
        os.close(fd)
    print(f"snapshot failure with stderr {name}: rc {result.returncode}", flush=True)
    if result.returncode != 0:
        failures.append(name)
assert not failures, failures
PYTEST
rm "$work/bin/mkdir"
# A directory sync failure occurs after publication, so report that precisely.
printf '#!/bin/bash\n[[ "$2" != */ceralive ]]\n' > "$work/bin/sync"
chmod +x "$work/bin/sync"
bash "$work/preinst" upgrade 2> "$work/diagnostic"
test -f "$snapshot"
grep -q 'snapshot saved but directory sync failed' "$work/diagnostic"
! grep -q 'snapshot unavailable' "$work/diagnostic"
printf '%s\n' 'forward migration package contract passed'
