# Safe network changes

This holds a network-change owner, a NetworkManager adapter, a journal, an
undo interface for effects outside NetworkManager, arrival-interface evidence,
and the copy for the prompts. One change path is wired to it: the Ethernet port
role (uplink or shared LAN), behind `CERALIVE_NETWORK_CHANGE_SAFETY=1`, which is
off by default and takes effect only while the front door's listener (under
`/run/ceralive-button-ingress`) is actually running in this process. With the flag off, network behavior is
unchanged. No UI uses it yet.

## The idea

A change to Wi-Fi, the hotspot, Ethernet or a modem can cut the connection the
person is using, sometimes on purpose. The box does not treat a lost connection
as a mistake:

- **Ask before** when the change touches the interface this session came in on,
  or when that interface is unknown: "This change disconnects you from the box
  via {via}." Nothing is preselected and nothing is applied before an answer.
  The normal, primary action is "Make the change. The box undoes it in
  {seconds} s unless this browser confirms." Keeping a disconnecting change is a deliberate, secondary
  action whose label states the consequence: "I know what I'm doing: disconnect
  me and don't undo it. I may need to switch connection or reset the box to get
  back in." The backend accepts only these two answers; anything else is
  refused, and no answer means the prompt again.
- **No prompt** when front-door evidence shows the change touches another path.
  The change still has an automatic undo. The creator's own connection, still
  on that untouched path, confirms it 15 seconds after the apply finished.
- **Ask after** when an automatic undo ran because nobody confirmed. The notice
  says "Nobody confirmed this change in time, so the box undid it. Do you still
  want to make it?", with the buttons "Make the change" and "Leave it undone". The notice
  is stored on the box and stays until someone answers it, on any device. Once
  answered, it is gone for everyone. "Make the change" asks before again, so a
  deliberate re-apply is never undone without the person choosing that.

An unknown arrival interface counts as the person's own path: it costs one tap
when the box is unsure.

## Who can keep a change

A protected change is kept only when the person who made it proves they can
still reach the box after it. The proof is a **new connection from the same
browser login, to the same UI address, opened at least 15 s after the change,
presenting the one-time code minted for that change, before the deadline.**
The arrival interface is not required; it is recorded and shown ("Kept:
confirmed over eth0", "Kept: confirmed from a remote connection"). One
exception: when front-door evidence placed the requester on an interface the
change does not touch, the requester's own connection may confirm after the
15 s, still with the code. Nothing else keeps a change: no other login, no
tab without the code, no reachability probe by the box.

What each part rules out:

- **New connection after 15 s.** The tab that made the change may still look
  connected; TCP can take minutes to notice a dead path, and an established flow
  can keep working while new connections fail. A connection opened after the
  settle time shows the path works now.
- **Same login.** A crew phone on the hotspot can reach the box while the
  laptop that switched eth0 cannot. The confirming socket's auth token must be
  the requester's (compared by SHA-256; the token never leaves the socket).
- **Same UI address.** `Origin` and `Host` of the confirming socket's upgrade
  must equal the requester's. In production the page builds its socket URL from
  `location.host`, so both name the address the person typed. A box address
  reached over a tailnet subnet route, or a LAN address that a switch to shared
  LAN removes, stops accepting new connections, so the change is undone even if
  the tailnet itself still answers. A tailnet IP or MagicDNS name that keeps
  working over another uplink is a real way back in, and counts.
- **The one-time code.** 32 random bytes, base64url, minted by the page before
  it sends the request and kept in `sessionStorage` (this tab only; a reload
  keeps it). The page mints it, not the box, because the change may cut the
  socket before the reply arrives. The journal holds only its SHA-256, bound to
  the transaction with the token hash, `Origin` and `Host`. It is spent when the
  change moves to `confirming`, compared in constant time, and its field name is
  redacted by the logger.

A session without a token, `Origin` or `Host` (a script, the control channel)
can't confirm. The prompt says so (`canConfirm: false`, "this connection can't
confirm"), and a protected change from a browser login without a code is
refused before anything changes.

**The floor and the deadline run on the boot clock** (`/proc/uptime`,
CLOCK_BOOTTIME), recorded per transaction and per socket. Wall time can step
when NTP syncs right after an uplink change, which would undo a change early or
let an early socket pass. The boot clock is comparable across a backend restart
within one boot; a record from another boot is undone at start. `expiresAt` stays
in the API as wall time; `msLeft` and `confirmAfterMs` are what a page counts
down from.

**Up front, a session without front-door evidence is told whether the change
cuts it.** `network-session-route.ts` asks the kernel for the box's route back to
the session's peer (`ip -j route get`). A directly routed peer depends on that
one interface; a tunnel or a loopback peer depends on every uplink that holds a
default route in any table. The prompt then says "This change will likely cut
your connection: the box reaches you via eth0" (`cut: "cuts"`), or "may
interrupt" when the change touches one of several uplinks (`may-cut`). This is a
prediction for the message only: it never skips the prompt and never confirms.

The browser's half is `apps/frontend/src/main/network/change-confirm.ts`: mint
and keep the code, wait for `confirmAfterMs`, replace a socket that opened
before the floor, then send the code when the person presses Confirm (a
`too_early` refusal reconnects once more).

## How a change runs

| Step | What happens |
| --- | --- |
| Journal | `network-change-journal.ts` writes the plan and the transaction to `/data/ceralive/network-change/journal.json` (0600 in a 0700 directory, fsync, rename) before anything changes |
| Checkpoint | NetworkManager `CheckpointCreate` over the profiles' interfaces, 90 s, no flags, sent to the unique bus name of the NetworkManager instance that holds the name at that moment. The journal records that name, the system bus instance id (`GetId`; a fresh bus may hand unique names out again) and the checkpoint's `Created` stamp, and every later liveness check, destroy and rollback goes to that unique name: after a restart the calls fail instead of reaching a new checkpoint at the same path. A checkpoint without a complete identity is refused before any profile is touched. `DELETE_NEW_CONNECTIONS` is not used: it deletes every profile created anywhere during the window (a Wi-Fi network joined meanwhile, another port's profile). The owner removes its own candidates. Effect-only changes have no checkpoint and use the journaled deadline |
| Candidates | Each edited profile, active or dormant, duplicates included, is cloned with `nmcli connection clone --temporary` under a `ceralive-candidate-…` name, with autoconnect off. Only the clone is edited. The original on disk is never touched before confirmation |
| Effects | Each effect driver reads the current state and returns its undo record. The record is journaled, and only then is the effect applied |
| Activation | Candidates for live profiles are activated on their interface |
| Confirm | The requester's browser: a new connection of the same login to the same UI address, opened after the settle time, with the change's code (see "Who can keep a change"). On a path front-door evidence shows untouched: the creator's connection after the settle time, with the code. Then `CheckpointDestroy`, and each candidate is saved to disk under the original's name and autoconnect. The original is deleted. The live connection stays up, with no second activation |
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
| An undo step fails | The record stays as "undo incomplete" with its errors in the status (`problem`). The tick retries after 5 s, doubling up to 5 minutes, and logs each attempt. New changes are refused (`change_in_flight`) without retrying it early; a restart retries at once |
| The journal is unreadable | Every protected change and every role write to any port is refused with `change_in_flight`; the status reports `journalUnavailable`. A record whose transaction or notice lacks the fields the code relies on counts as unreadable. The warning is logged once per failure class (again every ten minutes). `network.resetChangeJournal` runs inside the owner: it moves a journal that still fails to read aside under a unique name (kept next to it) and sweeps leftover candidates; a readable one is never moved |

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
- A stored notice for a role the port already has is a true no-op: nothing is
  written to the port or NetworkManager, and the notice is answered under the
  owner (a notice someone answered meanwhile is refused).
- "Make the change" on a stored role-change notice plans the change again from
  the port's state now, through `setEthernetRole` (and so its queue), asked
  before again, with the same capability check as the role RPC. The owner
  checks and consumes the notice in the same apply, so a notice answered
  meanwhile refuses it. With no active profile on the port it refuses
  (`no_connection`) instead of changing the role unasked. It never replays the
  stored plan.

The arrival interface comes from the front door's local ingress evidence
(`ingressPath`, rechecked with `ingressPathValid()`). A session without it is
"unknown": it is asked before, and confirms like any other through its
browser's new connection (see "Who can keep a change"). Each WebSocket carries
its own session id, open time, `Origin` and `Host`, so a reconnect is a new
session.

Requests to the owner are queued, one at a time: a confirmation that lands
during a tick waits for it instead of failing with "busy". The tick skips a
turn when anything runs or waits. A call into the owner from inside one of its
own operations (a settle handler) is refused rather than left waiting for
itself. The role RPC resolves the session's route inside the port's role queue. While a stream is live, the prompt carries
`liveKey` ("an undo at the deadline can drop the stream for a moment"); the
undo itself is never deferred.

At backend start the owner reconciles before the role reconciler runs, and a
5-second tick undoes a change whose deadline passed or whose checkpoint vanished
(a NetworkManager restart). Both run whenever a journal exists, even with the
flag off, so turning the flag off cannot strand a pending change.

RPC: `network.setEthernetRole` takes an optional `changeAnswer`
(`undo-automatically` or `keep-change`) and `confirmationCode`, and may return
`changeSafety` (the ask-before prompt with `cut`, `canConfirm`, `primary` and
`deliberate`; `pending` with its id, `msLeft`, `confirmAfterMs` and
`canConfirm`; or `kept`, with `saving` while the save is unfinished).
`network.getChangeSafety` reads the journal (`pending`, and `confirmed` with
where the last confirmation came from). `network.confirmChange` takes the id
and the `confirmationCode` and answers with `confirmedVia`, or a typed
`refusal` (`too_early`, `wrong_code`, `not_requester`, `wrong_address`,
`expired`, `not_pending`). `network.undoKeptChange`,
`network.answerChangeNotice` (also with `confirmationCode`) and
`network.resetChangeJournal` act on it.

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
- a confirmation from a new connection of the same login and UI address, with
  the code, promotes the candidate to disk, without reactivation, and survives
  a restart. The creator's socket, another login, another address and another
  code cannot confirm;
- the deliberate "don't undo it" answer survives the deadline and a restart, and its recorded undo
  restores the profile (same UUID and settings) and the effects from another
  connection;
- the Ethernet role plan (uplink to shared LAN): an unconfirmed switch is
  undone with the profile files unchanged, and a confirmation from the same
  browser on a remote connection writes shared mode to disk and survives a
  restart;
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
- If the browser that made the change is gone (tab closed, storage cleared),
  nobody can confirm and the change is undone, with the usual notice. A
  session-only login (no "remember me") loses its token when the backend
  restarts, so a backend restart inside the window undoes its change. A
  password change inside the window revokes the token, with the same result.
  All fail safe.
- A front door that offers WebSocket over HTTP/2 (RFC 8441) could carry the new
  socket on an old connection. The backend speaks HTTP/1.1 only, and browsers
  open a fresh connection for an HTTP/1.1 WebSocket; check the front door
  before the flag goes on.
- `Host` binds only as well as a proxy in front preserves it; `Origin` is the
  stronger half.
- The route back to a session is read from the routing table when the prompt is
  built. Policy routing that picks a different uplink per flow can make the
  "cuts" prediction wrong in either direction; it only changes the message.
- A record from before identities were journaled is treated as having no live
  checkpoint: it is undone by the owner's own steps, with no path-only call.

## Before wiring more paths or turning the flag on

1. Device-facing drivers for hotspot-interface teardown and modem radio-mode
   writes, with idempotent undo, and their own isolated tests.
2. Arrival evidence beyond the front door: the front door covers direct
   on-link sessions. The nftables set (`network-ingress.ts`) remains an option
   for sessions that do not pass through it.
3. UI: the ask-before prompt, the confirm banner (driving
   `change-confirm.ts`, with the session-only login's token kept in memory for
   the reconnect), the ask-after notice
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
