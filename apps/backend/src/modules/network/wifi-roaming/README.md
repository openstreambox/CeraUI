# Coordinated Wi-Fi roaming

Station-based roaming for the SRTLA bond across every network the box can use:
several client radios, any mix of APs and SSIDs, and the aim of a gapless
stream. NetworkManager stays the only connection manager. The coordinator
decides which radio may scan or join, and when.

## Roles

Each client radio has a role:

| Role | Carries traffic | May scan or join |
|---|---|---|
| holder | yes | never by CeraUI (see "Not yet" for NetworkManager's own background scan) |
| assister | yes | only after leaving the bond |
| searcher | no | yes, one radio at a time |
| standby | no (associated, verified) | no |
| hotspot-reserved | serves the phone hotspot | never touched |

Nothing in the model assumes two radios. A third client radio is another
searcher or assister.

A radio is hotspot-reserved when it is configured that way, and also while it
or another interface on its phy (the `clap-` AP leg of a hybrid radio) is in
AP mode. The mode is read every round, and again with a dedicated `iw dev`
read right before each scan and right before each activation (after the
profile work), under CeraUI's per-adapter Wi-Fi lock that hotspot changes
hold. A read that fails refuses the action. When the hotspot stops, the radio
becomes a searcher again.

A phy that runs AP and station at once keeps its station. When an AP leg
appears next to a station the coordinator joined, that station is left
exactly as it is, carrying or still verifying, and is picked up again when
the AP goes; meanwhile the other radios search as usual. Only a clone the AP
has already replaced is removed. Every removal of an owned clone runs under
the adapter lock after a fresh look. Nothing is removed while the
active-profile listing cannot be read: unreadable is never treated as "not
active". On a holder, a reserved radio or a radio with an AP on its phy, a
clone is removed only on positive evidence that it is no longer the active
connection. A join removes the radio's earlier clone only after its last
check before activation. Anything that has to wait is retried later. A clone is treated as gone only when
its BSSID or activation changed, never because a lease renewal left it
briefly without an address; a holder keeps its role through that too, and a
radio associated without an address is not idle.

## What runs today

- **Search triggers** (`policy.ts`). A holder that fades (signal, signal slope,
  delivered rate against the encoder rate, loss) expedites a search for
  continuity. A holder with headroom allows a proactive search for path
  diversity. An idle radio may search at any time, because it carries nothing.
  When searches keep finding nothing, the proactive cadence backs off. Idle
  radios take turns, least recently searched first, and a radio whose scan
  failed rests for 20 s, then 40, 80 and 120 s, so one broken radio cannot
  take every turn. A radio that shares a phy with a holder never scans.
- **Candidate choice.** A candidate is a BSSID from the searching radio's own
  scan on a network it has a saved, interface-bound profile for. It must not
  be a holder's BSSID and must be no more than 10 points weaker than the
  holder's. The holder's own SSID is no exception: a profile bound to a
  sibling radio does not make it joinable. On a fade the strongest one wins.
  With headroom, a path on a different uplink wins, as learned from earlier
  joins. A BSSID whose join or verification failed in the last 10 minutes goes
  behind every other candidate; alone, it is retried.
- **Uplink identity.** After a join, a path is compared with the holders' by
  gateway MAC, gateway and subnet, and egress address when known. The result
  is same-uplink, distinct-gateway or diverse. One SSID can front several
  routers and two SSIDs can share one, so the SSID is never used for this.
  The same gateway address and subnet without both gateway MACs is unknown,
  not one uplink, because factory-default routers share them. Each BSSID's
  identity is remembered for 30 minutes and compared with whichever radios
  hold at the time of the next search. A gateway MAC carries the time it was
  really observed: filling a missing neighbour entry from it never makes it
  younger, and a MAC older than 30 minutes is not used.
- **Join** (`nm-port.ts`). The coordinator makes an in-memory clone of the
  radio's own profile, locks it to the BSSID, turns autoconnect off and
  activates it on that interface. With a BSSID set, NetworkManager adds no
  background scan and the supplicant does not roam. The operator's profiles
  are not changed.
- **Verification.** The joined radio must show the BSSID, its owned
  activation, a lease, a gateway and a default route within 15 s. Otherwise
  the clone is removed and joins cool down for 20, 40, 80, then 120 s.
- **Losing the holder mid-search.** A holder that loses its AP while another
  radio scans, joins or verifies does not cost that replacement. The search
  goes on, the joined radio is verified at once and promoted to holder. Only a
  holder that moves to another BSSID during a scan discards that scan.
- **Assist mode.** When nothing new is found, the holders have not moved
  (steady BSSID and signal for 60 s) and the bond has no other uplink, an idle
  radio joins the best BSSID, the holder's own included, to add capacity. It
  is recalled to search when a fade starts. With headroom it is also recalled
  to look for a diverse path.
- **Gates.**
  - `scan-gate.ts`: CeraUI's own rescans skip holders, assisters, the
    hotspot radio, a radio that is searching or joining, and every radio on
    the phys those use. The set is republished on every role, hold or
    ownership change. Each rescan of a radio goes out under its
    owner-resolved adapter lock after a fresh, fail-closed read of its mode
    and phy. The scan RPC holds that lock across the dispatch and says so
    (`underHeldLock`), so its own radio's scan goes out inline under it,
    re-checked right before the scan; every other rescan contends for the
    lock, including one a lock holder starts without awaiting (hotspot
    teardown). So a named scan of an eligible radio really runs, a busy radio
    is reported as busy, and no scan escapes a released lock.
  - `bond-hold.ts`: a radio leaves the SRTLA bond while it searches.
  - `ownership.ts`: other Wi-Fi automation leaves coordinator-owned radios
    alone. A radio in hotspot use is not coordinator-owned.
  - `radio-lock.ts`: scans and joins run under CeraUI's per-adapter Wi-Fi
    lock and are skipped while another operation holds it. A radio is
    admitted the way every Wi-Fi mutation admits one:
    - only a verified, currently published identity row under exactly one
      registry entry for its name qualifies;
    - its owner-resolved lock is taken;
    - under that lock, a fresh sample must show the same permanent MAC and
      lifetime.

    A Limited, Unverified, unpublished or replaced radio is not acted on.

## Proof and swap: the pieces (not wired yet)

These pure parts of the next step exist and are tested; the coordinator does
not call them yet.

- `sender-links.ts` reads the sender's per-link arrival reports
  (`srtla_ack_entries_total`, `data_packets_queued_total`,
  `last_srtla_ack_age_ms`, `srtla_ack_epoch`) and its health flags from
  `get_stats`, and maps links onto radios by interface, else by source
  address. The arrival field names come from an unmerged upstream proposal
  and are read only here. Without them there is no snapshot, and the
  coordinator behaves as before.
- `proof.ts` judges a link over a span of one connection epoch. A candidate
  passes when its ACK entries, read a round trip later, reach 0.95 of the
  packets queued on it, minus one receiver batch for the whole span. It must
  also clear these checks:
  - at least 3 s and 60 packets;
  - no busy second without arrivals;
  - a fresh last ACK for its rate;
  - congestion-control loss under 2 %;
  - an RTT within a quarter of the SRT latency;
  - at least its share of the bond;
  - the sender's capacity estimate at 1.25 times the encoder rate, when it
    gives one.

  The sender holding a link back (stall gate, weak, sole-carrier, in-flight
  cap) makes a candidate's span inconclusive but fails a holder. A holder
  with no ACKs while another link still gets them is dead. A holder below
  0.90 is fading. This proves the offered share, not spare capacity.
- `swap-op.ts` runs one holder/candidate swap through the two-radio reducer.
  - It uses one reducer state per operation, with explicit timings: a 30 s
    operation, a 10 s linger, and a 2 s emergency promotion.
  - One challenge covers a whole proof span. Renewals every second keep a
    passing candidate's proof alive through the linger.
  - The receiver is treated as the common cause only when a link outside
    the pair failed too.
  - A command the coordinator cannot confirm from evidence in time aborts.

## Not yet

These come in later parts:

- Wiring the proof and swap into the coordinator: promotion as a relabel that
  moves scan protection, with a hold-out of the old holder only when it dies,
  fails hard or is needed to search, and the abrupt-loss relabel.
- Boot wiring and configuration, with the preconditions it needs: IPv6-only
  paths counted as associated, `stop()` fenced against a round in flight, a
  startup sweep of leftover `ceraui-search-*` profiles, and radio state keyed
  by incarnation rather than by interface name.
- The first holder is whatever NetworkManager activated with the operator's
  profile. Without a BSSID lock, NetworkManager gives it a background scan
  every 30 s below -65 dBm on a multi-AP network. `status()` reports
  `bssidLocked` per radio so this is visible until holders are locked.
- The egress-address observer. Until it exists, `distinct-gateway` is not
  proof of a diverse uplink (double NAT, per-VLAN router MACs) and must not
  decide a promotion.

The two-radio reducer in `../two-radio/` holds the reference safety rules for
the swap. They are one departure at a time, holders never depart, a proof is
bound to its path and expires, traffic comes before demotion, and the old
holder lingers. Its two-slot types are why this module keeps its own
radio-keyed roles.

## Tests

```sh
bun test apps/backend/src/modules/network/wifi-roaming/ apps/backend/src/tests/wifi-rescan-holder-gate.test.ts
```

`proof.test.ts`, `sender-links.test.ts` and `swap-op.test.ts` cover the
pieces above on synthetic snapshots and a fake clock. The cases include:
- a 10 s linger completing, where the reducer's 5 s default would abort it;
- ack deadlines;
- the emergency promotion at exactly 2 s;
- the common-target witness;
- the 87 % threshold at 3 s and 40 pkt/s;
- low-rate spans;
- bufferbloat;
- the asymmetric holder rules.

The coordinator tests run a fake world of radios, APs, routers and a clock.
They cover these cases:

- a shared-AP start;
- steady and fading holders;
- three radios, and a lost holder;
- no candidate, failed joins and wrong landings;
- a holder that moves during a scan, and a scan that overruns its budget;
- one SSID on two routers, and two SSIDs on one router;
- assist mode;
- a holder lost during a scan, a join or verification;
- the holder's SSID without a bound profile, and a BSSID that keeps failing;
- a client radio switched to hotspot, an AP leg on its phy, a hotspot that
  starts right before a scan, and a busy adapter lock;
- idle radios taking turns, and one radio whose scans fail;
- learned uplinks judged against a new holder, and their expiry.
