# Stream continuity observations

A restart currently stops the sender and sweeps orphan senders. This change
records enough evidence to develop a future restart proof without changing
those actions. The startup verdict is diagnostic only; no caller branches on it.

`/run/ceralive/continuity/` holds version-1 records:

- `lifetime.json`: pre-spawn intent, then child PID and proc start time. Arguments
  are represented by SHA-256 only. No engine configuration or credentials.
- `publication.json`: next reserved generation, digest of exact IP bytes and
  ordered link identities, saved before either IP or sidecar publication.
- `witness.json`: boot, publication generation, interface indices and address
  presence at reservation. Missing host ownership is explicit, never inferred.
- `report.json`: schema-projected running telemetry link list, timestamp and
  lifetime. This is diagnostic history, never proof the sender is still alive.
- `live.json`: two socket reads projected to link identities and availability,
  capability digest and lifetime identity. A stats file is never a live proof.

Files are schema-projected, mode 0600, written to unique exclusive temp siblings,
fsynced, renamed and followed by parent-directory fsync. Readers reject absent,
malformed, incomplete or unknown-version records. Boot IDs prevent cross-boot
reuse. Observation errors produce a fixed warning without raw exceptions or
record values; stream start and orphan cleanup continue normally.

Diagnostics keep the existing `/tmp/srtla-send-stats-<port>.json` and
`/tmp/srtla-send-control-<port>.sock` sender paths and records them as facts.
Record storage is not a prerequisite for either path. No per-stream runtime
files are introduced or accumulated. Sender arguments, stderr handling and
shutdown remain unchanged. Private per-lifetime paths are required before adoption is enabled.

Telemetry persistence keeps at most one active write and the newest pending
report. Slow storage replaces the pending value instead of growing a promise
chain. Stop discards the pending report, and failures do not block later writes.

`continuityVerdict` is pure and orders checks for lifetime, publication/disk,
two fresh live reads, engine, inventory and per-host witness. It returns only
`adopt` or `tear_down`, the disagreeing record category and a fixed reason.
It does not stop, signal, adopt, acquire leases or write anything.

## Limits before adoption

The current composition has no durable native-host ownership/witness API and
the installed sender binding does not expose contract-2 applied identity. The
observer marks host kind unsupported and live proof unavailable rather than
inventing them. Real production child senders also fail the independent-unit
check. Positive adoption is exercised through injected host evidence only.
This is not a complete field validation of cellular adoption.

Before enabling any verdict, supply the host-stack's exact owner/epoch, MM/NM
witness, ready fence, complete routes/rules readback, journal and isolation
inventory, with revocation subscriptions already installed. Add live contract-2
identity to the published binding, then consume two fresh socket reads, with
progress and no pending map. Record capabilities at spawn and compare them.
The 120-second guard currently measures age since spawn; replace it with a
persisted supervisor renewal time before it can measure unsupervised age.

Enabling adoption requires independent sender units with invocation and cgroup
proof, bounded engine reconciliation, secure path validation, host leases,
engine-session/destination equality, all-or-nothing source coverage, generation
continuation above the reserved generation, and telemetry/control reattachment.
Only then may it skip cleanup. Stop an unadopted sender before host replay,
including an explicit sender-unit consumer census. No record failure may allow
adoption, and existing shutdown/orphan behavior remains the fallback.

Additional prerequisites before adoption:

- Budget startup observation: three read-only socket requests can add roughly
  1.5 seconds before the orphan sweep (plus connection and record I/O).
- Use a boot-scoped monotonic supervisor-renewal timestamp. The current wall-clock
  spawn-age guard rejects long streams and is vulnerable to clock adjustments.
- Bind both live samples to the verified sender lifetime, not only map identity.
- Compare each host witness generation against the publication being judged.
  The standalone host diagnostic currently compares host fields only.
- Refresh the lifetime record on every future sender-host respawn. The current
  process runner observes exits without respawning; an unrecorded replacement
  would correctly be refused because its PID/start time differs.

Tests redirect all record I/O to a temporary directory through the leaf observer
I/O boundary, including privileged runs. Missing boot identity, unmappable links
and absent interface witnesses are unavailable evidence, rather than warnings.
A new publication removes the preceding publication and witness before observing
its replacement, so an unavailable observation cannot retain an old proof.
Storage failures still produce the fixed warning.

Stop and each new sender intent revoke the previous telemetry lifetime before
awaiting I/O. Deferred start/report writes check that fence before rename, and
completed old starts cannot reactivate telemetry. Startup socket observation
requires matching boot, PID, proc start time and argument digest.

`CERALIVE_CONTINUITY_DIR` optionally selects the diagnostic storage directory;
the default remains `/run/ceralive/continuity`. The test preload sets and restores
this value so standalone child processes inherit isolated storage without
loading the test harness. It changes no recovery or sender-path decisions.
