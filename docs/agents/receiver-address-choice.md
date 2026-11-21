## RECEIVER ADDRESS CHOICE AT STREAM START [EXISTS]

A receiver name can resolve to several addresses (a round-robin pool, a move
between hosts, a stale record). Every stream start (operator Start, autostart,
restoration, automatic restart, SRT forward) resolves it in
`apps/backend/src/modules/streaming/srtla.ts` (`resolveSrtla(addr, port)`).

- With two or more answers in the bond's family, the device asks each answer
  over every distinct bond source address whether a bonding receiver is there
  (`receiver-target.ts`: a REG2 with a random group id; the receiver answers
  with a 2-byte REG_NGP from the probed address and port and keeps no state).
- Live lookup: the sender gets the **name** unless the first answer in DNS
  order stayed silent and a later one answered; only then does it get that
  later answer as an IP literal. A live first answer is what the sender dials
  anyway, and the name keeps the sender's own DNS re-home for a later cutover.
  A dead first answer never registers with the name, so the literal loses
  nothing that worked.
- Failed lookup: a cached answer that replies is used instead of a random
  cached one (the cache path always handed over a literal).
- The probe returns as soon as the choice cannot change; a silent first answer
  costs at most `RECEIVER_PROBE_DEADLINE_MS` (1.2 s). The second REG2 goes out
  400 ms later only if that socket is still waiting. Nothing answering keeps
  the previous behaviour. One answer, an IP literal, a call without a port and
  mock mode are never probed.
- A literal chosen for a name keeps the name's identity
  (`configuredReceiver(addr)`): bond admission in `prepareSrtlaIpAddresses`
  (a private receiver reached over the bond is not a local-subnet receiver)
  and the relay-session key for the busy retry. Resolving a configured
  literal clears that mapping.
- Twin links that share one source address are asked once, along the kernel's
  route for that address. A miss falls back to the previous behaviour.
- Each REG2 makes the BELABOX receiver log one "connection registration for
  group (nil) failed" line, so the device asks only at starts.

Tests: `receiver-target.test.ts` (choice rules, synchronous failures, real
loopback sockets: wrong port, echo, IPv6, unowned source, abort before bind),
`src/tests/receiver-target-resolve.test.ts` (start-path wiring, admission of
a chosen private address, cache path, dual stack, IPv6),
`src/tests/receiver-target-netns.test.ts` (real routes, c-ares and a DNS stub
in a private user/network namespace; required in the CI netns lane, skips
elsewhere only without user namespaces).
