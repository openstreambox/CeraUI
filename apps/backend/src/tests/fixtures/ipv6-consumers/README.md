# IPv6 consumer transport proof

Run only inside a fresh private mount, network and PID namespace. No physical
interface, host route, resolver, firewall or NetworkManager instance is used.
Requires `ip`, `nft`, `nsenter`, Python 3, Bun 1.4.4, Rust `srtla_send` 4.1.0,
a compiled IPv4 BELABOX `srtla_rec`, and TAYGA 0.9.2. Supply absolute paths in
`SRTLA_REC`, `TAYGA_BIN`, `BUN`, and a writable scratch directory in `PROOF_OUTPUT`.
The sender must be on PATH as `/usr/bin/srtla_send`.

From the repository root, with the dependencies installed:

```sh
sudo --preserve-env=SRTLA_REC,TAYGA_BIN,BUN,PROOF_OUTPUT \
  unshare --mount --net --pid --fork --mount-proc \
  python3 apps/backend/src/tests/fixtures/ipv6-consumers/proof.py
```

The fixture creates synthetic WAN, receiver and hotspot-client namespaces. It
feeds real `ip addr show` output through CeraUI inventory and bond publication
selection, then supplies that selected source to the real sender. The interface
flags are a synthetic ifconfig envelope; this does not test net-tools itself.
IPv4-only and dual-stack keep IPv4 preference. IPv6-only uses a DNS64 hostname
through a provider-side NAT64 translator, with an IPv4 receiver. Each mode must
forward all 30 marked packets after registration. Generated client-sharing nft
rules must forward an IPv4 client in the first two modes and time out in the
third. With the IPv6-only WAN still present, adding an IPv4 backup WAN must
restore client reachability. The timeout documents the missing IPv4 service path, not stream failure.

Outputs are scratch evidence, never committed: results, packet traces and sender
logs. This is finite UDP/SRTLA transport, not decoded video or carrier, TLS,
throughput, latency or multi-modem qualification. The receiver used here cannot
listen on native IPv6. Native IPv6 receiver compatibility needs a dual-stack
receiver build; the source-selection and AAAA-only unit tests cover admission.
