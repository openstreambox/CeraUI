# Power snapshot fixtures

Most snapshots here are hand-written. The ones listed in `firmware-lines.txt`
are not: each line there is an `OSB1` status line printed by the power board
firmware's own status and link code (host build, no hardware), decoded by the
power service's reference decoder
(openstreambox/image-building-pipeline#23,
`mkosi/runtime/power-link/reference_decoder.py` at `440b03f8`) into the
schema 1 `fields` object of the same-named `.json`. The `firmware-before-*` and
`firmware-newer-keys` lines are that output with fields removed or added and
the checksum recomputed, to stand for older and newer firmware.

`power-state.test.ts` checks that every listed line is a well-formed `OSB1`
status frame (version prefix, not an event, under 512 bytes, unique keys,
checksum last and correct) and that its snapshot still matches it. It does not
run the decoder itself; re-check with the decoder when the wire format changes.
