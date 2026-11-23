#!/usr/bin/env bash
set -euo pipefail

weighted=$1
select_wan0=$2
transition_wan1=$3
final_wan1=$4
log0=$5
log1=$6
mark0=$7
mark1=$8
nm_shared=$9
all_down=${10}
return_selectable=${11}
admin_down=${17}
shift 11

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
shared_pid=""
server0=""
server1=""
client_server=""
shared_server=""
local_server=""
cleanup() {
	[ -z "$local_server" ] || kill "$local_server" 2>/dev/null || true
	[ -z "$server0" ] || kill "$server0" 2>/dev/null || true
	[ -z "$server1" ] || kill "$server1" 2>/dev/null || true
	[ -z "$client_server" ] || kill "$client_server" 2>/dev/null || true
	[ -z "$shared_server" ] || kill "$shared_server" 2>/dev/null || true
	kill "$client_pid" "$wan0_pid" "$wan1_pid" "$shared_pid" 2>/dev/null || true
	wait "$local_server" "$server0" "$server1" "$client_server" "$shared_server" \
		"$client_pid" "$wan0_pid" "$wan1_pid" "$shared_pid" 2>/dev/null || true
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
if [ "$nm_shared" = "--nm-shared" ]; then
	unshare -n -- python3 -c "$namespace_code" shared & shared_pid=$!
	wait_signal namespace-shared
fi

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

nsenter -t "$wan0_pid" -n ip link set lo up
nsenter -t "$wan0_pid" -n ip addr add 192.0.2.2/24 dev wan0_peer
nsenter -t "$wan0_pid" -n ip addr add 203.0.113.10/32 dev lo
nsenter -t "$wan0_pid" -n ip link set wan0_peer up
nsenter -t "$wan0_pid" -n ip route add default via 192.0.2.1

nsenter -t "$wan1_pid" -n ip link set lo up
nsenter -t "$wan1_pid" -n ip addr add 198.51.100.2/24 dev wan1_peer
nsenter -t "$wan1_pid" -n ip addr add 203.0.113.10/32 dev lo
nsenter -t "$wan1_pid" -n ip link set wan1_peer up
nsenter -t "$wan1_pid" -n ip route add default via 198.51.100.1

ip route add default via 192.0.2.2 dev wan0
ip route add default via 198.51.100.2 dev wan1 metric 200
# Exercise production planning/provisioning against genuinely absent FIB tables.
CERALIVE_STEERING_FIXTURE_MARKS="$mark0,$mark1" bun test "$(dirname "$0")/provision-steering-routes.fixture.test.ts" >&2
table0=$((30000 + ((mark0 >> 8) & 65535)))
table1=$((30000 + ((mark1 >> 8) & 65535)))
sysctl -q -w net.ipv4.ip_forward=1
sysctl -q -w net.ipv4.conf.all.rp_filter=0
sysctl -q -w net.ipv4.conf.default.rp_filter=0
sysctl -q -w net.ipv4.conf.client0.rp_filter=0
sysctl -q -w net.ipv4.conf.wan0.rp_filter=0
sysctl -q -w net.ipv4.conf.wan1.rp_filter=0

nft -f - <<'NFT'
table inet ceralive_ingest_fw {
	chain input {
		type filter hook input priority -10; policy accept;
		udp dport 4001 accept
	}
}
NFT
ingest_before=$(nft list table inet ceralive_ingest_fw)
nft --check --file "$weighted"
nft --file "$weighted"

read -r -d '' SERVER_CODE <<'PY' || true
import os, selectors, socket, sys
selector = selectors.DefaultSelector()
for port in (9000, 9001, 9002, 9003, 9100, 9101, 9200, 9300):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((sys.argv[2], port))
    selector.register(sock, selectors.EVENT_READ, port)
with open(sys.argv[1], "a", buffering=1) as output:
    os.write(3, b"server-ready\n")
    while True:
        for key, _ in selector.select():
            data, peer = key.fileobj.recvfrom(2048)
            text = data.decode()
            output.write(f"{text}|{peer[0]}|{peer[1]}|{key.data}\n")
            key.fileobj.sendto(b"reply-ok" if text == "reply-probe" else b"received", peer)
PY
nsenter -t "$wan0_pid" -n python3 -u -c "$SERVER_CODE" "$log0" 203.0.113.10 & server0=$!
wait_signal server-ready
nsenter -t "$wan1_pid" -n python3 -u -c "$SERVER_CODE" "$log1" 203.0.113.10 & server1=$!
wait_signal server-ready

read -r -d '' WEIGHTED_SEND <<'PY' || true
import socket
for index in range(1000):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    sock.sendto(f"weighted-{index}".encode(), ("203.0.113.10", 9000))
    assert sock.recvfrom(1024)[0] == b"received", f"weighted-{index} not acknowledged"
    sock.close()
PY
nsenter -t "$client_pid" -n python3 -c "$WEIGHTED_SEND"

read -r -d '' SEND_ONE <<'PY' || true
import socket, sys
payload, source_ip, source_port, dest_port = sys.argv[1:]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2)
sock.bind((source_ip, int(source_port)))
sock.sendto(payload.encode(), ("203.0.113.10", int(dest_port)))
assert sock.recvfrom(1024)[0] == b"received", f"{payload} not acknowledged"
sock.close()
PY

nft --file "$select_wan0"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-before 10.42.0.2 39001 9001

nft --file "$transition_wan1"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-after 10.42.0.2 39001 9001
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" new-after 10.42.0.2 39002 9002
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" drain-new 10.42.0.2 39004 9003
python3 -c "$SEND_ONE" local 192.0.2.1 39003 9100
python3 -c "$SEND_ONE" overlap-local 10.42.0.1 39006 9101

read -r -d '' REPLY_PROBE <<'PY' || true
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2)
sock.bind(("10.42.0.2", 39005))
sock.sendto(b"reply-probe", ("203.0.113.10", 9200))
try:
    data, _ = sock.recvfrom(1024)
    print("true" if data == b"reply-ok" else "false")
except TimeoutError:
    print("false")
PY
reply_round_trip=$(nsenter -t "$client_pid" -n python3 -c "$REPLY_PROBE")

flush_backend="conntrack"
if command -v conntrack >/dev/null 2>&1; then
	conntrack --delete --mark "$mark0/0xffffff00" >/dev/null
else
	flush_backend="ctnetlink"
	python3 - "$mark0" <<'PY'
import socket, struct, sys

mark = int(sys.argv[1], 16)
mask = 0xffffff00

def nla(kind, value):
    size = 4 + len(value)
    padded = (size + 3) & ~3
    return struct.pack("=HH", size, kind) + value + bytes(padded - size)

payload = struct.pack("!BBH", socket.AF_INET, 0, 0)
payload += nla(8, struct.pack("!I", mark))
payload += nla(21, struct.pack("!I", mask))
sequence = 1
message_type = (1 << 8) | 2
header = struct.pack("=IHHII", 16 + len(payload), message_type, 1 | 4, sequence, 0)
sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)
sock.settimeout(2)
sock.bind((0, 0))
sock.send(header + payload)
while True:
    response = sock.recv(65535)
    _, response_type, _, response_sequence, _ = struct.unpack_from("=IHHII", response)
    if response_sequence != sequence:
        continue
    if response_type != 2:
        raise SystemExit(f"unexpected netlink response type {response_type}")
    error = struct.unpack_from("=i", response, 16)[0]
    if error != 0:
        raise SystemExit(f"ctnetlink delete failed: {-error}")
    break
PY
fi

ip rule del priority 110 fwmark "$mark0/0xffffff00" lookup "$table0"
nft --file "$final_wan1"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" sticky-post-flush 10.42.0.2 39001 9001

# Runtime selector states generated by the production policy helper. Physical
# uplinks stay up: only shared-client nft selection changes.
# Restore healthy support after the preceding physical-hard-down drill.
ip rule add priority 110 fwmark "$mark0/0xffffff00" lookup "$table0"
selector_routes_before=$(ip -4 route show table all)
selector_rules_before=$(ip rule show)
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" selector-force 10.42.0.2 39201 9002
nft --file "$select_wan0"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" selector-preferred 10.42.0.2 39202 9002
nft --file "$admin_down"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" selector-down 10.42.0.2 39203 9002
nft --file "$select_wan0"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" selector-back 10.42.0.2 39204 9002
nft --file "$final_wan1"
[ "$(ip -4 route show table all)" = "$selector_routes_before" ]
[ "$(ip rule show)" = "$selector_rules_before" ]
ip rule del priority 110 fwmark "$mark0/0xffffff00" lookup "$table0"

for golden in "$@"; do
	nft --check --file "$golden"
done
nft list table inet ceralive_ingest_fw >/dev/null

nm_result='null'
if [ "$nm_shared" = "--nm-shared" ]; then
	ip link add shared0 type veth peer name shared_peer
	ip link set shared_peer netns "$shared_pid"
	ip addr add 10.43.0.1/24 dev shared0
	ip link set shared0 up
	sysctl -q -w net.ipv4.conf.shared0.rp_filter=0
	nsenter -t "$shared_pid" -n ip link set lo up
	nsenter -t "$shared_pid" -n ip addr add 10.43.0.2/24 dev shared_peer
	nsenter -t "$shared_pid" -n ip link set shared_peer up
	nsenter -t "$shared_pid" -n ip route add default via 10.43.0.1
	# Route cross-zone probes to the actual peer, even when steering marks them.
	ip route add 10.42.0.0/24 dev client0 table "$table1"
	ip route add 10.43.0.0/24 dev shared0 table "$table1"
	nsenter -t "$client_pid" -n python3 -u -c "$SERVER_CODE" "${log0}.client" 10.42.0.2 & client_server=$!
	wait_signal server-ready
	nsenter -t "$shared_pid" -n python3 -u -c "$SERVER_CODE" "${log0}.shared" 10.43.0.2 & shared_server=$!
	wait_signal server-ready
	for zone in 'client0 10.42.0.0/24' 'shared0 10.43.0.0/24'; do
		read -r ifname prefix <<<"$zone"
		nft -f - <<NFT
table ip nm-shared-$ifname {
	chain nat_postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr $prefix ip daddr != $prefix masquerade
	}
	chain filter_forward {
		type filter hook forward priority filter; policy accept;
		ip daddr $prefix oifname "$ifname" ct state { established, related } accept
		ip saddr $prefix iifname "$ifname" accept
		iifname "$ifname" oifname "$ifname" accept
		iifname "$ifname" reject
		oifname "$ifname" reject
	}
}
NFT
	done
	nft -f - <<'NFT'
table inet coexist_observer {
	chain forward {
		type filter hook forward priority -1; policy accept;
		iifname { "client0", "shared0" } udp sport { 42104, 42105, 42200, 42201 } ct state new meta mark 0 ct mark 0 counter comment "fresh-unmarked-cross"
	}
	chain output {
		type filter hook output priority mangle; policy accept;
		ip saddr 192.0.2.1 ip daddr 203.0.113.10 udp sport 42300 meta mark 0 ct mark 0 counter comment "local-unmarked"
		ip saddr 10.42.0.1 udp sport 39104 meta mark 0 ct mark 0 counter comment "alldown-local-unmarked"
	}
}
NFT
	nm_result=$(python3 - "$client_pid" "$shared_pid" "$wan0_pid" <<'PY'
import json, socket, subprocess, sys

client, shared, wan = sys.argv[1:]
probe_code = """
import socket, sys
source, destination, port = sys.argv[1:]
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.settimeout(2)
    sock.bind((source, int(port)))
    sock.connect((destination, 9300))
    sock.send(b"coexist-probe")
    try:
        data = sock.recv(1024)
        assert data == b"received", f"unexpected reply: {data!r}"
        print("reply")
    except ConnectionRefusedError:
        print("rejected")
"""

def probe(namespace, source, destination, port):
    command = ["python3", "-c", probe_code, source, destination, str(port)]
    if namespace:
        command = ["nsenter", "-t", namespace, "-n", *command]
    return subprocess.check_output(command, text=True, timeout=3).strip()

def phase(base):
    return {
        "hotspotRoundTrip": probe(client, "10.42.0.2", "203.0.113.10", base),
        "sharedLanRoundTrip": probe(shared, "10.43.0.2", "203.0.113.10", base + 1),
        "uplinkToHotspot": probe(wan, "192.0.2.2", "10.42.0.2", base + 2),
        "uplinkToSharedLan": probe(wan, "192.0.2.2", "10.43.0.2", base + 3),
        "hotspotToSharedLan": probe(client, "10.42.0.2", "10.43.0.2", base + 4),
        "sharedLanToHotspot": probe(shared, "10.43.0.2", "10.42.0.2", base + 5),
    }

coexistence = phase(42000)
assert probe(None, "192.0.2.1", "203.0.113.10", 42300) == "reply"
subprocess.run(["nft", "delete", "table", "inet", "ceralive_share"], check=True)
subprocess.run(["nft", "add", "table", "inet", "ceralive_share"], check=True)

cross_routes = []
for source, destination, incoming, outgoing in (
    ("10.42.0.2", "10.43.0.2", "client0", "shared0"),
    ("10.43.0.2", "10.42.0.2", "shared0", "client0"),
):
    route = json.loads(subprocess.check_output([
        "ip", "-j", "route", "get", destination, "from", source,
        "iif", incoming, "mark", "0",
    ]))[0]
    assert route["dev"] == outgoing, route
    cross_routes.append(route["dev"])
floor_only = phase(42100)

# Empty steering means fresh unmarked flows reach the opposing zone. Only the
# NM reject statements change, so a successful flow proves rejection had teeth.
for ifname in ("client0", "shared0"):
    ruleset = json.loads(subprocess.check_output([
        "nft", "-j", "-a", "list", "chain", "ip", f"nm-shared-{ifname}", "filter_forward",
    ]))
    for entry in ruleset["nftables"]:
        rule = entry.get("rule")
        if rule and any("reject" in expr for expr in rule["expr"]):
            subprocess.run([
                "nft", "delete", "rule", "ip", f"nm-shared-{ifname}",
                "filter_forward", "handle", str(rule["handle"]),
            ], check=True)
without_rejects = [
    probe(client, "10.42.0.2", "10.43.0.2", 42200),
    probe(shared, "10.43.0.2", "10.42.0.2", 42201),
]
observer = json.loads(subprocess.check_output([
    "nft", "-j", "list", "table", "inet", "coexist_observer",
]))
counters = {
    entry["rule"]["comment"]: next(
        expr["counter"]["packets"] for expr in entry["rule"]["expr"] if "counter" in expr
    )
    for entry in observer["nftables"] if "rule" in entry
}
print(json.dumps({
    "coexistence": coexistence,
    "floorOnly": floor_only,
    "crossRoutes": cross_routes,
    "withoutRejects": without_rejects,
    "freshUnmarkedCrossPackets": counters["fresh-unmarked-cross"],
    "localUnmarkedPackets": counters["local-unmarked"],
}))
PY
)
fi

# --- all-down and return ------------------------------------------------------
# Everything below stays inside this script's own namespaces. The "established"
# case runs against a transition fixture that RETAINS the wan1 mark route and NAT
# rule; it does not model physical loss of every uplink. The local-service probes
# are protocol-shaped but minimal: UDP 53/67 are echo reachability probes (not DNS
# resolution or a DHCP lease) and HTTP is a stdlib GET.
client_ifindex_before=$(ip -j link show dev client0 | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["ifindex"])')

read -r -d '' TRY_SEND <<'PY' || true
import socket, sys
payload, source_ip, source_port, dest_ip, dest_port = sys.argv[1:]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(1.5)
sock.bind((source_ip, int(source_port)))
sock.sendto(payload.encode(), (dest_ip, int(dest_port)))
try:
    print("reply" if sock.recvfrom(1024)[0] == b"received" else "unexpected")
except TimeoutError:
    print("blocked")
finally:
    sock.close()
PY

read -r -d '' LOCAL_SERVICE_CODE <<'PY' || true
import http.server, os, selectors, socket, threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"local-http"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass

httpd = http.server.HTTPServer(("10.42.0.1", 18080), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
selector = selectors.DefaultSelector()
for port in (53, 67):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("10.42.0.1", port))
    selector.register(sock, selectors.EVENT_READ)
os.write(3, b"server-ready\n")
while True:
    for key, _ in selector.select():
        _, peer = key.fileobj.recvfrom(2048)
        key.fileobj.sendto(b"local-echo", peer)
PY

read -r -d '' LOCAL_PROBE <<'PY' || true
import json, socket, urllib.request

def udp(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(1.5)
    sock.bind(("10.42.0.2", 0))
    sock.sendto(b"local-probe", ("10.42.0.1", port))
    try:
        return "echo" if sock.recvfrom(1024)[0] == b"local-echo" else "unexpected"
    except TimeoutError:
        return "timeout"
    finally:
        sock.close()

def http_get():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://10.42.0.1:18080/", timeout=2) as response:
            return "ok" if response.status == 200 and response.read() == b"local-http" else "unexpected"
    except OSError:
        return "error"

print(json.dumps({"udp53Echo": udp(53), "udp67Echo": udp(67), "httpGet": http_get()}))
PY

# The service runs in the box namespace (this script's), not the client's.
python3 -u -c "$LOCAL_SERVICE_CODE" & local_server=$!
wait_signal server-ready

routed_control="not-run"
if [ "$nm_shared" = "--nm-shared" ]; then
	# The preceding coexistence phase left the steering table empty and proved
	# unmarked cross-zone routing after removing only the NM reject statements.
	# Selectable steering would mark this probe into a WAN table instead.
	routed_control=$(nsenter -t "$client_pid" -n python3 -c "$TRY_SEND" alldown-routed-control 10.42.0.2 39107 10.43.0.2 9300)
fi
nft --check --file "$return_selectable"
nft --file "$return_selectable"
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" alldown-est-pre 10.42.0.2 39101 9001

nft --check --file "$all_down"
nft --file "$all_down"
drop_chain_during=false
if nft list chain inet ceralive_share forward >/dev/null 2>&1; then drop_chain_during=true; fi
ingest_during=$(nft list table inet ceralive_ingest_fw)
nm_tables_during=false
if [ "$nm_shared" = "--nm-shared" ] \
	&& nft list table ip nm-shared-client0 >/dev/null 2>&1 \
	&& nft list table ip nm-shared-shared0 >/dev/null 2>&1; then
	nm_tables_during=true
fi

nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" alldown-est-during 10.42.0.2 39101 9001
new_flow_during=$(nsenter -t "$client_pid" -n python3 -c "$TRY_SEND" alldown-new 10.42.0.2 39102 203.0.113.10 9002)
routed_during="not-run"
if [ "$nm_shared" = "--nm-shared" ]; then
	routed_during=$(nsenter -t "$client_pid" -n python3 -c "$TRY_SEND" alldown-routed-during 10.42.0.2 39108 10.43.0.2 9300)
fi
local_services=$(nsenter -t "$client_pid" -n python3 -c "$LOCAL_PROBE")
python3 -c "$SEND_ONE" alldown-local 192.0.2.1 39103 9100
python3 -c "$SEND_ONE" alldown-overlap-local 10.42.0.1 39104 9101

nft --file "$return_selectable"
drop_chain_after=false
if nft list chain inet ceralive_share forward >/dev/null 2>&1; then drop_chain_after=true; fi
nsenter -t "$client_pid" -n python3 -c "$SEND_ONE" alldown-return-new 10.42.0.2 39105 9002
client_ifindex_after=$(ip -j link show dev client0 | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["ifindex"])')
ingest_return=$(nft list table inet ceralive_ingest_fw)
all_down_result=$(python3 - "$routed_control" "$new_flow_during" "$routed_during" \
	"$local_services" "$drop_chain_during" "$drop_chain_after" \
	"$client_ifindex_before" "$client_ifindex_after" \
	"$([ "$ingest_during" = "$ingest_before" ] && echo true || echo false)" \
	"$([ "$ingest_return" = "$ingest_before" ] && echo true || echo false)" \
	"$nm_tables_during" <<'PY'
import json, sys

(control, new_flow, routed, services, chain_during, chain_after,
 index_before, index_after, ingest_during, ingest_return, nm_tables) = sys.argv[1:]
print(json.dumps({
    "routedPeerControl": control,
    "newFlowDuring": new_flow,
    "routedPeerDuring": routed,
    "localServices": json.loads(services),
    "dropChainDuring": chain_during == "true",
    "dropChainAfterReturn": chain_after == "true",
    "clientIfindexUnchanged": index_before == index_after,
    "ingestUnchangedDuring": ingest_during == "true",
    "ingestUnchangedAfterReturn": ingest_return == "true",
    "nmTablesPresentDuring": nm_tables == "true",
}))
PY
)

ingest_after=$(nft list table inet ceralive_ingest_fw)

python3 - "$log0" "$log1" "$reply_round_trip" "$flush_backend" \
	"$(sysctl -n net.ipv4.conf.all.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.default.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan0.rp_filter)" \
	"$(sysctl -n net.ipv4.conf.wan1.rp_filter)" \
	"$ingest_before" "$ingest_after" "$nm_result" "$all_down_result" "${log0}.shared" <<'PY'
import json, pathlib, subprocess, sys

def read(path):
    file = pathlib.Path(path)
    return file.read_text().splitlines() if file.exists() else []

rows = {"wan0": read(sys.argv[1]), "wan1": read(sys.argv[2])}

def tagged(prefix):
    return [(name, row) for name, values in rows.items() for row in values if row.startswith(prefix + "|")]

def uplink(tag):
    matches = tagged(tag)
    return matches[0][0] if len(matches) == 1 else None

def source(tag):
    matches = tagged(tag)
    return matches[0][1].split("|")[1] if len(matches) == 1 else None

weighted0 = sum(row.startswith("weighted-") for row in rows["wan0"])
weighted1 = sum(row.startswith("weighted-") for row in rows["wan1"])
weighted_nat = all(
    row.split("|")[1] == expected
    for name, expected in (("wan0", "192.0.2.1"), ("wan1", "198.51.100.1"))
    for row in rows[name]
    if row.startswith("weighted-")
)

shared_rows = read(sys.argv[13])

def shared_seen(prefix):
    return sum(row.startswith(prefix + "|") for row in shared_rows)

all_down = json.loads(sys.argv[12])
observer = json.loads(subprocess.check_output([
    "nft", "-j", "list", "chain", "inet", "coexist_observer", "output",
]))
local_unmarked = sum(
    expr["counter"]["packets"]
    for entry in observer["nftables"] if "rule" in entry
    if entry["rule"].get("comment") == "alldown-local-unmarked"
    for expr in entry["rule"]["expr"] if "counter" in expr
)
all_down.update({
    "hostOverlapUnmarkedPackets": local_unmarked,
    "establishedPreUplink": uplink("alldown-est-pre"),
    "establishedDuringUplink": uplink("alldown-est-during"),
    "establishedDuringSource": source("alldown-est-during"),
    "newFlowDeliveredUplink": uplink("alldown-new"),
    "routedControlSeen": shared_seen("alldown-routed-control"),
    "routedDuringSeen": shared_seen("alldown-routed-during"),
    "hostOutputUplink": uplink("alldown-local"),
    "hostOutputSource": source("alldown-local"),
    "hostOverlapSource": source("alldown-overlap-local"),
    "returnNewUplink": uplink("alldown-return-new"),
    "returnNewSource": source("alldown-return-new"),
})

print(json.dumps({
    "selector": {"force": uplink("selector-force"), "preferred": uplink("selector-preferred"), "down": uplink("selector-down"), "back": uplink("selector-back")},
    "weightedWan0": weighted0,
    "weightedWan1": weighted1,
    "weightedTotal": weighted0 + weighted1,
    "weightedNatScoped": weighted_nat,
    "stickyBefore": uplink("sticky-before"),
    "stickyAfter": uplink("sticky-after"),
    "newAfterReweight": uplink("new-after"),
    "drainNew": uplink("drain-new"),
    "stickyPostFlush": uplink("sticky-post-flush"),
    "localUplink": uplink("local"),
    "localSource": source("local"),
    "overlapLocalSource": source("overlap-local"),
    "replyProbeUplink": uplink("reply-probe"),
    "replyRoundTrip": sys.argv[3] == "true",
    "flushBackend": sys.argv[4],
    "rpFilter": {
        "all": int(sys.argv[5]),
        "default": int(sys.argv[6]),
        "wan0": int(sys.argv[7]),
        "wan1": int(sys.argv[8]),
    },
    "foreignTablePresent": True,
    "ingestBefore": sys.argv[9],
    "ingestAfter": sys.argv[10],
    "nmSharing": json.loads(sys.argv[11]),
    "allDown": all_down,
}))
PY
