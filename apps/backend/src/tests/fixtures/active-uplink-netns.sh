#!/usr/bin/env bash
# Single-active client uplink: kernel semantics of the rulesets the selector
# produces through failover, a silent blackhole, the rejoin hold and rejoin.
# Runs inside a private network namespace (see active-uplink-netns.test.ts).
set -euo pipefail

active0=$1
failover1=$2
held1=$3
rejoined0=$4
log0=$5
log1=$6
mark0=$7
mark1=$8

signals="${log0}.signals"
mkfifo "$signals"
exec 3<>"$signals"
wait_signal() {
	local signal
	if ! IFS= read -r -t 5 signal <&3 || [ "$signal" != "$1" ]; then
		printf 'expected signal %s, received %s\n' "$1" "${signal:-timeout}" >&2
		return 1
	fi
}
namespace_code='import os, signal, sys; os.write(3, f"namespace-{sys.argv[1]}\n".encode()); signal.pause()'
client_pid=""
wan0_pid=""
wan1_pid=""
server0=""
server1=""
cleanup() {
	[ -z "$server0" ] || kill "$server0" 2>/dev/null || true
	[ -z "$server1" ] || kill "$server1" 2>/dev/null || true
	kill "$client_pid" "$wan0_pid" "$wan1_pid" 2>/dev/null || true
	wait "$server0" "$server1" "$client_pid" "$wan0_pid" "$wan1_pid" 2>/dev/null || true
	exec 3>&-
	rm -f "$signals"
}
trap cleanup EXIT

unshare -n -- python3 -c "$namespace_code" client & client_pid=$!
wait_signal namespace-client
unshare -n -- python3 -c "$namespace_code" wan0 & wan0_pid=$!
wait_signal namespace-wan0
unshare -n -- python3 -c "$namespace_code" wan1 & wan1_pid=$!
wait_signal namespace-wan1

ip link set lo up
ip link add client0 type veth peer name client_peer
ip link add wan0 type veth peer name wan0_peer
ip link add wan1 type veth peer name wan1_peer
ip link set client_peer netns "$client_pid"
ip link set wan0_peer netns "$wan0_pid"
ip link set wan1_peer netns "$wan1_pid"
ip addr add 10.42.0.1/24 dev client0
ip addr add 192.0.2.1/24 dev wan0
ip addr add 198.51.100.1/24 dev wan1
ip link set client0 up
ip link set wan0 up
ip link set wan1 up

nsenter -t "$client_pid" -n ip link set lo up
nsenter -t "$client_pid" -n ip addr add 10.42.0.2/24 dev client_peer
nsenter -t "$client_pid" -n ip link set client_peer up
nsenter -t "$client_pid" -n ip route add default via 10.42.0.1
for side in 0 1; do
	pid_var="wan${side}_pid"
	pid=${!pid_var}
	if [ "$side" = 0 ]; then peer=192.0.2.2; box=192.0.2.1; else peer=198.51.100.2; box=198.51.100.1; fi
	nsenter -t "$pid" -n ip link set lo up
	nsenter -t "$pid" -n ip addr add "$peer/24" dev "wan${side}_peer"
	nsenter -t "$pid" -n ip addr add 203.0.113.10/32 dev lo
	nsenter -t "$pid" -n ip link set "wan${side}_peer" up
	nsenter -t "$pid" -n ip route add default via "$box"
done

# Host routing as on a device: main default on wan0, per-uplink tables, the
# source rules that bound senders (SRTLA, Moblink) use at priority 100 and the
# steering fwmark rules at 110.
table0=$((30000 + ((mark0 >> 8) & 65535)))
table1=$((30000 + ((mark1 >> 8) & 65535)))
ip route add default via 192.0.2.2 dev wan0
ip route add default via 192.0.2.2 dev wan0 table "$table0"
ip route add default via 198.51.100.2 dev wan1 table "$table1"
ip rule add priority 100 from 192.0.2.1 lookup "$table0"
ip rule add priority 100 from 198.51.100.1 lookup "$table1"
ip rule add priority 110 fwmark "$mark0/0xffffff00" lookup "$table0"
ip rule add priority 110 fwmark "$mark1/0xffffff00" lookup "$table1"
sysctl -q -w net.ipv4.ip_forward=1
for conf in all default client0 wan0 wan1; do
	sysctl -q -w "net.ipv4.conf.${conf}.rp_filter=0"
done

read -r -d '' SERVER_CODE <<'PY' || true
import os, socket, sys
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((sys.argv[2], 9000))
with open(sys.argv[1], "a", buffering=1) as output:
    os.write(3, b"server-ready\n")
    while True:
        data, peer = sock.recvfrom(2048)
        output.write(f"{data.decode()}|{peer[0]}\n")
        sock.sendto(b"received", peer)
PY
nsenter -t "$wan0_pid" -n python3 -u -c "$SERVER_CODE" "$log0" 203.0.113.10 & server0=$!
wait_signal server-ready
nsenter -t "$wan1_pid" -n python3 -u -c "$SERVER_CODE" "$log1" 203.0.113.10 & server1=$!
wait_signal server-ready

# Sends one datagram per flow from a fixed source port; prints ok or timeout.
read -r -d '' SEND <<'PY' || true
import socket, sys
label, source_ip, first_port, count = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
results = []
for index in range(count):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.5)
    sock.bind((source_ip, first_port + index))
    sock.sendto(f"{label}-{index}".encode(), ("203.0.113.10", 9000))
    try:
        results.append("ok" if sock.recvfrom(1024)[0] == b"received" else "bad")
    except TimeoutError:
        results.append("timeout")
    sock.close()
print(",".join(sorted(set(results))))
PY
send() { nsenter -t "$client_pid" -n python3 -c "$SEND" "$@"; }
flush_mark() {
	if command -v conntrack >/dev/null 2>&1; then
		conntrack --delete --mark "$1/0xffffff00" >/dev/null 2>&1 || true
		return
	fi
	python3 - "$1" <<'PY'
import socket, struct, sys
mark = int(sys.argv[1], 16)
def nla(kind, value):
    size = 4 + len(value)
    return struct.pack("=HH", size, kind) + value + bytes(((size + 3) & ~3) - size)
payload = struct.pack("!BBH", socket.AF_INET, 0, 0)
payload += nla(8, struct.pack("!I", mark)) + nla(21, struct.pack("!I", 0xffffff00))
header = struct.pack("=IHHII", 16 + len(payload), (1 << 8) | 2, 1 | 4, 1, 0)
sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)
sock.settimeout(2)
sock.bind((0, 0))
sock.send(header + payload)
while True:
    response = sock.recv(65535)
    _, kind, _, sequence, _ = struct.unpack_from("=IHHII", response)
    if sequence == 1 and kind == 2:
        error = struct.unpack_from("=i", response, 16)[0]
        if error not in (0, -2):
            raise SystemExit(f"ctnetlink delete failed: {-error}")
        break
PY
}
blackhole() {
	nsenter -t "$wan0_pid" -n nft -f - <<'NFT'
table inet blackhole {
	chain input {
		type filter hook input priority 0; policy accept;
		udp dport 9000 drop
	}
}
NFT
}

# 1. wan0 active: every new client flow exits wan0; wan1 carries a bound
#    host sender (as SRTLA would) at the same time.
nft --check --file "$active0"
nft --file "$active0"
p1_flows=$(send p1 10.42.0.2 40000 40)
p1_long=$(send long0 10.42.0.2 41000 1)
p1_host=$(python3 -c "$SEND" host1 198.51.100.1 42000 1)

# 2. Silent blackhole upstream of wan0: the link stays up, packets vanish.
blackhole
p2_lost=$(send p2lost 10.42.0.2 40100 5)
# Health marks wan0 down; the applier retires wan0 flows, then failover.
flush_mark "$mark0"
nft --file "$failover1"
p2_flows=$(send p2 10.42.0.2 40200 40)
p2_long=$(send long0r 10.42.0.2 41000 1)
p2_host=$(python3 -c "$SEND" host2 198.51.100.1 42001 1)

# 3. wan0 healthy again but inside its rejoin hold: clients stay on wan1.
nsenter -t "$wan0_pid" -n nft delete table inet blackhole
nft --file "$held1"
p3_flows=$(send p3 10.42.0.2 40300 40)
p3_long=$(send long1 10.42.0.2 41100 1)

# 4. Hold served: new flows rejoin wan0, the established wan1 flow drains.
nft --file "$rejoined0"
p4_flows=$(send p4 10.42.0.2 40400 40)
p4_long=$(send long1d 10.42.0.2 41100 1)

count() { command grep -c "^$2-" "$1" || true; }
source_of() { command grep "^$2|" "$1" | tail -n 1 | cut -d'|' -f2; }
python3 - "$@" <<PY
import json
print(json.dumps({
    "p1": {"result": "$p1_flows", "wan0": $(count "$log0" p1), "wan1": $(count "$log1" p1),
           "long": "$p1_long", "longOn": "$( [ -n "$(source_of "$log0" long0-0)" ] && echo wan0 || echo wan1)",
           "host": "$p1_host", "hostOn": "$( [ -n "$(source_of "$log1" host1-0)" ] && echo wan1 || echo wan0)"},
    "p2": {"lost": "$p2_lost", "result": "$p2_flows", "wan0": $(count "$log0" p2), "wan1": $(count "$log1" p2),
           "long": "$p2_long", "longSource": "$(source_of "$log1" long0r-0)",
           "host": "$p2_host"},
    "p3": {"result": "$p3_flows", "wan0": $(count "$log0" p3), "wan1": $(count "$log1" p3),
           "long": "$p3_long"},
    "p4": {"result": "$p4_flows", "wan0": $(count "$log0" p4), "wan1": $(count "$log1" p4),
           "long": "$p4_long", "longSource": "$(source_of "$log1" long1d-0)",
           "longOnWan0": $(count "$log0" long1d)},
}))
PY
