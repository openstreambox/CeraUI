## A MODEM PROFILE REQUESTS THE IP FAMILY THE CARRIER SERVES [PARTIAL]

NetworkManager has no PDP-type property on a gsm profile. It derives the bearer
request from `ipv4.method` and `ipv6.method`: with IPv6 `ignore` or `disabled`
the request is IPv4 only; with both enabled it tries IPv4v6 first and falls
back to a single family while that family's `may-fail` allows it.

Every profile used to be created with `ipv6.method ignore`. On a carrier whose
packet core is IPv6-only (IPv4 reached through NAT64) that request can never
produce a usable bearer: the modem registers, shows signal, and retries forever.

`modules/modems/bearer-ip-family.ts` owns the decision:

- **IPv4 stays the default.** A changed request can be refused on a SIM that
  works today, so nothing changes without evidence.
- **Evidence is positive.** IPv4v6 is requested when the SIM's operator code or
  the SERVING network's code is a listed IPv6-only carrier (a SIM may publish no
  operator code at all), or when the network granted the attach bearer as IPv6
  alone. A dual-stack attach bearer is not evidence: IPv4 carriers report it too.
- **No IPv6 default route.** Dual-stack profiles set `ipv6.never-default yes`.
  A cellular link that became the system's only IPv6 default would pull
  management traffic off a wired or Wi-Fi uplink. Per-uplink IPv6 routing belongs
  to whoever pins stream sources. Temporary addresses are disabled so a bound
  source does not rotate.
- **`may-fail` is never written.** The single-family fallback must survive.
- **Existing profiles converge in place.** Registration reads the stored
  methods and issues one `nmcli connection modify` when they differ, for the
  selected profile and for every duplicate bound to the same SIM. Nothing is
  deactivated: a connected bearer keeps running and the next activation uses
  the new request. A failed read writes nothing. The default decision never
  rewrites a stored profile.

**What is not built.** An IPv6-only grant still yields no stream source:
interface discovery keeps one IPv4 address per netdev, the receiver lookup asks
for A records, and the sender gives every uplink one destination.
`modules/network/ipv6-source.ts` (one stable global IPv6 source per netdev; one
source and destination per uplink, IPv4 first, then native IPv6, then NAT64)
and `modules/network/nat64.ts` (RFC 6052 synthesis, RFC 7050 prefix discovery
per uplink) are the tested building blocks and are deliberately NOT wired into
the published source list until the sender can take a destination per uplink.
There is no per-modem operator setting for the family yet.

Tests: `tests/bearer-ip-family.test.ts` (fake NetworkManager),
`tests/nat64.test.ts`, `tests/ipv6-source.test.ts`, and
`tests/ipv6-only-uplink-kernel.test.ts`, which runs two network namespaces: an
uplink with no IPv4 address discovers the prefix over that uplink and exchanges
UDP with an IPv4-only receiver through a NAT64 stub, with no default route in
the main tables. The stub is test code, not a qualified translator.
