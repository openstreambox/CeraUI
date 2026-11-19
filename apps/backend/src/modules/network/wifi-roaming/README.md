# Coordinated Wi-Fi roaming

Station-based roaming for the SRTLA bond across every network the box can use:
several client radios, any mix of APs and SSIDs, and the aim of a gapless
stream. NetworkManager stays the only connection manager. The coordinator
decides which radio may scan or join, and when.

## Roles

Each client radio has a role:

| Role | Carries traffic | May scan or join |
|---|---|---|
| holder | yes | never on purpose |
| assister | yes | only after leaving the bond |
| searcher | no | yes, one radio at a time |
| standby | no (associated, verified) | no |
| hotspot-reserved | serves the phone hotspot | never touched |

Nothing in the model assumes two radios. A third client radio is another
searcher or assister.

## What runs today

- **Search triggers** (`policy.ts`). A holder that fades (signal, signal slope,
  delivered rate against the encoder rate, loss) expedites a search for
  continuity. A holder with headroom allows a proactive search for path
  diversity. An idle radio may search at any time, because it carries nothing.
  When searches keep finding nothing, the proactive cadence backs off.
- **Candidate choice.** A candidate is a BSSID from the searching radio's own
  scan on a network it has a saved, interface-bound profile for. It must not
  be a holder's BSSID and must be no more than 10 points weaker than the
  holder's. On a fade the strongest one wins. With headroom, a path on a
  different uplink wins, as learned from earlier joins.
- **Uplink identity.** After a join, a path is compared with the holders' by
  gateway MAC, gateway and subnet, and egress address when known. The result
  is same-uplink, distinct-gateway or diverse. One SSID can front several
  routers and two SSIDs can share one, so the SSID is never used for this.
- **Join** (`nm-port.ts`). The coordinator makes an in-memory clone of the
  radio's own profile, locks it to the BSSID, turns autoconnect off and
  activates it on that interface. With a BSSID set, NetworkManager adds no
  background scan and the supplicant does not roam. The operator's profiles
  are not changed.
- **Verification.** The joined radio must show the BSSID, its owned
  activation, a lease, a gateway and a default route within 15 s. Otherwise
  the clone is removed and joins cool down for 20, 40, 80, then 120 s.
- **Assist mode.** When nothing new is found, the holders have not moved
  (steady BSSID and signal for 60 s) and the bond has no other uplink, an idle
  radio joins the best BSSID, the holder's own included, to add capacity. It
  is recalled to search when a fade starts. With headroom it is also recalled
  to look for a diverse path.
- **Gates.**
  - `scan-gate.ts`: CeraUI's own rescans skip every holder.
  - `bond-hold.ts`: a radio leaves the SRTLA bond while it searches.
  - `ownership.ts`: other Wi-Fi automation leaves coordinator-owned radios
    alone.

## Not yet

These come in later parts:

- Proving a path at the stream rate from receiver-acknowledged bytes.
- Promoting a proven path to holder, lingering, then releasing the old holder.
- Boot wiring and configuration.
- The egress-address observer.

The two-radio reducer in `../two-radio/` holds the reference safety rules for
the swap. They are one departure at a time, holders never depart, a proof is
bound to its path and expires, traffic comes before demotion, and the old
holder lingers. Its two-slot types are why this module keeps its own
radio-keyed roles.

## Tests

```sh
bun test apps/backend/src/modules/network/wifi-roaming/ apps/backend/src/tests/wifi-rescan-holder-gate.test.ts
```

The coordinator tests run a fake world of radios, APs, routers and a clock.
They cover these cases:

- a shared-AP start;
- steady and fading holders;
- three radios, and a lost holder;
- no candidate, failed joins and wrong landings;
- a holder that moves during a scan, and a scan that overruns its budget;
- one SSID on two routers, and two SSIDs on one router;
- assist mode.
