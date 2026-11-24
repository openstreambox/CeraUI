## BONDED WI-FI RADIOS KEEP DISTINCT NETWORKS [PARTIAL — host-tested; hardware validation pending]

CeraUI saves one NetworkManager profile per radio and network, bound by
`802-11-wireless.mac-address`. A box whose radios were each joined to each of
two networks holds profiles for both networks on both radios. When radio A loses
its network, NetworkManager autoconnects A to its saved profile for the network
radio B already uses, and it never preempts that active connection when A's own
network returns. The bond then runs two links over one uplink, and losing that
uplink drops the stream. Interface binding cannot prevent this (the profile is
bound to the right radio), and `autoconnect-priority` alone cannot either
(NetworkManager only consults it when choosing what to activate).

`modules/wifi/wifi-network-diversity.ts` owns the fix. Every automated move tears
down a link that carries traffic, so the trigger is deliberately strict.

- **The operator's choice is the preferred network.** A successful join or
  connect from CeraUI sets `connection.autoconnect-priority` to
  `WIFI_CHOSEN_NETWORK_PRIORITY` (17, a reserved odd value below the hotspot's
  999) on that radio's **own MAC-bound** profiles for the chosen network, and
  resets its other profiles carrying exactly 17 to 0. Unbound profiles are
  shared by every radio, so they are never marked and never a move target.
  Choices are serialized; a radio left with two marks is ignored and logged.
  Choosing a profile CeraUI cannot mark (unbound or unknown) clears the radio's
  marks, so an old mark never undoes that choice.
- **Operator ops win.** The join/connect paths flag the radio before dispatch
  and release it after the choice is recorded; a flagged radio is never moved.
  A choice that finds the adapter lock busy is kept and written on the next
  tick, and the radio is not moved while it waits.
- **Physical identity, not the lock key.** A radio is tracked by the permanent
  MAC and sampled lifetime of its verified identity row
  (`wifi-adapter-admission.ts`); profiles are matched against that MAC. The
  adapter lock key names the current owner, which can be a composite `mac@...`
  hotspot owner, and is used only to take the lock. Every write (choice, move,
  restore, migration mark) runs under the lock the current row resolves to and
  re-checks there that the same registry row, lifetime and owner still hold.
  The join/connect paths admit the radio when the op starts, so a choice is
  never written to a radio that replaced it, even under the same name and MAC.
  A replacement starts with no back-off, parking or pending choice. Limited and
  Unverified radios are never tracked or written.
- **Only the current publication.** A radio is projected only while its
  identity publication is current (`projectWifiRadioIncarnation`). While a
  discovery pass has any sampled row's publication invalidated, the tick is
  deferred with all its state kept, and an operator choice waits in place.
  Right before an activation or a profile write, a fresh bracketed sysfs sample
  of the netif must still show the projected lifetime and MAC, so a replug
  under the same name that discovery has not published yet is never acted on.
- **Truth is NetworkManager's device table**, read each tick and again under
  the adapter lock right before acting (`nmcli device status`, by ifname and
  connection UUID). The registry's `conn` is patched from monitor events by
  connection name across radios and is never used here.
- **A move needs all of:** the radio shares its network with another radio for
  2 consecutive ticks; no radio's link changed in the last 30 s; the preferred
  network is free and its profile not active anywhere; and THIS radio's own
  completed scans (`nmcli device wifi list ifname X --rescan yes`) saw it twice,
  20 s apart, at signal ≥ 40 and not more than 10 below the shared link. The
  merged scan cache is never used: another radio's stale BSS entry can keep an
  absent network listed for minutes. At most one radio moves per tick, with
  `nmcli conn up <uuid> ifname <radio>`.
- **Hysteresis.** A move counts once the radio holds the network for 90 s. A
  quicker revert backs off (60 s doubling to 15 min); after 3 reverts the radio
  is parked until the operator chooses again or the network is 15 points
  stronger. A parked radio is also released when NetworkManager itself puts it
  back on its preferred network and that holds for 90 s. A failed move
  re-activates the fallback profile at once.
- **Scan budget.** Forced scans stall a connected radio for a few seconds on
  some USB drivers, and the duplicating link still carries bond traffic. Per
  episode: three fast scans (30, 60, 120 s apart), then one every 10 minutes.
  A short gap in the duplicate (a sibling blip) keeps the episode's budget; only
  5 minutes out of it, or a move, resets it. The lock is taken only when a scan
  is due. The merged scan list is a hint only: when the preferred network newly
  appears there at signal ≥ 40, the radio gets one early scan, at most one per
  5 minutes (never a move by itself). After a
  long outage without such a hint, the return can take up to about 10 minutes;
  the slow cadence waits for a measured forced-scan freeze on hardware.
- **Upgraded boxes.** Within the first 10 minutes after start, if every
  connected radio has sat on its own distinct network (bound profile) for 2
  minutes and no radio has a mark other than the one profile it is connected
  on, each unmarked radio's active profile is marked. Migration is done only
  when every connected radio carries its mark; a radio that vanishes, a busy
  lock or a failed write leaves the rest for a later tick, and a restart part
  way resumes from the marks already written. Any other mark is an operator's
  choice and ends migration. Otherwise an unmarked radio is left alone; there
  is no in-memory "last network" guess.
- **Never touched:** single-radio boxes, radios in AP mode or running a
  concurrent hotspot (moving the station would drag the AP's channel), and
  radios whose preferred network is the shared one.

Limits: networks are told apart by SSID, so two access points with one SSID
count as one network. Profile priorities are cached per profile; a choice
re-reads the radio's profiles, but an external `nmcli` edit to a mark is seen
only after the profile set changes or CeraUI restarts. Automated moves are
logged, not yet shown in the UI.

Tests: `tests/wifi-network-diversity.test.ts`,
`tests/wifi-network-diversity-ownership.test.ts` (operator join racing a
move-back and an AP reconciliation on one owner lock, discovery in flight,
same-name replug before an effect, replacement radios, Limited radios).
