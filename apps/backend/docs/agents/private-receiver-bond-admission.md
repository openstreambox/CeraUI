# Private receiver bond admission

A receiver address that is a private or link-local IPv4 literal (`isLocalIp`;
a hostname never is, even one starting `10.`) narrows the launch bond; it never
widens it.

- The candidate set is always the user's bond: `isBondCandidate` (per-link bond
  toggle, hotspot and shared-LAN exclusions, pending identity, modem holds).
  `genSrtlaBondEntriesForLocalIpAddress` filters the finished IPv4 bond (one
  row per translated modem, IPv4 sources even when the previous receiver was
  IPv6-only) to rows on the receiver's subnet, so it can drop rows but never
  swap a modem's translator in for its native IPv4.
- When at least one bonded link shares the receiver's subnet, only those links
  are published, and write-time CLAT revalidation keeps the subnet rule
  (`localReceiver`).
- When no bonded link shares it, the receiver may be routed (a venue VLAN behind
  a Wi-Fi gateway, a host route), so the whole bond is published, as for a
  hostname that resolves to the same address. The launch logs a warning that
  names the receiver and any interface on its subnet that is out of the bond
  (an `enx`/`wlx` name keeps only its vendor half, `maskMacDerivedIfname`).
- Only an empty bond refuses a launch (`no_available_network_connections`); a
  live refresh publishes the empty set to withdraw the last link.

Code: `modules/streaming/streamloop/srtla-ip-preparation.ts`
(`prepareSrtlaIpAddresses`), `modules/streaming/srtla.ts`
(`isLocalBondCandidate`, `interfacesOnSubnet`). Tests:
`tests/private-receiver-bond-admission.test.ts`.
