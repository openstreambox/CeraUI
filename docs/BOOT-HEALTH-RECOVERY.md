# Boot health and bounded recovery contract

The separate image healthcheck owns confirmation of the booted slot. CeraUI
consumes its verdict and controls update admission; it must not substitute an
application restart, matching version or available uplink for boot health.
Loss of cellular coverage must leave a locally healthy image usable, without
causing automatic rollback or a reboot loop.

## Confirmation ownership and evidence

In image-building-pipeline, `mkosi/runtime/ceralive-healthcheck.service` runs
`mkosi/runtime/ceralive-healthcheck.sh` once per boot. It alone confirms the
booted slot. Slot mirroring and kernel staging may confirm only the other slot
under their existing verification rules. The application does not mark slots
good or manufacture `healthy-state.json`.

The current local checks require an active application service, loadable
streaming binaries, valid partition/kernel identity and an intact package
database. A binary version probe establishes loading, not successful physical
capture, encoding or sustained streaming. mDNS and HTTP/TLS checks warn without
blocking confirmation.

CeraUI accepts the healthy record only for the current boot identity. A staged
version that has booted but has no current verdict remains `os-verifying`.
Unreadable evidence also waits. A genuinely different booted version is assessed
as rollback before reading the healthy record. These existing boundaries are
described in [device updates](DEVICE-UPDATES.md) and
[update recovery](UPDATE-RECOVERY.md).

RAUC confirmation currently precedes writing the boot marker and healthy
record. A persistence failure after confirmation must remain an unresolved
verification result; repeated boot attempts cannot be assumed to restore the
previous slot after it has already been marked good. Preserve the failed record
and diagnose storage rather than inventing success or manually confirming it.

## Boot without cellular coverage

Required behavior: missing SIM, registration, bearer, upstream DNS or receiver
reachability must not by itself reject an otherwise locally healthy boot.
Network recovery and update-download admission retain their own policies.

The current image skips its receiver probe when the receiver is unset or no
non-loopback interface reports `state UP`. An administratively-up interface is
not proof of coverage: a provisioned device with an up link and failed receiver
TCP probe still fails this healthcheck. That case does not yet satisfy the
requirement above. TCP port reachability also does not establish SRT delivery.
Changing that gate belongs to the image owner and requires its existing offline
healthcheck fixtures and a later recovery drill.

On the application side, a current local healthy verdict must be consumed
without consulting the cellular update policy or launching an update. The
mocked healthcheck fixture tests that boundary; it does not run the image's
healthcheck or qualify a no-coverage boot.

## Streams exclude disruptive recovery

A recovery action that can stop the sender, change a bearer, restart an owner,
activate an update or reboot requires fresh, positively idle stream evidence
through the existing admission/ownership mechanisms. Unknown liveness holds
the action. Recheck at the dispatch boundary after any awaited preparation;
a previously idle observation is not authority for a later effect.

Consuming an already-written healthy record is observational and may proceed
while streaming. It must not arm an activation or restart the live sender.
The existing local-only slot mirror is permitted during a stream under its
separate integrity and ownership gates; it is not a service restart or network
change. Existing manual-install and D8 tests retain the stream-active and
stream-start-during-preparation cases; new fixtures must reuse them rather
than introduce a parallel controller.

## Retry and escalation boundaries

The existing OS staging policy permits three automatic failed rounds per exact
candidate. Settled failures wait 15 minutes after the first round and 30 minutes
after the second. The third enters `operator` with no automatic retry deadline.
A changed signed candidate has its own identity. `unsafe` permits neither manual
nor automatic staging until its existing recovery conditions are resolved.
No retry may infer writer quiescence from a timeout or lost reply.

Slot-mirror safety refusals use a different policy: 15-minute doubling delay
capped at six hours, persisted across backend restart. That caps the delay,
not the number of attempts. Retain its existing tests and do not present it as
a finite rescue budget.

The image boot healthcheck defaults to a 60-second retry window and five-second
interval. Its deadline is checked between attempts; bounded probes and the
sleep can overrun that window. It is not a strict overall 60-second deadline.
The oneshot unit has no automatic restart loop. The application's separate
`Restart=always` unit has no explicit restart pacing or start-limit values;
systemd rate limiting alone is not an application recovery budget.

Before enabling broader automatic escalation, each disruptive action must
declare a finite attempt budget and overall deadline, persist expenditure
across backend restarts, and retain the original failure and any unknown effects.
Exhaustion enters an operator recovery hold. A capped delay or a process restart
must not reset the budget. Enabling a reboot watchdog additionally requires
backend restart reconciliation and a proven slot fallback path.

## Operator recovery hold and rescue acceptance

The existing `operator` and `unsafe` staging modes are limited recovery holds,
not a complete system rescue mode. A complete rescue mode must preserve usable
local management and diagnostic evidence, stop automatic disruptive escalation,
and require an explicit recovery decision. Coverage loss alone must not enter
it. Bootloader fallback remains under the established slot/attempt contract;
the application must not force confirmation, clear uncertain ownership or
reflash media to escape a hold.

Release acceptance still requires the image-side coverage gate, hard retry and
restart budgets, stream-safe recovery, failed-boot fallback, interrupted install
and pre-userspace hang drills. Mocked fixtures exercise application decisions
and cannot establish physical update, watchdog, rollback or rescue behavior.

## Existing fixture coverage

- `os-verify-healthcheck.test.ts` and its shared harness: current versus stale or
  unreadable boot verdicts, connectivity-independent consumption and exclusion
  of activation effects while a stream is live.
- `os-verify-healthcheck-restart.test.ts`: verification across restart and
  failing-slot/fallback replay.
- `os-stage-retry.test.ts`: exact-candidate identity, deadline admission,
  three-round escalation and unsafe/manual refusal.
- `slot-sync-refusal-retry.test.ts` and
  `update-orchestrator-runtime-install-admission.test.ts`: existing persisted
  mirror backoff and stream-admission races, retained without duplicate cases.
