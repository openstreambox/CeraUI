# Wi-Fi roaming: the observer

Level `observe` watches the box's client radios and the SRTLA sender. It
records, every second, whether a roaming coordinator would act on a radio,
and why or why not. **It changes nothing**: no NetworkManager profile,
activation, setting or scan, no request to the Wi-Fi client, no bond change,
no sender control. It exists to show, on a real walk, when a fade happens,
what the radio does by itself, and what a coordinator would have done.

## Turning it on

Runtime config (`config.json`):

```json
{ "wifi_roaming": { "level": "observe", "exclude": ["02:00:00:00:00:0a"] } }
```

- `level`: `off` (the default, also when the key is absent) or `observe`.
  `off` does no IO at all.
- `exclude`: permanent MACs of radios to leave out. There is no radio list:
  the client radios are the admitted radios that are not serving a hotspot.
- It does not start next to `two_radio_enabled`.

Output, mode 0600 in `/run/ceralive/wifi-roaming/` (0700; an existing
directory or journal gets these modes back):

- `status.json`: replaced when it changed, and every 10 s regardless. Level,
  state (`observing` or `stopped`), dropped journal lines, what the sender can
  do and how its links map (`reachable`, `arrivalReports`, `standby`,
  `mapping`), and per radio: physical radio id, permanent MAC, interface,
  SSID, BSSID, level, slope, condition, decision, blockers, stayers, counts of
  would-nudges and of the radio's own roams. Radios left out are listed with
  the reason (`not-admitted`, `twin`, `excluded`, `changed-during-read`).
- `journal.jsonl`: one line per event (`radio-added`, `radio-gone`,
  `fade-start`, `fade-end`, `would-nudge`, `blocked` when the reasons change,
  `roamed` with the BSSIDs), with the permanent MAC and the physical radio id.
  At most 2,000 lines; past that the newer half is kept. At most 256 lines
  wait for the disk; past that new events are dropped and counted.

Nothing reads either file back for a decision. **What they keep:** SSIDs,
BSSIDs and the radios' permanent MACs, with times. `/run` is a tmpfs: the
files survive a backend restart and turning the level off, and are gone at the
next reboot or when removed. Copy them off the box for a walk; delete them
when done.

## What a round does

1. One `get_stats` from the sender, mapped onto every interface by `iface` or
   source address (`sender-port.ts`). Only the sender this backend launched is
   read: the streaming module reports it (pid and start time confirmed after
   launch). Before and after the connect, the process must still have that
   start time, its control socket must be a socket of this backend's user, and
   the listener bound at that path (`/proc/net/unix`) must be one the owned
   process holds open (`/proc/<pid>/fd`). Ownership is checked again after
   every read. Without an owned sender nothing connects. Every link of the
   reply, with arrival counters or not, is checked for its mapping, and a
   change of which connection is on which interface starts the spans afresh. The capability document is read once per connection;
   `set_link_standby` in its method list means the sender can hold a link.
   A read that takes longer than 1 s has failed.
2. The radios (`radio-port.ts`). A radio is considered only through upstream's
   admission (`admitWifiAdapter`): a verified identity row bound to the exact
   registry object, currently published, with a sampled lifetime. Limited,
   Unverified, unpublished, removed or replaced rows, `clap-*` AP legs and
   excluded radios are skipped. Verified twins (two radios with one permanent
   MAC, registered as `MAC@port`) are skipped as `twin`: the shared admission
   accepts bare-MAC rows only, as the diversity check and the two-radio
   adapter do. Admitting them is a change to that shared admission, for every
   consumer at once, not to this module. NetworkManager's state comes from the registry row (a station
   is `infrastructure` mode with an address); the link from
   `iw dev <if> link` every round and the phy from `iw dev` at most every 5 s
   (neither scans, and neither leaves a debug trace per call). Every radio's
   admission is taken again after all reads, and a radio that changed
   meanwhile is skipped for the round.
3. The decision (`observer.ts`), pure, state keyed by the physical radio id
   (`physicalWifiAdapterId`), so a radio replugged under the same name starts
   with nothing.

## The decision

A radio's own link fades by slice 1's rule (`policy.ts`): level at or below
-70 dBm, a slope of -1 dB/s or steeper over 10 s, or its CC loss above 5 %.
For a fading radio the observer reports `would-nudge` only when all of these
hold, and otherwise `would-wait` with the reasons:

| Blocker | Meaning |
|---|---|
| `hotspot`, `hotspot-unknown` | an AP is active on the radio (NetworkManager AP mode, an active concurrent AP leg, or AP mode on its phy), or the phy could not be read; a hybrid radio is reserved whole. A radio that merely could serve a hotspot is a client radio |
| `not-a-station` | NetworkManager does not have it activated in infrastructure mode with an address |
| `no-sender-evidence` | no owned sender, no answer, or no per-link arrival counters |
| `sender-evidence-stale` | the sender's state has not moved for 3 s (a sender that answers but hangs) |
| `uncounted-sender-link` | a sender link has no arrival counters, so the bond cannot be judged |
| `unmapped-sender-link`, `ambiguous-sender-link` | a sender link maps to no interface, to more than one, or shares one with another link |
| `radio-link-not-mapped` | the radio's own link is not among the sender's |
| `no-delivering-stayer` | no other mapped link delivered at least 95 % of what it was offered over a complete, unbroken span (`proof.ts`) |
| `sender-without-standby` | the sender has no `set_link_standby` (or it is unknown), so no hold would exist |
| `cooldown` | 15 s after a would-nudge, doubling to 10 min while the radio stays on the same access point; 30 s after the radio moved by itself |

A radio without a link is no candidate; its status says `not-associated` or
`link-unreadable`.

A radio's share of the bond is not a fade signal: with several links no radio
carries the encoder's whole rate.

## Stop

`stop()` (shutdown, before streaming teardown) ends the loop and, within 2 s,
waits for the round in flight, closes the sender client, writes a final
`stopped` status and drains the journal. Then the file writer is sealed: a
write still in progress stops at its next step (a status written to its
temporary file is discarded, not renamed), and a late sender connection is
closed unread.

## Guards

`src/tests/wifi-roaming-observe-guards.test.ts` checks every file here,
nested ones and every script kind included, in every literal and import
style:
- no command word that changes a radio, a profile or the network;
- no NetworkManager or Wi-Fi client member, sender control, exec or lock;
- no secret;
- only reads, the pure modules and these files loaded (static, side-effect,
  dynamic and `require`), and from shared modules only the listed symbols;
- the sender client narrowed to its two reads;
- `iw` with the interface list or one radio's link as the only command, at
  exactly the listed call sites.

The diversity check, the rescan path, bond admission and the sender lists do
not reference this module, and only `main.ts` loads it.

## Tests

```sh
bun test apps/backend/src/modules/network/wifi-roaming/ apps/backend/src/tests/wifi-roaming-observe-guards.test.ts apps/backend/src/tests/wifi-roaming-observe-boot.test.ts
```
