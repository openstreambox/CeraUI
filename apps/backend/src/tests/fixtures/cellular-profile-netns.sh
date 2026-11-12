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
if [[ -d /etc/netplan ]]; then mount -t tmpfs tmpfs /etc/netplan; fi
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
unmanaged_devices="*"
if [[ ${CELLULAR_HANDOFF_FIXTURE:-0} == 1 ]]; then unmanaged_devices="interface-name:lo"; fi
cat > "$fixture_root/nm.conf" <<CONF
[main]
plugins=keyfile
dns=none
rc-manager=unmanaged
hostname-mode=none
no-auto-default=*
[keyfile]
path=$fixture_root/profiles
unmanaged-devices=$unmanaged_devices
[connectivity]
enabled=false
[logging]
level=INFO
CONF
if [[ ${CELLULAR_HANDOFF_FIXTURE:-0} == 1 ]]; then
 ip link add cellular0 type veth peer name carrier0
 ip link set carrier0 up
 # No host udev daemon enters this namespace. Seed only this namespace's
 # virtual devices in its private /run before NM's initial enumeration.
 mkdir -p /run/udev/data
 for iface in cellular0 carrier0; do
  index=$(cat "/sys/class/net/$iface/ifindex")
  printf 'I:1\nE:ID_NET_DRIVER=veth\nE:ID_NET_MANAGED_BY=org.freedesktop.NetworkManager\nV:1\n' > "/run/udev/data/n$index"
 done
fi
NetworkManager --no-daemon --config="$fixture_root/nm.conf" --pid-file=/run/NetworkManager/fixture.pid > "$fixture_root/nm.log" 2>&1 &
nm_pid=$!
for attempt in {1..100}; do [[ $(nmcli -t -f RUNNING general 2>/dev/null || true) == running ]] && break; sleep .05; done
[[ $(nmcli -t -f RUNNING general) == running ]]
if [[ ${CELLULAR_HANDOFF_FIXTURE:-0} == 1 ]]; then
 nmcli networking on
 nmcli device set cellular0 managed yes
 for attempt in {1..100}; do
  [[ $(nmcli -g GENERAL.NM-MANAGED device show cellular0 2>/dev/null || true) == yes ]] && break
  sleep .05
 done
 [[ $(nmcli -g GENERAL.NM-MANAGED device show cellular0) == yes ]] || { nmcli -f all device show cellular0; NetworkManager --print-config --config="$fixture_root/nm.conf"; cat "$fixture_root/nm.log"; exit 1; }
else
nmcli con add type gsm ifname '*' con-name synthetic-carrier gsm.device-id 0000000000000000000000000000000000000000 gsm.sim-id 89000000000000000000 gsm.apn old.invalid gsm.auto-config yes ipv4.method auto ipv6.method ignore connection.autoconnect no >/dev/null
export CERALIVE_PROFILE_UUID
CERALIVE_PROFILE_UUID=$(nmcli -g connection.uuid con show synthetic-carrier)
fi
export CERALIVE_NM_PROFILE_CHILD=1
"${CELLULAR_BUN:?test runtime required}" test "$1"
[[ -z $(ip -4 route show default) && -z $(ip -6 route show default) ]]
