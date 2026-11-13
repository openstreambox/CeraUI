#!/bin/bash
# Called only inside a private mount/network namespace.
set -euo pipefail
# Fail before any mutation if invoked without the test launcher containment.
parent_net=${3:-}
parent_mnt=${4:-}
if [ -z "$parent_net" ] || [ -z "$parent_mnt" ]; then
 echo 'Requires private network and mount namespaces' >&2
 exit 1
fi
if [ "$(readlink /proc/self/ns/net)" = "$parent_net" ] ||
   [ "$(readlink /proc/self/ns/mnt)" = "$parent_mnt" ]; then
 echo 'Requires private network and mount namespaces' >&2
 exit 1
fi
mount --make-rprivate /
mount -t tmpfs tmpfs /run
mkdir -p /run/netns
cd /run
for n in phone guest receiver; do ip netns add "$n"; done
ip link set lo up
ip link add ap0 type bridge
ip addr add 192.0.2.1/24 dev ap0
ip link set ap0 up
for pair in 'phone 2' 'guest 3'; do
 read -r n addr <<< "$pair"
 ip link add "p-$n" type veth peer name eth0 netns "$n"
 ip link set "p-$n" master ap0
 ip link set "p-$n" up
 ip -n "$n" link set lo up
 ip -n "$n" addr add "192.0.2.$addr/24" dev eth0
 ip -n "$n" link set eth0 up
 ip -n "$n" route add default via 192.0.2.1
done
ip link add wan0 type veth peer name eth0 netns receiver
ip addr add 198.51.100.1/24 dev wan0
ip link set wan0 up
ip -n receiver addr add 198.51.100.2/24 dev eth0
ip -n receiver link set eth0 up
ip -n receiver route add default via 198.51.100.1
sysctl -qw net.ipv4.ip_forward=1
nft 'add table inet unrelated'
probe() { ip netns exec "$1" ping -n -c 1 -W 1 198.51.100.2 >/dev/null; }
probe phone
probe guest
# Keep the actual owner alive, then kill it after checking its initial lease.
bun "$1" hold "$2" & owner=$!
trap 'kill "$owner" 2>/dev/null || true; wait || true' EXIT
for _attempt in {1..100}; do [ -e "$2" ] && break; sleep 0.02; done
[ -e "$2" ]
probe phone
if probe guest; then echo 'guest was not paused' >&2; exit 1; fi
ip netns exec guest ping -n -c 1 -W 1 192.0.2.1 >/dev/null
# Reverse forwarding is also paused, but local output is outside the hook.
ip netns exec receiver ping -n -c 1 -W 1 192.0.2.2 >/dev/null
if ip netns exec receiver ping -n -c 1 -W 1 192.0.2.3 >/dev/null; then exit 1; fi
ping -n -c 1 -W 1 192.0.2.3 >/dev/null
# Kill the actual process that installed the still-current lease.
kill -KILL "$owner"
wait "$owner" || true
sleep 6
probe phone
probe guest
bun "$1" apply
if probe guest; then exit 1; fi
bun "$1" clear
probe guest
# A new owner clears retained state on restart before accepting work.
bun "$1" apply
bun "$1" clear
probe guest
nft list table inet unrelated >/dev/null
# The native inventory path must refuse a foreign table with our reserved name.
nft delete table inet ceralive_heat_client
nft 'add table inet ceralive_heat_client { comment "foreign"; }'
if bun "$1" clear 2>/dev/null; then exit 1; fi
nft -j list table inet ceralive_heat_client | grep -q '"foreign"'
echo 'PASS two clients; phone protected; guest paused; management, recovery, restart, crash expiry, foreign table preserved'
