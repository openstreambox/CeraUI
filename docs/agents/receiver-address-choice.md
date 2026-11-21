## RECEIVER ADDRESS CHOICE AT STREAM START [EXISTS]

A receiver name can resolve to several addresses (a round-robin pool, a move
between hosts, a stale record). Every stream start (operator Start, autostart,
restoration, automatic restart, SRT forward) resolves it in
`apps/backend/src/modules/streaming/srtla.ts` (`resolveSrtla(addr, port)`).

- With two or more answers in the bond's family, the device asks each answer
  over every bond uplink whether a bonding receiver is there
  (`receiver-target.ts`: a REG2 with a random group id; the receiver answers
  REG_NGP and keeps no state) and hands the sender the first answer in DNS
  order that replied, as an IP literal. Every link then dials that address.
- The probe waits at most `RECEIVER_PROBE_DEADLINE_MS` (1.2 s) and returns as
  soon as the choice cannot change, so a live first answer costs one round trip.
- Nothing answering never means "down": the start keeps its previous
  behaviour (the name for a live lookup, a random cached address after a
  failed lookup). One answer, an IP literal, a call without a port and mock
  mode are never probed.
- Each probe makes the BELABOX receiver log one "connection registration for
  group (nil) failed" line.
- A literal turns off the sender's own DNS re-home for that session. Moving a
  session that registered and then lost its receiver is a separate step; the
  choice here runs again on the next start.

Tests: `receiver-target.test.ts` (choice rules, real loopback sockets),
`src/tests/receiver-target-resolve.test.ts` (start-path wiring, cache path,
IPv6), `src/tests/receiver-target-netns.test.ts` (real routes, c-ares and a DNS
stub in a private user/network namespace; skips only without user namespaces).
