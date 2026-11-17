#!/usr/bin/env bash
set -euo pipefail
mount --make-rprivate /
mount -t sysfs sysfs /sys
unshare -n -- sleep 40 & phone=$!
unshare -n -- sleep 40 & receiver=$!
cleanup() {
 kill "$phone" "$receiver" 2>/dev/null || true
 wait "$phone" "$receiver" 2>/dev/null || true
}
trap cleanup EXIT
ip link set lo up
ip link add client0 type veth peer name phone0
ip link add wan0 type veth peer name sink0
ip link set phone0 netns "$phone"
ip link set sink0 netns "$receiver"
ip addr add 10.42.0.1/24 dev client0
ip addr add 192.0.2.1/24 dev wan0
ip link set client0 up
ip link set wan0 up
nsenter -t "$phone" -n ip addr add 10.42.0.2/24 dev phone0
nsenter -t "$phone" -n ip link set phone0 up
nsenter -t "$phone" -n ip route add default via 10.42.0.1
nsenter -t "$receiver" -n ip addr add 192.0.2.2/24 dev sink0
nsenter -t "$receiver" -n ip link set sink0 up
sysctl -q -w net.ipv4.ip_forward=1
# The ordinary client's egress is shaped; measurement is independent of root mode.
tc qdisc add dev wan0 root tbf rate 4mbit burst 32kb latency 400ms
nsenter -t "$receiver" -n python3 -c '
import socket, time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind(("192.0.2.2",9000)); s.settimeout(30)
n=0
try:
 while True: n+=len(s.recv(2048))
except TimeoutError:
 assert n>1000000
' & sink=$!
nsenter -t "$phone" -n python3 -c '
import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
end=time.monotonic()+27
while time.monotonic()<end:
 s.sendto(bytes(1200),("192.0.2.2",9000)); time.sleep(.004)
' & sender=$!
python3 - <<'PY'
import json,time
samples=[]
start=time.monotonic()
for i in range(6):
 samples.append({"now":(time.monotonic()-start)*1000,"bytes":int(open("/sys/class/net/client0/statistics/rx_bytes").read())})
 if i<5: time.sleep(5)
print(json.dumps(samples))
PY
wait "$sender"
# Positive WAN egress proves these were forwarded packets, not just local input.
test "$(cat /sys/class/net/wan0/statistics/tx_bytes)" -gt 1000000
kill "$sink" 2>/dev/null || true
wait "$sink" 2>/dev/null || true
