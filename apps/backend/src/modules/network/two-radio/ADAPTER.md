# Effect execution and ingress

`EffectAdapter` is an awaitable library for the existing network owner. It starts
no owner, timer loop, service or gateway. `bindNetworkOwner` uses the backend's
argv-only `run` helper for NM steps with cancellation, finite timeout and a 64 KiB
output limit. No existing composition roots are changed by this addition.

## The Wi-Fi owner lock

The adapter lock key is the radio's current owner, not its MAC: a composite
`mac@...` hotspot owner, or no MAC-keyed row at all for a Limited radio. Before
durable intent the adapter admits the identity's permanent MAC through
`admitWifiAdapterByMac` (`wifi/wifi-adapter-admission.ts`): a verified identity
row bound to the exact registry object whose publication is current (the guard
behind `projectWifiRadioIncarnation`), its sampled lifetime, and the owner key
that row resolves to. Limited, Unverified, degraded, unpublished (discovery in
flight) and missing rows return no ACK and record no command. Effects then run
under `withWifiAdapterLock(owner)`, the lock Wi-Fi's station and profile work
takes. Under it, `confirmWifiAdapterLifetime` takes a fresh bracketed sysfs
sample of the netif and re-checks the admission (same owner, registry object,
publication and lifetime) before the owner's live identity read, after it, and
after the effect. A replug, even under the same name and not yet published, or
an owner transfer in between refuses. Physical identity
(`physical`, permanent MAC, epoch, plus the admitted lifetime) is compared
separately from the lock mapping. Callers must not hold that non-reentrant lock
themselves.

## Owner composition

Supply `OwnerBinding` from the network owner's current identity inventory and
transactions. Its `run` must serialize work with that owner, including startup
reconciliation. Plans address exact activation/profile IDs, never a reusable
interface name alone. `plan` and `restorePlan` are read-only; each returned NM
step is checked again immediately before dispatch. Every candidate resource must
be tagged with the supplied durable scope before creation. No untagged existing
profile may be adopted as an operation-created resource. `removeOwned` must check
current ownership again before deleting; adopted or foreign resources survive.

The existing station `void` wrappers cannot serve as this completion interface.
A local nmcli exit or killed child is not NM server quiescence. `drain` must cancel
and verify all NM-side work for the persisted commands, including work found after
a backend restart. If no such observation is available it must return false.
`restored` confirms the named holder, rather than merely accepting an NM request.
The owner supplies these observation/plan callbacks; this library deliberately
has no guessed default implementation for unknown restoration or NM drainage.
Live owner composition and measured NM quiescence remain integration work.

Use one `FileJournal` in the owner's private persistent state directory, which
must already exist. The owner is the sole writer. Snapshot replacement fsyncs the
file and parent directory; missing means fresh, malformed means blocked. Use a
unique session per reducer lifetime. Call `reconcile()` before admitting anything,
including probes. A retained dirty operation closes admission, drains, restores
the persisted exact designated holder, and deletes only its durable scope. No
mutation is replayed. A new session can reuse operation numbers only after all
old records reconcile. Bound each session to 1,024 operations/commands and rotate
only after quiescence; never prune command fencing while callbacks may arrive.

For each reducer effect call `execute(effect, holder)`, where holder is the
reducer's designated holder and its owner-resolved physical identity at dispatch.
For cleanup, resolve the named original identity, not a replacement occupying its
slot. A cleanup with no resolvable original holder returns no ACK. After the
release/disconnect commit point pass the new designated holder. Feed a returned
ACK through `reduce` after the adapter releases the owner. Both IDs are echoed.
`null` is unknown, not success, failure completion or token release. No retries
are implicit. Explicit reconciliation is required after an IO deadline. A
nonresponsive child retains its physical lock until actual settlement, even when
the caller's finite deadline expires. The owner must not admit competing work
around an unresolved lock or promise.

## Ingress boundary and event mapping

`Ingress.parse` accepts a normalized version-1 reducer row as JSON with optional
`physical` beside `version`, `at`, `event`. Radio-bearing rows require `physical`,
which the owner maps to a live slot and exact epoch. All objects reject extra
fields. Challenge JSON omits `deviceBound`; `IngressAuthority.bound` obtains that
attestation from the original device-bound socket/nonce dispatch record. Traffic
needs an independent real sender/receiver receipt via `traffic`. Identity removal
needs authoritative absence via `absent`. ACK JSON is always rejected: only the
effect adapter can return command ACKs. Equal times preserve input order; older,
nonfinite, oversized and unknown records are rejected.

External receiver records may contain a session, timestamp, nonce, sequence,
transport and acceptance result. Those fields alone do not identify a physical
radio or activation, prove socket binding, or record that the sender received the
response. An arrival alone cannot become reducer `response`, `traffic` or command
`ack`. Correlate original socket dispatch and receive records against a shared
trace origin before admitting evidence. Run-level timing and cleanup summaries
cannot establish per-command completion or live-epoch proof. Missing identity,
socket, traffic or acknowledgement evidence remains unknown.

## Checks and regression coverage

Run `bun test apps/backend/src/modules/network/two-radio/` from the checkout root.
The adapter tests use a serialized fake owner with delayed, failed and duplicate
completions, physical replacement, held locks, dropped processes and persistent
restart state. The reducer suite also explores completion reordering. Coverage:

| Contract | Regression control |
| --- | --- |
| Existing owner and physical lock | owner-context assertions; external shared lock refuses effects |
| Lock by actual owner | same-owner station/profile interleaving; replug or owner transfer between admission and lock; replug during the effect; Limited/unverified/missing rows; Limited cleanup holder |
| Current publication and netif | discovery in flight with a stale verified sample; same-name lifetime change before dispatch; replug during the live identity read |
| Exact epoch before every effect | all four epoch fields; device swap between NM steps |
| Both ACK IDs | exact echo and duplicate-command single execution |
| Close, cancel, drain, restore, scoped removal | concurrent cancel/late completion; ordered drain/restore/remove; foreign resource retained |
| Unknown identity/restoration | replacement holder, unknown restore, failed confirmation retain intent |
| Timeout cannot release token | reducer cleanup token and unconfirmed drain; abort-ignoring command retains lock |
| Bounded IO | NM timeout/signal/output ceiling and hung command caller deadline |
| Durable crash reconciliation | write-ahead failure, lost process, new session, unconfirmed recovery, release-point holder, corrupt file |
| Honest ingress | forbidden ACK/self-attestation, stale mapping, unsupported external receiver events, probe-vs-traffic |

Focused strict checking includes tests and uses strict, noUncheckedIndexedAccess
and exactOptionalPropertyTypes. The imported legacy owner closure may separately
report existing diagnostics; these must not be misreported as a full backend
check passing. Full repository verification and live owner composition remain
separate follow-ups; no hardware qualification is asserted.
