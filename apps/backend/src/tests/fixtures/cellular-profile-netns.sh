#!/bin/bash
set -euo pipefail
[[ $(readlink /proc/self/ns/net) != "${CELLULAR_HOST_NETNS:?private network namespace required}" ]]
[[ $(readlink /proc/self/ns/mnt) != "${CELLULAR_HOST_MNTNS:?private mount namespace required}" ]]
mount --make-rprivate /
mount -t sysfs sysfs /sys
[[ $(ls /sys/class/net | wc -l) -eq 1 && -e /sys/class/net/lo ]]
mount -t tmpfs tmpfs /run
mount -t tmpfs tmpfs /var/lib/NetworkManager
mount -t tmpfs tmpfs /etc/NetworkManager
# rfkill is not network-namespaced; prevent any daemon access to host radios.
if [[ -e /dev/rfkill ]]; then mount --bind /dev/null /dev/rfkill; fi
fixture_root=/run/cellular-profile-fixture
mkdir -p "$fixture_root/profiles" /run/dbus /run/NetworkManager
bus_pid=
nm_pid=
cleanup() {
 if [[ -n "$nm_pid" ]]; then kill "$nm_pid" 2>/dev/null || true; wait "$nm_pid" 2>/dev/null || true; fi
 if [[ -n "$bus_pid" ]]; then kill "$bus_pid" 2>/dev/null || true; wait "$bus_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
cat > "$fixture_root/bus.conf" <<'BUS'
<busconfig><type>system</type><listen>unix:path=/run/dbus/system_bus_socket</listen><policy context="default"><allow user="*"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>
BUS
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
dbus-daemon --config-file="$fixture_root/bus.conf" --nofork > "$fixture_root/bus.log" 2>&1 &
bus_pid=$!
for attempt in {1..100}; do [[ -S /run/dbus/system_bus_socket ]] && break; sleep .05; done
cat > "$fixture_root/nm.conf" <<CONF
[main]
plugins=keyfile
dns=none
rc-manager=unmanaged
hostname-mode=none
[keyfile]
path=$fixture_root/profiles
unmanaged-devices=*
[connectivity]
enabled=false
[logging]
level=ERR
CONF
NetworkManager --no-daemon --config="$fixture_root/nm.conf" --pid-file=/run/NetworkManager/fixture.pid > "$fixture_root/nm.log" 2>&1 &
nm_pid=$!
for attempt in {1..100}; do [[ $(nmcli -t -f RUNNING general 2>/dev/null || true) == running ]] && break; sleep .05; done
[[ $(nmcli -t -f RUNNING general) == running ]]
nmcli con add type gsm ifname '*' con-name synthetic-carrier gsm.device-id 0000000000000000000000000000000000000000 gsm.sim-id 89000000000000000000 gsm.apn old.invalid gsm.auto-config yes ipv4.method auto ipv6.method ignore connection.autoconnect no >/dev/null
export CERALIVE_PROFILE_UUID
CERALIVE_PROFILE_UUID=$(nmcli -g connection.uuid con show synthetic-carrier)
export CERALIVE_NM_PROFILE_CHILD=1
"${CELLULAR_BUN:?test runtime required}" test "$1"
[[ -z $(ip -4 route show default) && -z $(ip -6 route show default) ]]
