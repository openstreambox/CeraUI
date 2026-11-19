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

`modules/wifi/wifi-network-diversity.ts` owns the fix:

- **The operator's choice is the preferred network.** A successful join or
  connect from CeraUI sets `connection.autoconnect-priority` to
  `WIFI_CHOSEN_NETWORK_PRIORITY` (10, below the hotspot's 999) on that radio's
  profiles for the chosen network and resets the radio's other profiles that
  carry exactly that value to 0. Other priorities are left alone. The mark
  persists in NetworkManager and makes it pick the chosen network first at boot.
- **Without a mark**, the preferred network is the last one that radio held
  without a sibling on it during this run.
- **Every 10 s**, a station radio that shares its network with another radio is
  moved back (`nmcli conn up` on its own profile, under the adapter lock) when its
  preferred network differs, is saved on it, and no other radio holds it. If the
  network is not in the scan results, only that radio is rescanned first: the
  scan stall lands on the link that duplicates a sibling's uplink. Retries back
  off from 15 s to 120 s; a busy adapter lock skips the turn.
- **No-ops by design:** single-radio boxes, radios in AP mode, radios whose
  preferred network is the shared one (the operator chose one network for both),
  and unmarked radios with no memory from this run.

Limits: scan results are merged across radios (`nmcli device wifi list` has no
per-device column here), so "visible" means seen by any radio; a failed move
costs the duplicating link a reconnect. Networks are distinguished by SSID, so
two access points sharing one SSID are not told apart.

Tests: `tests/wifi-network-diversity.test.ts`.
