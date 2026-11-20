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
    ownership change. Each rescan of a radio is admitted like a coordinator
    action (below) and goes out under the owner lock its row resolves to,
    after a fresh, fail-closed read of its mode and phy and then a fresh
    sample confirming the same radio and lifetime, then a synchronous re-check
    of the protection against the name and phy that read saw, with no await
    before the scan. A radio without a verified
    identity is not scanned while the gate is active; a request naming a radio
    no row answers to scans nothing; a scan NetworkManager refuses is not
    reported as run. The scan RPC holds that lock across the dispatch and says so
    (`underHeldLock`), so its own radio's scan goes out inline under it,
    re-checked right before the scan; every other rescan contends for the
    lock, including one a lock holder starts without awaiting (hotspot
    teardown). So a named scan of an eligible radio really runs, a busy radio
    is reported as busy, and no scan escapes a released lock.
  - `bond-hold.ts`: a radio leaves the SRTLA bond while it searches. The hold
    is part of bond admission (`admitsBondLink`) and of the same-subnet list a
    LAN receiver gets, so no sender list or last-uplink check counts it.
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
    The admission travels with the action: the NetworkManager port binds a
    join to the profiles pinned to the admitted permanent MAC (never the
    name's current, possibly randomized address) and confirms the radio again
    right before each scan and activation, so a replug under the same name
    gets neither the scan nor the clone. The admission ends with the action:
    work the action started without awaiting gets none once it has returned,
    and every profile write after an await checks that the action still runs
    and owns its lock. Verified twins (two radios with one
    permanent MAC, registered as `MAC@port`) are refused like Limited radios:
    the shared admission accepts bare-MAC rows only, as the network-diversity
    check and the two-radio adapter do.

## Proof and swap: the pieces (not wired yet)

These pure parts of the next step exist and are tested; the coordinator does
not call them yet.

- `sender-links.ts` does three things:
  - It reads the sender's per-link arrival reports (`srtla_ack_entries_total`,
    `data_packets_queued_total`, `last_srtla_ack_age_ms`, `srtla_ack_epoch`)
    and its health flags from `get_stats`. The arrival field names come from
    an unmerged upstream proposal and are read only here. Without them there
    is no snapshot, and the coordinator behaves as before.
  - It maps links onto radios by interface, otherwise by source address.
  - It turns the sender's flags into what they mean for each role:
    - A candidate is *held back* by the stall gate, the sole-carrier
      election, or a weak flag.
    - The sender has *given up* on a holder's path with the stall gate, the
      sole-carrier election, a high-RTT weak flag, or degraded CC loss.
    - It merely *prefers a sibling* for a holder that is weak for another
      reason, such as `low_share` or `no_traffic`.
    - The in-flight cap is a per-tick queueing bound on any loaded link and
      plays no part.

  It also has the evidence predicates for acks. A hold-out is confirmed when
  no link maps to the radio, not even ambiguously, within 5 s. A restore is
  confirmed by a new epoch, registered, with a first ACK, within 10 s.
- `proof.ts` judges a link over the shortest trailing span of one connection
  epoch that reaches 3 s and 60 packets. That is 3 s at 20 pkt/s and up, and
  at most 10 s for a slower link.
  - A candidate passes when its ACK entries, read a round trip later, reach
    0.95 of the packets queued on it, minus one receiver batch for the whole
    span. It must also show:
    - no busy second without arrivals;
    - a fresh last ACK for its rate;
    - congestion-control loss under 2 % and not degraded;
    - an RTT within a quarter of the SRT latency.
  - A candidate offered less than 0.75/N of the bond, or measured while the
    bond carries under half its pre-fade rate, is inconclusive, not failed.
  - Headroom comes from the sender's capacity estimate, in three cases:
    - at least 1.25 times the encoder rate is an estimate;
    - a target at the CC's climb clamp (about twice what the link carries)
      only says it is capped by its share, and doesn't count against it;
    - a target below both fails only once the CC has settled (`holding`,
      `backing_off`, `drain`). While it is still climbing, as when a fade
      shifts load onto the candidate faster than the target rises, the proof
      says "climbing" instead.
  - Two checks fail open: the latency cap without a negotiated latency, and
    headroom without a target or an encoder rate. Each proof records which
    checks ran and the load it was taken at.
  - A held-back candidate is inconclusive, and the span restarts.
  - Holders:
    - A holder the sender gave up on fails.
    - A holder the sender only sidelines is inconclusive.
    - A holder with no ACKs is dead while another link still gets them
      within its own rate's bound. "No ACKs" includes a new connection that
      has never had one.
    - A holder below 0.90 is fading.

  This proves the offered share, not spare capacity.
- `swap-op.ts` runs one holder/candidate swap through the two-radio reducer.
  - It uses one reducer state per operation, with explicit timings: a 30 s
    operation, a 10 s linger and a 2 s emergency promotion.
  - One challenge covers a whole proof span. Renewals every second keep a
    passing candidate's proof alive through the linger. A renewal only
    extends a live proof taken under the same sender epoch.
  - The receiver is treated as the common cause only when a link outside
    the pair failed too.
  - A command the coordinator cannot confirm from evidence in time aborts.
  - Every restore it emits gets a 10 s evidence deadline automatically.
  - A restore that can't be confirmed ends the operation as
    `restore-failed`, since the reducer can't abort a cleanup. The
    coordinator then re-releases the hold and treats the old holder through
    the abrupt-loss path.

## Not yet

These come in later parts:

- Wiring the proof and swap into the coordinator: promotion as a relabel that
  moves scan protection, with a hold-out of the old holder only when it dies,
  fails hard or is needed to search, and the abrupt-loss relabel. Points the
  wiring has to respect:
  - Linger renewals must not depend on the headroom verdict. With a hold-out,
    the candidate's share jumps at demotion, and a passing headroom check
    can lag behind. Renew on delivery, continuity, age and the holder-style
    checks.
  - `srtla_ack_epoch` is per sender process. After a sender restart a
    re-added link can repeat its held-out epoch and never confirm, which
    ends as `restore-failed`. That fails safe, through the abrupt-loss path.
  - `candidateProven` answers as of the last event. A status view should
    tick first.
  - The one-batch slack still passes 78 % delivery at the 60-packet floor.
    The bench decides whether to keep it there or raise the floor.
- Boot wiring and configuration, with the preconditions it needs: IPv6-only
  paths counted as associated, `stop()` fenced against a round in flight, a
  startup sweep of leftover `ceraui-search-*` profiles, and radio state keyed
  by physical identity rather than by interface name. Roles, cool-downs and
  bond holds are still kept per interface name, so a radio replaced under the
  same name would inherit them: key them by `physicalWifiAdapterId`, resolve
  the current interface for each hold and effect, confirm in `mayActivate`
  and after each effect before accepting evidence, persist no lock key or
  incarnation, and stand the network-diversity scanner down for
  coordinator-owned radios (it calls NetworkManager directly).
- While the gate is active, a Limited, unpublished or twin radio is not
  scanned and the scan RPC answers `DEVICE_BUSY` for it. Before the wiring
  turns the gate on, decide how the operator sees a refusal that lasts
  (an identity the box cannot verify) rather than a busy radio.
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
bun test apps/backend/src/modules/network/wifi-roaming/ apps/backend/src/tests/wifi-rescan-holder-gate.test.ts apps/backend/src/tests/wifi-rescan-lock-escape.test.ts apps/backend/src/tests/wifi-roaming-bond-hold-lists.test.ts
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
