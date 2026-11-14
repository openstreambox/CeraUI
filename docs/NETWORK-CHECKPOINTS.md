# Safe network changes

This draft holds a network-change owner, a NetworkManager adapter, a journal,
an undo interface for effects outside NetworkManager, arrival-interface
evidence, and the copy for the prompts. None of it is connected to the RPC
handlers or the UI yet, so network behavior is unchanged.

## The idea

A change to Wi-Fi, the hotspot, Ethernet or a modem can cut the connection the
person is using, sometimes on purpose. The box does not treat a lost connection
as a mistake:

- **Ask before** when the change touches the interface this session came in on,
  or when that interface is unknown: "This change disconnects you from the box
  via {via}." The buttons are "Undo it if I don't confirm in {seconds} s"
  (selected by default) and "Keep the change".
- **No prompt** when the change touches another path. The change still has an
  automatic undo. The creator's own connection confirms it once it still works
  15 seconds after the apply finished.
- **Ask after** when an automatic undo ran because nobody confirmed. The notice
  says "This change disconnected you, so the box undid it. Do you still want to
  make it?", with the buttons "Make the change" and "Leave it undone". The notice
  is stored on the box and stays until someone answers it, on any device. Once
  answered, it is gone for everyone. "Make the change" asks before again, so a
  deliberate re-apply is never undone without the person choosing that.

An unknown arrival interface counts as the person's own path. It costs one tap
when the box is unsure, and the box could not accept a confirmation without
that evidence anyway.

## How a change runs

| Step | What happens |
| --- | --- |
| Journal | `network-change-journal.ts` writes the plan and the transaction to `/var/lib/ceralive/network-change.json` (0600, fsync, rename) before anything changes |
| Checkpoint | NetworkManager `CheckpointCreate` over the profiles' interfaces, 90 s, `DELETE_NEW_CONNECTIONS`. Effect-only changes have no checkpoint and use the journaled deadline |
| Candidates | Each edited profile, active or dormant, duplicates included, is cloned with `nmcli connection clone --temporary` under a `ceralive-candidate-…` name, with autoconnect off. Only the clone is edited. The original on disk is never touched before confirmation |
| Effects | Each effect driver reads the current state and returns its undo record. The record is journaled, and only then is the effect applied |
| Activation | Candidates for live profiles are activated on their interface |
| Confirm | Over the changed interface: a signed-in session opened after the apply, never the old one. On another path: the creator's connection after the settle time. Then `CheckpointDestroy`, and each candidate is saved to disk under the original's name and autoconnect. The original is deleted. The live connection stays up, with no second activation |
| Keep the change | No checkpoint. Candidates are promoted at once. Each original stays on disk as an inactive `ceralive-backup-…` profile, and the undo records stay in the journal. Any signed-in connection can run that undo until the next change retires it |

On timeout, NetworkManager rolls the checkpoint back by itself (removing the
candidates, reactivating the originals). The owner then removes any leftover
candidate, replays the undo records in reverse order, reactivates originals and
writes the ask-after notice. The same undo runs on `reconcile`:

| When | Result |
| --- | --- |
| NetworkManager's bus name gets a new owner (restart) | Unconfirmed change undone at once. The candidate reloaded from `/run` is deleted, so nothing is orphaned |
| Backend start, same boot, checkpoint still live | Resumed: NetworkManager still holds the timer |
| Backend start or boot otherwise | Undone, notice "The network restarted before you confirmed, so the box undid it." |
| Crash after the confirmation's checkpoint destroy | Rolls forward to finish the promotion |
| An undo step fails | The record stays as "undo incomplete" and is retried on every tick and restart |

Any `ceralive-candidate-…` profile the journal does not name (a crash between
clone and journal write) is deleted by the same sweep.

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

- ask before: an own or unknown path returns the prompt and changes nothing;
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
- "Keep the change" survives the deadline and a restart, and its recorded undo
  restores the profile (same UUID and settings) and the effects from another
  connection;
- a request to wan0's address routed in over lan0 is attributed to lan0.

Run it only in a disposable container with no device passthrough and no host
system-directory mounts, with `NET_ADMIN` and `SYS_ADMIN` (for one client
network namespace). Install NetworkManager, D-Bus, systemd's `busctl`,
iproute2, nftables, jq, curl and bun. Set `NM_CHECKPOINT_CONTRACT=1` and run the
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

## Before wiring

1. Device-facing drivers for hotspot-interface teardown and modem radio-mode
   writes, with idempotent undo, and their own isolated tests.
2. Install the ingress table, record the session's interface when its socket
   opens, and pass the session to the owner.
3. RPC and UI: the ask-before prompt, the confirm banner, the ask-after notice
   broadcast to every connection, and the kept-change undo. All copy keys exist
   under `network.changeSafety.*` in every catalog.
4. Run `reconcile` at backend start, on NetworkManager's bus `NameOwnerChanged`,
   and from a boot unit after NetworkManager. Run `tick` from a timer.
5. Make asynchronous station and hotspot completion part of the apply, and
   cover every mutation entry point with isolated integration and browser tests.

No image, streaming, hardware or deployment changes are included here.
