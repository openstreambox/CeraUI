# IPv4-translated cellular sources (image CLAT)

An IPv6-only cellular link has no IPv4 address, so it cannot carry the IPv4
SRTLA stream by itself. The image's `ceralive-clat.service` owns translation for
such a link: tayga, a `clat<ifindex>` TUN with an IPv4 /32 in `10.254.0.0/19`,
source rules, routes and NAT. CeraUI owns none of it and never writes there.

`modules/network/clat-translation.ts` reads the service's snapshots,
`/run/ceralive/clat/<ifindex>.json`, once per interface scan. The snapshot is
advisory, not an activation lease, so a translation is usable only when all of
these hold; anything else is unavailable:

- a bounded (at most 4096 bytes), root-owned regular file in a root-owned
  directory;
- schema version 1 and every field well-formed: `ipv4` inside `10.254.0.0/19`,
  `prefix` an RFC 6052 length (/32, /40, /48, /56, /64, /96), a safe modem
  interface name, `state` one of the four documented values;
- `state` is `up` and `prefix` is set. `last_error` alone does not reject it:
  the service keeps a path up through its first two failed DNS refreshes;
- `updated_at` at most 30 s old and at most 5 s in the future, and the same
  `updated_at` is never accepted for more than 30 s of CeraUI's own monotonic
  time: rereading never renews it. `expires_at`, when present, not passed;
- the file index is the modem interface's current kernel ifindex, and that
  interface resolves to a known modem;
- the TUN is administratively up and has a kernel ifindex;
- `ceralive-clat.service` is active and running, with a live MainPID
  (`systemctl show`, bounded).

A translation's generation is the unit's InvocationID, the TUN's ifindex, the
modem's ifindex and `activation` when the producer adds it. A changed
generation withdraws the link for one scan before it is offered again, so the
sender's reload path sees a withdrawal, never a silent swap.

`isBondCandidate` admits a `clat<N>` interface only while such a translation
exists for it with the same IPv4, and never while its modem interface is opted
out of the bond. The bond entry carries the TUN as its interface, so the sender
binds the translated IPv4 to the TUN, as the image contract specifies. A
dual-stack link keeps its native IPv4 path: the service creates no TUN for it.

Not done here: the network list still shows the TUN by its own name rather than
under its modem.
