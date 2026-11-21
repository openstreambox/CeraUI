#!/bin/bash
# Run only in a disposable container with its own PID/network namespaces,
# NET_ADMIN and SYS_ADMIN (for one client network namespace), no device
# passthrough, NetworkManager, dbus-daemon, busctl, nmcli, ip, nft, jq,
# curl, sha256sum, dnsmasq (NetworkManager's shared mode) and bun. Issues no
# radio, modem or hotspot command.
set -euo pipefail
umask 0022
[[ ${NM_CHECKPOINT_CONTRACT:-} == 1 ]] || { echo 'Requires an explicitly isolated test container' >&2; exit 2; }
[[ -f /.dockerenv ]] || { echo 'Requires a disposable container' >&2; exit 2; }
[[ ! -e /dev/rfkill ]] || { echo 'Refusing access to radio hardware' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Requires container root' >&2; exit 2; }
for device in /sys/class/net/*; do
    [[ $(basename "$device") == lo ]] || [[ $(readlink -f "$device") == /sys/devices/virtual/net/* ]] || { echo 'Refusing physical network devices' >&2; exit 2; }
done
here=$(cd "$(dirname "$0")" && pwd)
base=$(mktemp -d)
state=$(mktemp -d /var/tmp/network-change-contract.XXXXXX)
nmpid=''
buspid=''
srvpid=''
cleanup() {
    [[ -z $srvpid ]] || kill "$srvpid" 2>/dev/null || true
    [[ -z $nmpid ]] || kill "$nmpid" 2>/dev/null || true
    [[ -z $buspid ]] || kill "$buspid" 2>/dev/null || true
    wait || true
    ip netns del contract-client 2>/dev/null || true
    for link in checkpoint0 spare0 role0 lan0 wan0; do ip link delete "$link" 2>/dev/null || true; done
    nft delete table inet ceralive_ingress 2>/dev/null || true
    rm -rf "$base" "$state"
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
match-device=interface-name:checkpoint0;interface-name:spare0;interface-name:role0
managed=1
[connectivity]
enabled=false
CONF
ip link set lo up
for link in checkpoint0 spare0 role0; do ip link add "$link" type dummy; ip link set "$link" up; done
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$base/bus"
dbus-daemon --system --fork --nopidfile --address="$DBUS_SYSTEM_BUS_ADDRESS" --print-pid > "$base/bus.pid"
buspid=$(cat "$base/bus.pid")
start_nm() {
    NetworkManager --debug --no-daemon --config="$base/nm.conf" --pid-file="$base/nm.pid" --state-file="$base/nm.state" >> "$base/nm.log" 2>&1 &
    nmpid=$!
    for _ in {1..100}; do
        if busctl --system status org.freedesktop.NetworkManager >/dev/null 2>&1; then return; fi
        kill -0 "$nmpid" 2>/dev/null || { cat "$base/nm.log" >&2; return 1; }
        sleep .1
    done
    echo 'NetworkManager did not start' >&2
    return 1
}
stop_nm() {
    kill "$nmpid"
    wait "$nmpid" || true
    nmpid=''
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
addr() {
    nmcli -g ipv4.addresses con show "$1"
}
active_on() {
    nmcli -g GENERAL.CONNECTION device show "$1"
}
candidates() {
    nmcli -g NAME con show | grep -c '^ceralive-candidate-' || true
}
run_candidates() {
    grep -l 'ceralive-candidate-' /run/NetworkManager/system-connections/* 2>/dev/null | wc -l
}
drv() {
    (cd /var/tmp && NM_CHECKPOINT_CONTRACT=1 CONTRACT_STATE="$state" bun "$here/network-change-contract.ts" "$@")
}
passed=0
pass() {
    echo "PASS $1"
    passed=$((passed + 1))
}
boundary() {
    echo "BOUNDARY $1"
}

start_nm
nmcli connection add type dummy ifname checkpoint0 con-name checkpoint-active ipv4.method manual ipv4.addresses 192.0.2.1/24 ipv6.method disabled >/dev/null
nmcli connection up checkpoint-active >/dev/null

# --- Stock NetworkManager facts the design is built on ----------------------
before=$(profile_hashes)
checkpoint >/dev/null
nmcli connection modify --temporary checkpoint-active ipv4.addresses 192.0.2.2/24
nmcli device reapply checkpoint0 >/dev/null
[[ $(addr checkpoint-active) == 192.0.2.2/24 ]]
[[ $(profile_hashes) == "$before" ]]
sleep 4
[[ $(addr checkpoint-active) == 192.0.2.1/24 ]]
[[ $(profile_hashes) == "$before" ]]
pass 'stock: active edit rolls back with unchanged profile files'

nmcli connection add type dummy ifname spare0 con-name checkpoint-probe connection.autoconnect no ipv4.method manual ipv4.addresses 198.51.100.1/24 ipv6.method disabled >/dev/null
checkpoint >/dev/null
nmcli connection modify --temporary checkpoint-probe ipv4.addresses 198.51.100.2/24
sleep 4
[[ $(addr checkpoint-probe) == 198.51.100.2/24 ]]
boundary 'an inactive profile edited in memory is not restored on checkpoint expiry'
stop_nm
start_nm
[[ $(addr checkpoint-probe) == 198.51.100.2/24 ]]
boundary 'an in-memory edit survives a NetworkManager restart (runtime keyfile in /run); the checkpoint does not'
nmcli connection delete checkpoint-probe >/dev/null

checkpoint >/dev/null
nmcli connection add save no type dummy ifname spare0 con-name checkpoint-candidate connection.autoconnect no ipv4.method manual ipv4.addresses 203.0.113.1/24 ipv6.method disabled >/dev/null
sleep 4
if nmcli con show checkpoint-candidate >/dev/null 2>&1; then echo 'Candidate was not deleted by rollback' >&2; exit 1; fi
boundary 'with DELETE_NEW_CONNECTIONS (not used by the owner), rollback deletes new profiles on devices outside the checkpoint too'

# --- The owner: candidates, journal, recorded undo -------------------------
for _ in 1 2; do
    nmcli connection add type dummy ifname spare0 con-name checkpoint-dormant connection.autoconnect no ipv4.method manual ipv4.addresses 198.51.100.1/24 ipv6.method disabled >/dev/null
done
before=$(profile_hashes)
list_before=$(nmcli -g UUID con show | sort)

result=$(drv apply active checkpoint0)
[[ $(jq -r .kind <<<"$result") == ask-before && $(jq -r .via <<<"$result") == checkpoint0 ]]
[[ $(jq -r '[.primary.answer, .deliberate.answer, has("preselected")] | @tsv' <<<"$result") == $'undo-automatically\tkeep-change\tfalse' ]]
[[ $(nmcli -g UUID con show | sort) == "$list_before" && $(busctl --system get-property org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager Checkpoints) == 'ao 0' ]]
result=$(drv apply active -)
[[ $(jq -r .kind <<<"$result") == ask-before && $(jq -r .via <<<"$result") == null ]]
pass 'ask before: own or unknown path returns the prompt, with nothing preselected, and changes nothing'

result=$(drv apply dormant checkpoint0)
[[ $(jq -r .kind <<<"$result") == pending ]]
[[ $(candidates) == 2 && $(run_candidates) == 2 && $(profile_hashes) == "$before" ]]
for uuid in $(nmcli -t -f UUID,NAME con show | awk -F: '$2 == "checkpoint-dormant" { print $1 }'); do [[ $(addr "$uuid") == 198.51.100.1/24 ]]; done
sleep 4
drv tick >/dev/null
[[ $(candidates) == 0 && $(run_candidates) == 0 && $(profile_hashes) == "$before" ]]
[[ $(nmcli -g NAME con show | grep -c '^checkpoint-dormant$') == 2 ]]
notice=$(drv status | jq -r .notice.id)
[[ $notice != null && $(drv status | jq -r .notice.reason) == disconnected ]]
pass 'candidates: dormant duplicates edited only as candidates; expiry leaves the originals untouched'
drv leave "$notice" >/dev/null
[[ $(drv status | jq -r .notice) == null ]]
pass 'ask after: the notice is stored once and cleared for everyone by one answer'

result=$(drv apply dormant checkpoint0)
drv apply dormant checkpoint0 >/dev/null 2>&1 && { echo 'Overlapping change accepted' >&2; exit 1; }
stop_nm
start_nm
[[ $(candidates) == 2 ]]
boundary 'dormant candidates are reloaded from /run after a NetworkManager restart'
[[ $(drv reconcile network-restart) == '"undone"' ]]
[[ $(candidates) == 0 && $(run_candidates) == 0 && $(profile_hashes) == "$before" ]]
[[ $(drv status | jq -r .notice.reason) == restart ]]
pass 'restart: NetworkManager restart leaves no orphaned dormant candidate'
drv leave "$(drv status | jq -r .notice.id)" >/dev/null

result=$(drv apply dormant checkpoint0)
# Another path: the creator's still-working connection confirms it.
[[ $(drv confirm "$(jq -r .id <<<"$result")" creator checkpoint0) == '"confirmed"' ]]
[[ $(candidates) == 0 && $(run_candidates) == 0 ]]
dormant=$(nmcli -t -f UUID,NAME con show | awk -F: '$2 == "checkpoint-dormant" { print $1 }')
[[ $(wc -w <<<"$dormant") == 2 ]]
for uuid in $dormant; do
    [[ $(addr "$uuid") == 198.51.100.9/24 && $(nmcli -g connection.autoconnect con show "$uuid") == no ]]
    grep -q "$uuid" /etc/NetworkManager/system-connections/*
done
sleep 4
for uuid in $dormant; do [[ $(addr "$uuid") == 198.51.100.9/24 ]]; done
before=$(profile_hashes)
pass 'candidates: confirmation promotes both duplicates to disk under their name and autoconnect'

old_active=$(addr checkpoint-active)
result=$(drv apply effects checkpoint0 undo-automatically)
[[ $(jq -r .kind <<<"$result") == pending ]]
[[ $(active_on checkpoint0) == ceralive-candidate-* && $(ip -4 -br addr show checkpoint0) == *192.0.2.9/24* ]]
[[ $(drv effects) == '{"interfaces":[],"radio":{"modem0":"4g"}}' ]]
stop_nm
start_nm
sleep 1
[[ $(active_on checkpoint0) == ceralive-candidate-* ]]
boundary 'an active candidate is still active after a NetworkManager restart, with no checkpoint'
[[ $(drv reconcile network-restart) == '"undone"' ]]
[[ $(active_on checkpoint0) == checkpoint-active && $(addr checkpoint-active) == "$old_active" ]]
[[ $(ip -4 -br addr show checkpoint0) == *"$old_active"* ]]
[[ $(candidates) == 0 && $(run_candidates) == 0 && $(profile_hashes) == "$before" ]]
[[ $(drv effects) == '{"interfaces":["ap0"],"radio":{"modem0":"4g|5g"}}' ]]
pass 'restart and effects: NetworkManager restart: original active again, no /run candidate, hotspot and radio undo replayed'

result=$(drv apply effects checkpoint0 undo-automatically)
sleep 4
drv tick >/dev/null
[[ $(active_on checkpoint0) == checkpoint-active && $(addr checkpoint-active) == "$old_active" ]]
[[ $(drv effects) == '{"interfaces":["ap0"],"radio":{"modem0":"4g|5g"}}' && $(candidates) == 0 ]]
pass 'effects: timeout replays the recorded undos after the checkpoint rollback'

result=$(drv apply effects checkpoint0 undo-automatically)
stop_nm
# A reboot clears /run; the journal and the effect state are on persistent storage.
find /run/NetworkManager -mindepth 1 -delete
start_nm
sleep 1
[[ $(CONTRACT_BOOT_ID=contract-second-boot drv reconcile boot) == '"undone"' ]]
[[ $(candidates) == 0 && $(addr checkpoint-active) == "$old_active" && $(profile_hashes) == "$before" ]]
[[ $(drv effects) == '{"interfaces":["ap0"],"radio":{"modem0":"4g|5g"}}' ]]
[[ $(drv status | jq -r .notice.reason) == restart ]]
pass 'restart and effects: reboot: originals from disk, recorded undos replayed, the ask-after notice kept'
drv leave "$(drv status | jq -r .notice.id)" >/dev/null
nmcli connection up checkpoint-active >/dev/null 2>&1 || true

result=$(drv apply active checkpoint0 undo-automatically)
id=$(jq -r .id <<<"$result")
drv confirm "$id" creator checkpoint0 >/dev/null 2>&1 && { echo 'Creator session confirmed its own-path change' >&2; exit 1; }
drv confirm "$id" laptop spare0 >/dev/null 2>&1 && { echo 'Another path confirmed an own-path change' >&2; exit 1; }
drv confirm "$id" reconnected - >/dev/null 2>&1 && { echo 'Unknown arrival confirmed a change' >&2; exit 1; }
[[ $(drv confirm "$id" reconnected checkpoint0) == '"confirmed"' ]]
sleep 4
[[ $(active_on checkpoint0) == checkpoint-active && $(addr checkpoint-active) == 192.0.2.9/24 ]]
[[ $(candidates) == 0 && $(run_candidates) == 0 ]]
grep -q '192.0.2.9/24' /etc/NetworkManager/system-connections/*
stop_nm
start_nm
sleep 1
[[ $(active_on checkpoint0) == checkpoint-active && $(addr checkpoint-active) == 192.0.2.9/24 ]]
pass 'confirmation from a new session over the changed interface promotes the candidate to disk, without reactivation'

settings() {
    nmcli -t -f connection.uuid,connection.id,connection.autoconnect,ipv4.method,ipv4.addresses,ipv6.method con show checkpoint-active
}
before=$(settings)
result=$(CONTRACT_ADDRESS=192.0.2.10/24 drv apply effects checkpoint0 keep-change)
[[ $(jq -r .kind <<<"$result") == kept && $(ip -4 -br addr show checkpoint0) == *192.0.2.10/24* ]]
[[ $(busctl --system get-property org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager Checkpoints) == 'ao 0' ]]
sleep 4
drv tick >/dev/null
stop_nm
start_nm
sleep 1
[[ $(drv reconcile network-restart) == '"kept"' && $(addr checkpoint-active) == 192.0.2.10/24 ]]
[[ $(active_on checkpoint0) == checkpoint-active ]]
[[ $(drv effects) == '{"interfaces":[],"radio":{"modem0":"4g"}}' ]]
[[ $(drv status | jq -r .kept.id) == "$(jq -r .id <<<"$result")" ]]
pass 'deliberate "don'\''t undo it": no auto-undo across the deadline and a restart'
drv undo-kept "$(jq -r .id <<<"$result")" spare0 >/dev/null
[[ $(addr checkpoint-active) == 192.0.2.9/24 && $(active_on checkpoint0) == checkpoint-active ]]
# Same UUID and settings; renaming back rewrites the keyfile, so bytes may differ.
[[ $(nmcli -g NAME con show | grep -c '^ceralive-') == 0 && $(settings) == "$before" ]]
[[ $(drv effects) == '{"interfaces":["ap0"],"radio":{"modem0":"4g|5g"}}' ]]
pass 'deliberate "don'\''t undo it": the recorded undo restores profiles and effects from another connection'

# --- Ethernet role wiring: uplink to shared LAN on the session's own port ---
# role0 stands in for a wired uplink (a manual address: a dummy link has no DHCP).
nmcli connection add type dummy ifname role0 con-name checkpoint-wired ipv4.method manual ipv4.addresses 192.0.2.50/24 ipv6.method disabled >/dev/null
nmcli connection up checkpoint-wired >/dev/null
method() {
    nmcli -g ipv4.method con show "$1"
}
before=$(profile_hashes)
result=$(drv apply ethrole role0)
[[ $(jq -r .kind <<<"$result") == ask-before && $(jq -r .via <<<"$result") == role0 ]]
[[ $(active_on role0) == checkpoint-wired && $(method checkpoint-wired) == manual ]]
result=$(drv apply ethrole role0 undo-automatically)
[[ $(jq -r .kind <<<"$result") == pending ]]
candidate=$(active_on role0)
[[ $candidate == ceralive-candidate-* && $(method "$candidate") == shared ]]
[[ $(method checkpoint-wired) == manual && $(profile_hashes) == "$before" ]]
# Someone joins another network during the window; the rollback must keep it.
nmcli connection add save no type dummy ifname spare0 con-name window-joined connection.autoconnect no ipv4.method manual ipv4.addresses 203.0.113.7/24 ipv6.method disabled >/dev/null
sleep 4
drv tick >/dev/null
[[ $(active_on role0) == checkpoint-wired && $(method checkpoint-wired) == manual ]]
[[ $(candidates) == 0 && $(run_candidates) == 0 && $(profile_hashes) == "$before" ]]
[[ $(drv status | jq -r .notice.reason) == disconnected ]]
pass 'Ethernet role: an unconfirmed switch to shared LAN is undone, profile files unchanged'
nmcli con show window-joined >/dev/null
nmcli connection delete window-joined >/dev/null
pass 'rollback keeps a profile created elsewhere during the window'
drv leave "$(drv status | jq -r .notice.id)" >/dev/null

result=$(drv apply ethrole role0 undo-automatically)
id=$(jq -r .id <<<"$result")
drv confirm "$id" creator role0 >/dev/null 2>&1 && { echo 'Creator session confirmed its own-port role change' >&2; exit 1; }
drv confirm "$id" reconnected - >/dev/null 2>&1 && { echo 'Unknown arrival confirmed a role change' >&2; exit 1; }
[[ $(drv confirm "$id" reconnected role0) == '"confirmed"' ]]
sleep 4
[[ $(active_on role0) == checkpoint-wired && $(method checkpoint-wired) == shared ]]
grep -q 'method=shared' "$(grep -l 'id=checkpoint-wired' /etc/NetworkManager/system-connections/*)"
stop_nm
start_nm
sleep 1
[[ $(method checkpoint-wired) == shared && $(candidates) == 0 ]]
pass 'Ethernet role: confirmation from a new session over the port writes shared LAN to disk'

# --- Trusted arrival interface ---------------------------------------------
drv_nft() { (cd /var/tmp && bun -e "import { ingressRuleset } from '$here/../../apps/backend/src/modules/network/network-ingress.ts'; process.stdout.write(ingressRuleset([8080]));"); }
drv_nft | nft -f -
ip netns add contract-client
ip link add lan0 type veth peer name c-lan netns contract-client
ip link add wan0 type veth peer name c-wan netns contract-client
ip addr add 10.10.1.1/24 dev lan0
ip addr add 10.10.2.1/24 dev wan0
ip link set lan0 up
ip link set wan0 up
ip -n contract-client addr add 10.10.1.2/24 dev c-lan
ip -n contract-client addr add 10.10.2.2/24 dev c-wan
ip -n contract-client link set lo up
ip -n contract-client link set c-lan up
ip -n contract-client link set c-wan up
drv ingress-server 8080 30 > "$base/ingress.log" 2>&1 &
srvpid=$!
for _ in {1..50}; do grep -q listening "$base/ingress.log" && break; sleep .1; done
# wan0's address, routed over the lan link: the destination says wan0, the kernel says lan0.
ip -n contract-client route add 10.10.2.1/32 via 10.10.1.1 dev c-lan
via=$(ip netns exec contract-client curl -fsS --max-time 5 http://10.10.2.1:8080/)
[[ $(jq -r .via <<<"$via") == lan0 && $(jq -r .destination <<<"$via") == 10.10.2.1 ]]
ip -n contract-client route del 10.10.2.1/32
via=$(ip netns exec contract-client curl -fsS --max-time 5 http://10.10.2.1:8080/)
[[ $(jq -r .via <<<"$via") == wan0 ]]
pass 'arrival interface: taken from the kernel record, not the destination address'
kill "$srvpid" 2>/dev/null || true
wait "$srvpid" 2>/dev/null || true
srvpid=''

printf '%s passed; 0 failed\n' "$passed"
