# IPv4-translated cellular sources (image CLAT)

An IPv6-only cellular link has no IPv4 address, so it cannot carry the IPv4
SRTLA stream by itself. The image's `ceralive-clat.service` owns translation for
such a link: tayga, a `clat<ifindex>` TUN with an IPv4 /32 in `10.254.0.0/19`,
source rules, routes and NAT. CeraUI owns none of it and never writes there.

`modules/network/clat-translation.ts` reads the service's read-only snapshots,
`/run/ceralive/clat/<ifindex>.json`, once per interface scan. A translation is
usable only when all of these hold; anything else is unavailable:

- schema version 1 and every field well-formed (`ipv4` inside `10.254.0.0/19`,
  a safe modem interface name, `state` one of the four documented values);
- the file index, the TUN name and `clat<ifindex>` agree;
- `state` is `up` and `prefix` is set;
- `updated_at` is within 30 seconds (the service rewrites at least every ten);
- `/sys/class/net/<tun>` and `/sys/class/net/<interface>` exist and the unit is
  running (`/run/systemd/units/invocation:ceralive-clat.service`).

`isBondCandidate` admits a `clat<N>` interface only while such a translation
exists for it with the same IPv4, and never while its modem interface is opted
out of the bond. The bond entry carries the TUN as its interface, so the sender
binds the translated IPv4 to the TUN, as the image contract specifies. A
dual-stack link keeps its native IPv4 path: the service creates no TUN for it.

Not done here: the network list still shows the TUN by its own name rather than
under its modem.
