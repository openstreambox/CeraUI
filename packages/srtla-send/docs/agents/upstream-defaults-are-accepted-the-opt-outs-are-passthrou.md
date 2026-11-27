<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE PASSTHROUGH ONLY

Upstream ships re-home and stall-deselect ON. The binding does NOT re-assert a
default of its own: `noRehome` / `noStallDeselect` are optional and emit
`--no-rehome` / `--no-stall-deselect` only when explicitly set. Absent means
"whatever the sender ships", which keeps the fork's behaviour the source of
truth for the fleet rather than a number duplicated here.


`fastStallGate` is the one tuning the binding emits, and only when set: it adds
`--stall-min-in-flight 4 --stall-ack-stale-ms 250` (`FAST_STALL_*`) so a link
that stops confirming delivery leaves the rotation within about 250 ms instead
of the sender's 32 packets / 3,000 ms. Absent or false adds nothing, so the
argv stays the default one. The backend sets it from the per-box
`srtla_fast_stall_gate` config (default off) for both the stream sender and the
SRT-forward sender. The sender never gates its last usable link, so the gate
cannot stall a single-link stream; both flags exist in every sender with the
stall guard (4.1.0 and later).
