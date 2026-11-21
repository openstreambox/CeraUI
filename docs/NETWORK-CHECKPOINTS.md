# Safe network changes

This holds a network-change owner, a NetworkManager adapter, a journal, an
undo interface for effects outside NetworkManager, arrival-interface evidence,
and the copy for the prompts. One change path is wired to it: the Ethernet port
role (uplink or shared LAN), behind `CERALIVE_NETWORK_CHANGE_SAFETY=1`, which is
off by default and takes effect only on an image with the front door (the
`/run/ceralive-button-ingress` listener). With the flag off, network behavior is
unchanged. No UI uses it yet.

## The idea

A change to Wi-Fi, the hotspot, Ethernet or a modem can cut the connection the
person is using, sometimes on purpose. The box does not treat a lost connection
as a mistake:

- **Ask before** when the change touches the interface this session came in on,
  or when that interface is unknown: "This change disconnects you from the box
  via {via}." Nothing is preselected and nothing is applied before an answer.
  The normal, primary action is "Make the change (undone if I don't confirm in
  {seconds} s)". Keeping a disconnecting change is a deliberate, secondary
  action whose label states the consequence: "I know what I'm doing: disconnect
  me and don't undo it. I may need to switch connection or reset the box to get
  back in." The backend accepts only these two answers; anything else is
  refused, and no answer means the prompt again.
- **No prompt** when the change touches another path. The change still has an
  automatic undo. The creator's own connection confirms it once it still works
  15 seconds after the apply finished.
- **Ask after** when an automatic undo ran because nobody confirmed. The notice
  says "Nobody confirmed this change in time, so the box undid it. Do you still
  want to make it?", with the buttons "Make the change" and "Leave it undone". The notice
  is stored on the box and stays until someone answers it, on any device. Once
  answered, it is gone for everyone. "Make the change" asks before again, so a
  deliberate re-apply is never undone without the person choosing that.

An unknown arrival interface counts as the person's own path. It costs one tap
when the box is unsure, and the box could not accept a confirmation without
that evidence anyway.

## Sessions that cannot confirm

A session without front-door evidence (a relay, a tailnet, a VPN, the front
door's TCP proxy) can never confirm: the box cannot tell it apart from anyone
else on the internet. Asking it to "confirm within 90 s" would promise an undo,
followed by a "Nobody confirmed" notice offering the same dead end. Two things
change for such a session.

**It is told up front whether the change cuts it.** `network-session-route.ts`
asks the kernel for the box's route back to the session's peer (`ip -j route
get`). A directly routed peer depends on that one interface. A tunnel or a
loopback peer depends on every uplink that holds a default route in any table.
The prompt then says "This change will likely cut your connection: the box
reaches you via eth0" (`cut: "cuts"`), or "may interrupt" when the change
touches one of several uplinks (`may-cut`). This is a prediction, not evidence:
it never skips the prompt, never turns a session into "another path" and never
confirms. A route that misses the changed port still gets the "may disconnect
you" prompt.

**It gets a confirm flow it can actually complete: keep if the box can still
reach the internet.** The primary action for such a session is "Make the
change, kept only if the box still reaches the internet after {settle} s"
(`keep-if-reachable`). It runs inside the same checkpoint and candidate as any
protected change. After the 15 s settle time, each 5 s tick the box opens fresh
TCP connections to the endpoints a remote owner's way back depends on: the
relay endpoint it dials, the pinned device-control hub and, when `tailscale0`
exists, the tailnet's coordination server. Two successes in a row, at least
5 s apart, commit the change exactly like a confirmation (`CheckpointDestroy`,
then promotion and the role write). A failed probe resets the count. If the box
cannot get out by the deadline, NetworkManager undoes the change and the notice
says "The box lost its internet connection after this change, so it undid it."

The alternative stays available: "Make the change, undone after {seconds} s
unless someone on eth0 confirms" (or "on site" when the box can't name the
port). The deliberate answer for such a session reads "Make the change with no
undo. If it cuts the box off, someone has to fix it on site.", without claiming
a disconnect it can't know about. With no endpoint configured there is nothing
to probe: keep-if-reachable is not offered and is refused if sent.

Why this and not "confirm from a new remote session": a new remote session
proves only that some path to the box exists, which is what the box can check
itself without waiting for a browser to reconnect, and without trusting a
session that has no arrival evidence. Keep-if-reachable proves the box's own
outside reachability, not that a particular person can reach it. That is why a
session on the changed port (front-door evidence names it) is never offered it,
and why the flag requires the front door: without it a laptop on the shared LAN
would look like a remote session.

## How a change runs

| Step | What happens |
| --- | --- |
| Journal | `network-change-journal.ts` writes the plan and the transaction to `/data/ceralive/network-change/journal.json` (0600 in a 0700 directory, fsync, rename) before anything changes |
| Checkpoint | NetworkManager `CheckpointCreate` over the profiles' interfaces, 90 s, no flags. `DELETE_NEW_CONNECTIONS` is not used: it deletes every profile created anywhere during the window (a Wi-Fi network joined meanwhile, another port's profile). The owner removes its own candidates. Effect-only changes have no checkpoint and use the journaled deadline |
| Candidates | Each edited profile, active or dormant, duplicates included, is cloned with `nmcli connection clone --temporary` under a `ceralive-candidate-…` name, with autoconnect off. Only the clone is edited. The original on disk is never touched before confirmation |
| Effects | Each effect driver reads the current state and returns its undo record. The record is journaled, and only then is the effect applied |
| Activation | Candidates for live profiles are activated on their interface |
| Confirm | Over the changed interface: a signed-in session opened after the apply, never the old one. On another path: the creator's connection after the settle time. Then `CheckpointDestroy`, and each candidate is saved to disk under the original's name and autoconnect. The original is deleted. The live connection stays up, with no second activation |
| Deliberate "don't undo it" | No checkpoint. Candidates are promoted at once. Each original stays on disk as an inactive `ceralive-backup-…` profile, and the undo records stay in the journal. Any signed-in connection can run that undo until the next change retires it |

On timeout, NetworkManager rolls the checkpoint back by itself (reactivating
the originals; the inactive candidates stay in memory until the owner removes
them). The owner then removes any leftover
candidate, replays the undo records in reverse order, reactivates originals and
writes the ask-after notice. The same undo runs on `reconcile`:

| When | Result |
| --- | --- |
| NetworkManager's bus name gets a new owner (restart) | Unconfirmed change undone at once. The candidate reloaded from `/run` is deleted, so nothing is orphaned |
| Backend start, same boot, checkpoint still live | Resumed: NetworkManager still holds the timer |
| Backend start or boot otherwise | Undone, notice "The network restarted before you confirmed, so the box undid it." If the box restarted before the apply finished, the notice says the change was never made (`interrupted`) |
| Crash or failed write after the confirmation's checkpoint destroy | Rolls forward to finish the promotion; the tick retries it and the status shows `commitIncomplete`. If the candidate is gone before it reached disk (a reboot), the originals are intact, so the change is undone with a notice that the confirmed change was not saved (`unsaved`) |
| Crash or failed intent write on the deliberate answer | The kept change stays unsettled; the tick and the next start finish it (or undo it with the `unsaved` notice, if it never reached disk). The caller gets `kept` with `saving: true` and a pending frame, not a failure |
| An undo step fails | The record stays as "undo incomplete" with its errors in the status (`problem`). The tick retries after 5 s, doubling up to 5 minutes, and logs each attempt; a restart retries at once |
| The journal is unreadable | Every protected change and every role write to any port is refused with `change_in_flight`; the status reports `journalUnavailable`. The warning is logged once (again only when it changes or every ten minutes). `network.resetChangeJournal` moves an unreadable journal aside (kept next to it) and reconciles; a readable one is never moved |

Any `ceralive-candidate-…` profile the journal does not name (a crash between
clone and journal write) is deleted by the same sweep.

## The Ethernet port role (first wired path)

Switching a port between uplink and shared LAN rewrites `ipv4.method` on the
profile the port runs. A box managed over its wired uplink loses that session
when the port becomes shared LAN; a laptop on the shared LAN loses it the other
way round. With the flag on, `network.setEthernetRole` hands a real role change
on a port with an active connection to the owner:

- The plan edits only `ipv4.method` on the active profile, as a candidate
  activated on the port. For the profile CeraUI created for that port, the
  role's autoconnect is written on promotion.
- The role and the owned-profile reservation are persisted only when the change
  is committed (confirmation, roll-forward or the deliberate answer). An
  unconfirmed change therefore leaves nothing for the boot role reconciler to
  re-apply. Promotion gives the profile a new UUID, and the reservation follows
  it.
- A pending change publishes the `eth_role` pending frame. The terminal frame
  comes when the change settles: success on commit, `apply_failed` when it is
  undone. A change that fails during its apply returns the error with no frame.
- These stay on the existing path: re-stating the current role, and a port with
  no active connection (no session can ride it, and creating the shared profile
  there is not a cut).
- While a change in flight names the port (anything but a fully settled kept
  change), the role reconciler skips the port and legacy role writes to it are
  refused with `change_in_flight`, so nothing edits the owner's candidate.
- "Make the change" on a stored role-change notice plans the change again from
  the port's state now, through `setEthernetRole` (and so its queue), asked
  before again. It never replays the stored plan, whose profile or previous
  role may be stale.

The arrival interface comes from the front door's local ingress evidence
(`ingressPath`, rechecked with `ingressPathValid()`). A session without it is
"unknown": it is asked before, cannot confirm, and is offered keep-if-reachable
(see "Sessions that cannot confirm"). Each WebSocket carries its own session id
and open time, so a reconnect is a new session.

Requests to the owner are queued, one at a time: a confirmation that lands
during a tick waits for it instead of failing with "busy". The tick alone skips
a turn when something else runs. While a stream is live, the prompt carries
`liveKey` ("an undo at the deadline can drop the stream for a moment"); the
undo itself is never deferred.

At backend start the owner reconciles before the role reconciler runs, and a
5-second tick undoes a change whose deadline passed or whose checkpoint vanished
(a NetworkManager restart). Both run whenever a journal exists, even with the
flag off, so turning the flag off cannot strand a pending change.

RPC: `network.setEthernetRole` takes an optional `changeAnswer`
(`undo-automatically`, `keep-if-reachable` or `keep-change`) and may return
`changeSafety` (the ask-before prompt with `cut`, `canConfirm`, `primary`,
optional `alternative` and `deliberate`; `pending` with its id and deadline; or
`kept`, with `saving` while the save is unfinished). `network.getChangeSafety`
reads the journal (`pending.confirmBy` is `session` or `reachability`), and
`network.confirmChange`, `network.undoKeptChange`,
`network.answerChangeNotice` and `network.resetChangeJournal` act on it.

## Arrival-interface evidence

Bun.serve exposes the peer address and port but not the arrival interface, and
it cannot adopt a socket bound with `SO_BINDTODEVICE`. A destination address is
not evidence: Linux accepts a packet for any local address on any interface. An
nftables input rule (`network-ingress.ts`) adds `peer address . peer port .
iifname` to a timed set when a new connection to the UI port arrives. The lookup
accepts exactly one interface. No entry, or several (a reused or spoofed source
port), means unknown. It uses a set because uplink steering owns all 32 bits of
the conntrack mark.

## What the isolated contract proves

`scripts/integration/network-checkpoint-contract.sh` runs a real NetworkManager
(1.52.1 on Debian trixie) and a private system D-Bus in a disposable container,
with dummy and veth interfaces and synthetic addresses. It drives the owner
through `network-change-contract.ts`. The hotspot and modem effects are
file-backed stand-ins behind the undo interface. No radio, modem or hotspot
command is issued. It prints `BOUNDARY` lines for the stock behavior the design
works around, and `PASS` lines for:

- ask before: an own or unknown path returns the prompt, with the protected
  change as the primary action and nothing preselected, and changes nothing;
- dormant duplicates are edited only as candidates; expiry leaves the originals'
  files byte-identical; confirmation promotes both under their name and
  autoconnect;
- a NetworkManager restart leaves no dormant or active candidate, reactivates
  the original and replays the hotspot and radio undo;
- a timeout and a simulated reboot (cleared `/run`, new boot id) replay the
  undo records, and the notice is kept until answered;
- a confirmation from a new session over the changed interface promotes the
  candidate to disk, without reactivation, and survives a restart. The creator,
  another path and an unknown interface cannot confirm;
- the deliberate "don't undo it" answer survives the deadline and a restart, and its recorded undo
  restores the profile (same UUID and settings) and the effects from another
  connection;
- the Ethernet role plan (uplink to shared LAN): an unconfirmed switch is
  undone with the profile files unchanged, and a confirmation from a new
  session over the port writes shared mode to disk and survives a restart;
- a request to wan0's address routed in over lan0 is attributed to lan0.

Run it only in a disposable container with no device passthrough and no host
system-directory mounts, with `NET_ADMIN` and `SYS_ADMIN` (for one client
network namespace). Install NetworkManager, D-Bus, systemd's `busctl`,
iproute2, nftables, jq, curl, dnsmasq (for shared mode) and bun. Set `NM_CHECKPOINT_CONTRACT=1` and run the
script as container root. The script refuses radio devices and physical
interfaces.

The TypeScript unit tests use the ordinary runner with
`--parallel=1 --max-concurrency=1`.

## Limits

- Promotion gives the profile the candidate's UUID. Callers that store profile
  UUIDs must remap them (the owner journals both).
- Between a NetworkManager restart and the reconcile it triggers, the candidate
  can carry traffic for a moment.
- If the backend is down when the deadline passes, NetworkManager still rolls
  back its part. Effects outside NetworkManager are undone when the backend
  starts again.
- A cut on another path that shows up later than the 15-second settle time is
  not caught.
- Undoing a kept change rewrites the original's keyfile. The settings and UUID
  are the same, but the bytes may differ.
- The journal can hold a new passphrase from a plan, so it uses NetworkManager's
  own keyfile permissions.
- While an Ethernet role change is pending, the persisted role (and so the bond
  gate's view of the port) is still the old one. It catches up on commit.
- A session with no front-door evidence still cannot confirm. It completes a
  change through keep-if-reachable, which proves the box's outside
  reachability, not the person's own path. A remote owner whose only way in is
  an inbound port forward to the changed uplink is not covered by the probe.
- The route back to a session is read from the routing table when the prompt is
  built. Policy routing that picks a different uplink per flow can make the
  "cuts" prediction wrong in either direction; it only changes the message.
- Probe endpoints are reached by name, so a probe needs working DNS on the new
  configuration. A box whose resolver depends on the changed uplink is reported
  unreachable and undone, which is the safe direction.
- Checkpoints are matched by D-Bus path and NetworkManager's `Created` stamp. A
  foreign checkpoint reusing the path after a restart is neither rolled back
  nor destroyed; the change is undone as a restart.

## Before wiring more paths or turning the flag on

1. Device-facing drivers for hotspot-interface teardown and modem radio-mode
   writes, with idempotent undo, and their own isolated tests.
2. Arrival evidence beyond the front door: the front door covers direct
   on-link sessions. The nftables set (`network-ingress.ts`) remains an option
   for sessions that do not pass through it.
3. RPC and UI: the ask-before prompt, the confirm banner, the ask-after notice
   broadcast to every connection, and the kept-change undo. All copy keys exist
   under `network.changeSafety.*` in every catalog. The ask-before dialog shows
   `primary` as the main button and `deliberate` as a visibly secondary one. It
   opens with focus on the message, not on a button, so Enter alone chooses
   nothing. The deliberate button's full label is its accessible name, so the
   consequence is heard before it can be activated.
4. Run `reconcile` on NetworkManager's bus `NameOwnerChanged` and from a boot
   unit after NetworkManager. Backend start and the tick are wired.
5. Make asynchronous station and hotspot completion part of the apply, and
   cover every mutation entry point with isolated integration and browser tests.

No image, streaming, hardware or deployment changes are included here.
