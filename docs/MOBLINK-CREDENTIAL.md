# Managed Moblink credential

The backend owns `/data/moblink` (0700) and `credential` (0600), using its service
UID. Set/replace uses an exclusive temporary file, fsync and rename; clear
unlinks and fsyncs; an absent directory is already clear and is never created.
Symlinks, hard links, foreign ownership, oversized files and
incorrect modes fail closed on inspection. Replace atomically renames over an
unsafe credential name; clear unlinks it without following links. An own-UID
directory is repaired to 0700. Startup, save and clear remove own-UID regular
`.credential-*` remnants and fsync the directory. Unrelated files are retained.
This recoverable secret is outside general config.
Local means any authenticated non-relayed session (LAN, hotspot or tailnet),
not physical proximity. Only locally authenticated device operators can call
`moblink.setCredential`,
`clearCredential` or `getStatus`. Relay senders and the control channel are
refused. There is no credential getter. Status contains availability and a
configured boolean; errors use fixed codes, and traces omit the whole namespace.

The patch changes the separate `datagutt/moblink-rust` project, using source from
the `openstreambox/moblink-rust-relay` fork. It is carried only in this fork
until the relay maintainer accepts file input. No upstream contact is included.

Provisioning must apply `deployment/moblink-password-file.patch` to relay source
`fc2333022ca259a844bbccba84c462d3a0668874` (use `patch -p1` or
`git apply --unidiff-zero` in that source tree), install the resulting
`/usr/local/bin/moblink-relay-service`, and install the
root-owned, non-writable `/etc/ceralive/moblink-managed` marker only after removing
any previous relay supervisor. Neither is installed by this topic. Both files
must be regular, root-owned and not group/world writable. Mocks cannot enable
this owner. Without provisioning, save is unavailable; clear remains possible
through local RPC while idle. Backend startup restores the credential to its
owned child. Termination stops only that child with bounded TERM/KILL cleanup.
The relay's existing internal reconnect loop handles wrong/changed passwords;
this topic does not claim authentication or media health from a successful save.

The inspected relay CLI had only `--password`: its argv is readable by ordinary
local users through `/proc/<pid>/cmdline`. The included patch adds
`--password-file`, with a bounded read, exact 0600 mode, own-UID, regular-file,
single-link and no-symlink checks. The adapter uses only this option; an unpatched
binary fails instead of falling back to argv. Child output is discarded and the
supervisor uses a fixed label. Root/the service UID can still inspect the file
or memory. Follow-up for the relay: maintain/release this option in its own
source and qualify the exact artifact.

A dedicated non-root relay UID is REQUIRED before any release image enables
this feature. The root backend unit is not a relay unit: it retains hardware
privileges. There is no relay systemd unit in this repository to convert.
Image provisioning must supply a separate dedicated-UID relay unit or a verified
privilege-dropping child launcher, migrate private storage ownership and backend owner validation to that UID,
retain the relay's own-UID file checks, and prove restart/clear and negative
cross-UID access before installing the managed marker. Until then this topic
remains draft and must not be enabled in a release image.

No password value is returned to RPC, status, logs or remote
fan-out, or application browser storage. The field uses `autocomplete="off"` with password-manager ignore hints;
browser extensions and password-manager policies remain outside app control.
If a stream starts while the relay is stopping for a mutation, the unchanged
credential is restarted when available; a failed restart marks Box health.
Mutations require confirmed idle, including
carrying evidence. This does not add per-link admission, media telemetry or
real-phone validation. Empty/unsafe stored files and unexpected child exits mark
the existing Moblink Box-health line. Clear or replacement retracts that failure;
a successful save is still not authentication evidence.

One credential serves all local discovered Moblin streamers that share it.
There is no phone identity binding; use a unique password for isolation. The
box takes Moblin's existing password, preserving the phone's other relays.

A stream starting during save or clear leaves the credential unchanged. Only a relay that was running before the stop is restarted; a stopped or unavailable relay does not gain a Box health warning from that refusal. A failed attempt to resume a previously running relay still reports the fault.

Si una transmisión empieza durante el guardado o borrado, la contraseña no cambia. Solo se reinicia el retransmisor si estaba funcionando antes de detenerlo. Un retransmisor detenido o no disponible no genera un aviso de estado por ese rechazo; si falla la reanudación de uno que sí estaba funcionando, el aviso permanece.
