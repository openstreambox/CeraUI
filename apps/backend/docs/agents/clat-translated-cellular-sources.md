# IPv4-translated cellular sources (image CLAT)

An IPv6-only cellular link has no IPv4 address, so it cannot carry the IPv4
SRTLA stream by itself. The image's `ceralive-clat.service` owns translation for
such a link: tayga, a `clat<ifindex>` TUN with an IPv4 /32 in `10.254.0.0/19`,
source rules, routes and NAT. CeraUI owns none of it and never writes there.

`modules/network/clat-translation.ts` reads the service's v2 snapshots,
`/run/ceralive/clat/<ifindex>.json` (the image's `docs/cellular-clat.md` is the
contract), on its own two-second poll and again inside the serialized bond writer immediately before publication.
A translation is usable only when all of these hold; anything else is
unavailable:

- a bounded (at most 4096 bytes), root-owned regular file in a root-owned
  directory;
- `schema_version` 2 with all 15 fields well-formed (v1 is unavailable):
  positive ifindices, safe names, `ipv4` inside `10.254.0.0/19`, an RFC 6052
  `prefix` length, a UUID `boot_id`, 32-hex `invocation_id` and `generation`;
- `boot_id` is this boot and `state` is `up` with a prefix and a TUN ifindex;
- on CLOCK_BOOTTIME (`/proc/uptime`, suspend included)
  `0 <= observed_at <= now < expires_at`, with `expires_at - observed_at == 30`.
  Future observations are rejected. Expiry uses the upper end of the 10 ms
  `/proc/uptime` quantum, so truncation cannot extend the lease.
  `updated_at` is diagnostic only. `last_error` alone does not reject an `up`
  lease;
- `ceralive-clat.service` is active and running with a live MainPID, and its
  InvocationID is the snapshot's `invocation_id`;
- the file index, `ifindex` and the modem interface's current kernel ifindex
  agree, and that interface resolves to a known modem;
- the TUN is administratively up with exactly `tun_ifindex`.

The cached view keeps each lease's `expires_at`, and `clatTranslationFor`
re-checks it against CLOCK_BOOTTIME at every bond read, so an expired lease
drops out before the next poll and reading never renews it. A translation's
generation includes boot, invocation, `generation`, both ifindices, the parent
name, translated IPv4 and physical modem key; a changed
generation withdraws the link for one poll before it is offered again, so the
sender's reload path sees a withdrawal, never a silent swap. A poll that changes
the set offered to the bond republishes the interfaces.

`isBondCandidate` admits a `clat<N>` interface only while such a translation
exists for it with the same IPv4, and never while its modem interface is opted
out of the bond. The bond entry carries the TUN as its interface, so the sender
binds the translated IPv4 to the TUN, as the image contract specifies. A
dual-stack link keeps its native IPv4 path: the service creates no TUN for it.

The wire projection hides translator rows and puts their address, eligibility
and counters on the parent modem. Bond entries use the parent's physical link
identity with the TUN as bind device. `clatGeneration` is private writer metadata:
it participates in mapping equality and advances the existing sidecar generation;
it adds no sender schema or remote-status field. Queue removals cannot be
superseded by later admissions. The writer rechecks snapshot, live unit, parent
identity and TUN topology after queued work and before writing, including retries.
The TUN suffix accepts a positive kernel ifindex through ten decimal digits.
