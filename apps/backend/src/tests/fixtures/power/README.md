# Power snapshot fixtures

Most snapshots here are hand-written. The ones listed in `firmware-lines.txt`
are not: each line there is an `OSB1` status line printed by the power board
firmware's own status and link code (host build, no hardware), decoded by the
power service's reference decoder into the schema 1 `fields` object of the
same-named `.json`. The `firmware-before-*` and `firmware-newer-keys` lines are
that output with fields removed or added and the checksum recomputed, to stand
for older and newer firmware. `power-state.test.ts` checks that every listed
snapshot still matches its line.
