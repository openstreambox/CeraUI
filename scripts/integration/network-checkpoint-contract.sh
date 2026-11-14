#!/bin/bash
# Run only in a disposable container with its own PID/network namespaces,
# NET_ADMIN, NetworkManager, dbus-daemon, busctl, nmcli, ip and sha256sum.
set -euo pipefail
umask 0022
[[ ${NM_CHECKPOINT_CONTRACT:-} == 1 ]] || { echo 'Requires an explicitly isolated test container' >&2; exit 2; }
[[ -f /.dockerenv ]] || { echo 'Requires a disposable container' >&2; exit 2; }
[[ ! -e /dev/rfkill ]] || { echo 'Refusing access to radio hardware' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Requires container root' >&2; exit 2; }
for device in /sys/class/net/*; do
    [[ $(basename "$device") == lo ]] || [[ $(readlink -f "$device") == /sys/devices/virtual/net/* ]] || { echo 'Refusing physical network devices' >&2; exit 2; }
done
base=$(mktemp -d)
nmpid=''
buspid=''
cleanup() {
    [[ -z $nmpid ]] || kill "$nmpid" 2>/dev/null || true
    [[ -z $buspid ]] || kill "$buspid" 2>/dev/null || true
    wait || true
    ip link delete checkpoint0 2>/dev/null || true
    rm -rf "$base"
}
trap cleanup EXIT
mkdir -p /run/dbus /etc/NetworkManager/conf.d
cat > "$base/nm.conf" <<'CONF'
[main]
plugins=keyfile
no-auto-default=*
dhcp=internal
dns=none
rc-manager=unmanaged
[device]
match-device=interface-name:checkpoint0
managed=1
[connectivity]
enabled=false
CONF
ip link set lo up
ip link add checkpoint0 type dummy
ip link set checkpoint0 up
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$base/bus"
dbus-daemon --system --fork --nopidfile --address="$DBUS_SYSTEM_BUS_ADDRESS" --print-pid > "$base/bus.pid"
buspid=$(cat "$base/bus.pid")
start_nm() {
    NetworkManager --debug --no-daemon --config="$base/nm.conf" --pid-file="$base/nm.pid" --state-file="$base/nm.state" > "$base/nm.log" 2>&1 &
    nmpid=$!
    for _ in {1..100}; do
        if busctl --system status org.freedesktop.NetworkManager >/dev/null 2>&1; then return; fi
        kill -0 "$nmpid" 2>/dev/null || { cat "$base/nm.log" >&2; return 1; }
        sleep .1
    done
    echo 'NetworkManager did not start' >&2
    return 1
}
manager() {
    busctl --system call org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager "$@"
}
checkpoint() {
    manager CheckpointCreate aouu 0 2 2 | cut -d '"' -f2
}
profile_hashes() {
    find /etc/NetworkManager/system-connections -type f -exec sha256sum '{}' + | sort
}
start_nm
for name in checkpoint-active checkpoint-dormant checkpoint-candidate; do
    if nmcli connection show "$name" >/dev/null 2>&1; then nmcli connection delete "$name" >/dev/null; fi
done
nmcli connection add type dummy ifname checkpoint0 con-name checkpoint-active ipv4.method manual ipv4.addresses 192.0.2.1/24 ipv6.method disabled >/dev/null
nmcli connection up checkpoint-active >/dev/null
before=$(profile_hashes)
checkpoint >/dev/null
nmcli connection modify --temporary checkpoint-active ipv4.addresses 192.0.2.2/24
nmcli device reapply checkpoint0 >/dev/null
[[ $(nmcli -g ipv4.addresses con show checkpoint-active) == 192.0.2.2/24 ]]
[[ $(profile_hashes) == "$before" ]]
sleep 4
[[ $(nmcli -g ipv4.addresses con show checkpoint-active) == 192.0.2.1/24 ]]
[[ $(profile_hashes) == "$before" ]]
echo 'PASS active edit rolls back with unchanged profile files'

confirmed=$(checkpoint)
nmcli connection modify --temporary checkpoint-active ipv4.addresses 192.0.2.3/24
nmcli device reapply checkpoint0 >/dev/null
manager CheckpointDestroy o "$confirmed" >/dev/null
connection_uuid=$(nmcli -g connection.uuid con show checkpoint-active)
connection_path=$(busctl --system call org.freedesktop.NetworkManager /org/freedesktop/NetworkManager/Settings org.freedesktop.NetworkManager.Settings GetConnectionByUuid s "$connection_uuid" | cut -d '"' -f2)
busctl --system call org.freedesktop.NetworkManager "$connection_path" org.freedesktop.NetworkManager.Settings.Connection Save >/dev/null
sleep 4
[[ $(nmcli -g ipv4.addresses con show checkpoint-active) == 192.0.2.3/24 ]]
echo 'PASS confirmed profile survives the rollback deadline'

# Record the boundary of the stock mechanism rather than silently assume that
# a device checkpoint snapshots every profile belonging to that device.
nmcli connection add type dummy ifname checkpoint0 con-name checkpoint-dormant connection.autoconnect no ipv4.method manual ipv4.addresses 198.51.100.1/24 ipv6.method disabled >/dev/null
before=$(profile_hashes)
checkpoint >/dev/null
nmcli connection modify --temporary checkpoint-dormant ipv4.addresses 198.51.100.2/24
sleep 4
[[ $(busctl --system get-property org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager Checkpoints) == 'ao 0' ]]
[[ $(nmcli -g ipv4.addresses con show checkpoint-dormant) == 198.51.100.2/24 ]]
[[ $(profile_hashes) == "$before" ]]
echo 'PASS boundary: inactive edit survives device-checkpoint expiry in memory'

kill "$nmpid"
wait "$nmpid" || true
nmpid=''
start_nm
failures=0
if [[ $(nmcli -g ipv4.addresses con show checkpoint-dormant) == 198.51.100.1/24 ]]; then
    echo 'PASS daemon restart loads the unchanged dormant profile from disk'
else
    echo 'FAIL daemon restart retained the unconfirmed dormant candidate from /run'
    failures=$((failures + 1))
fi

checkpoint >/dev/null
nmcli connection add save no type dummy ifname checkpoint0 con-name checkpoint-candidate connection.autoconnect no ipv4.method manual ipv4.addresses 203.0.113.1/24 ipv6.method disabled >/dev/null
sleep 4
if nmcli con show checkpoint-candidate >/dev/null 2>&1; then echo 'Candidate was not deleted by rollback' >&2; exit 1; fi
echo 'PASS rollback deletes newly added in-memory candidate profiles'

checkpoint >/dev/null
nmcli connection modify --temporary checkpoint-active ipv4.addresses 192.0.2.4/24
nmcli device reapply checkpoint0 >/dev/null
kill "$nmpid"
wait "$nmpid" || true
nmpid=''
start_nm
if [[ $(nmcli -g ipv4.addresses con show checkpoint-active) == 192.0.2.3/24 ]]; then
    echo 'PASS daemon restart discards the pending active candidate'
else
    echo 'FAIL daemon restart retained the unconfirmed active candidate from /run'
    failures=$((failures + 1))
fi

printf '%s passed; %s failed\n' "$((6 - failures))" "$failures"
[[ $failures == 0 ]]
