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

Output, mode 0600 in `/run/ceralive/wifi-roaming/` (0700):

- `status.json`: replaced each round. Level, state (`observing` or
  `stopped`), what the sender can do (`reachable`, `arrivalReports`,
  `standby`), and per radio: permanent MAC, interface, SSID, BSSID, level,
  slope, condition, decision, blockers, stayers, counts of would-nudges and of
  the radio's own roams. Radios left out are listed with the reason.
- `journal.jsonl`: one line per event (`radio-added`, `radio-gone`,
  `fade-start`, `fade-end`, `would-nudge`, `blocked` when the reasons change,
  `roamed`), keyed by permanent MAC. At most 2,000 lines; past that the newer
  half is kept.

Nothing reads either file back for a decision.

## What a round does

1. One `get_stats` from the sender, mapped onto every interface by `iface` or
   source address (`sender-port.ts`). The capability document is read once
   per connection; `set_link_standby` in its method list means the sender can
   hold a link.
2. The radios (`radio-port.ts`). A radio is considered only through upstream's
   admission (`admitWifiAdapter`): a verified identity row bound to the exact
   registry object, currently published, with a sampled lifetime. Limited,
   Unverified, unpublished, removed or replaced rows, `clap-*` AP legs and
   excluded radios are skipped. NetworkManager's state comes from the registry
   row; the link from `iw dev <if> link` and the phy from `iw dev` (neither
   scans). Admission is taken again after these reads, and a radio that
   changed meanwhile is skipped for the round.
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
| `hotspot`, `hotspot-unknown` | the radio, its phy or its row serves a hotspot, or the phy could not be read (a hybrid radio is reserved whole) |
| `not-a-station` | NetworkManager does not have it activated as a station with an address |
| `not-associated`, `link-unreadable` | no link, or `iw` could not read it |
| `no-sender-evidence` | no sender, or no per-link arrival counters |
| `unmapped-sender-link`, `ambiguous-sender-link` | a sender link maps to no interface, or to more than one |
| `radio-link-not-mapped` | the radio's own link is not among the sender's |
| `no-delivering-stayer` | no other mapped link delivered at least 95 % of what it was offered over a complete span (`proof.ts`) |
| `sender-without-standby` | the sender has no `set_link_standby` (or it is unknown), so no hold would exist |
| `cooldown` | 15 s after a would-nudge, doubling to 10 min while the radio stays on the same access point; 30 s after the radio moved by itself |

A radio's share of the bond is not a fade signal: with several links no radio
carries the encoder's whole rate.

## Guards

`src/tests/wifi-roaming-observe-guards.test.ts` checks every file here, in
every literal style: no command word that changes a radio, a profile or the
network; no NetworkManager or Wi-Fi client member, sender control, exec or
lock; no secret; only reads, the pure modules and these files imported; `iw`
with the interface list or one radio's link as the only command. The
diversity check, the rescan path, bond admission and the sender lists do not
reference this module.

## Tests

```sh
bun test apps/backend/src/modules/network/wifi-roaming/ apps/backend/src/tests/wifi-roaming-observe-guards.test.ts apps/backend/src/tests/wifi-roaming-observe-boot.test.ts
```
