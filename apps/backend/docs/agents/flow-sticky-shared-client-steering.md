<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FLOW-STICKY SHARED-CLIENT STEERING [PARTIAL — backend complete; image carrier source present, built-image + board drill pending]

`modules/network/uplink-steering/` is the desired-state controller for hotspot and
Ethernet `shared-lan` client traffic. It owns only `inet ceralive_share`, the
priority-110 namespaced fwmark rules, priority-100 IPv4 source rules selecting
its managed tables, and private route tables 30000–95535. The image's
`inet ceralive_ingest_fw` table (input hook priority -10) is foreign and is
never named by generated rule text. The carrier effects are isolated in
`modules/network/uplink-sharing.ts`: fsynced temp → `nft --check` → atomic rename
→ systemd start/reload, with prior-file reload on failure.

The packaged backend unit creates `/run/ceralive` as root with mode `0700`
before startup. `RuntimeDirectoryPreserve=yes` keeps shared runtime files across
backend stops and restarts; reboot still clears `/run`. The sharing carrier does
not provision this parent directory because publication precedes carrier start.
The built and installed unit still requires qualification.

**Only forwarded client-zone traffic is steered or NATed, and only the client band
is ever capped. Preserve physical-identity marks and established flows.**
Everything below is how that is made structural rather than intentional. Wi-Fi
station / hotspot / hybrid transitions run under the permanent-MAC adapter lock
described in EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK.
Ethernet role changes are serialized per port and must not be nested.

**Source-rule ownership is bounded.** `uplink-steering/route-planner.ts` reuses
usable foreign source-routing tables without claiming them. Otherwise it plans
identity-derived managed tables, adding priority-100 source rules only for unique
source addresses; duplicate-address uplinks use separate fwmark tables without an
ambiguous source rule. Stale references to other managed tables are ignored before
checking foreign-table ambiguity. `uplink-steering/route-policy.ts` recognizes
plain priority-100 IPv4 source rules only within the managed table range.
`uplink-steering/route-manager.ts` provisions the planned source/fwmark rules,
removes obsolete managed source rules, restores them on rollback, and removes
owned source rules with retired route support.

**Client provenance is structural.** New-flow selection, conntrack mark restore,
and masquerade all require a positive registered client-zone `iifname`; NAT also
requires the zone prefix and the namespaced conntrack mark. There is no output
hook. A locally-originated packet therefore cannot enter this path even when its
source is inside a client prefix, and a WAN reply never restores the client flow's
mark and recirculates out the WAN.

**An applied all-down ruleset keeps the client zone active.** If no uplink is
selectable, a forward-hook rule drops only new IPv4 flows matching each
registered ingress interface and client prefix. Invalid, untracked, out-of-prefix
and IPv6 traffic are not matched, and detection/refusal/apply failures can leave
an earlier ruleset active. The rule must not be in
prerouting, where it would also drop client requests to local DHCP, DNS and UI
services. No input or output hook is added. Routed peers on other interfaces or
zones are dropped while all-down; no destination exemption is added. Ordinary
on-link peers avoid this IP forwarding path, with bridge-netfilter behavior still
subject to device qualification. A successfully applied selectable state removes
the drop through the existing full-state reload; upstream DNS withdrawal is
separate from this rule.
Stopping the sharing carrier removes its whole owned table and the guard with
it, including rollback/shutdown stops. NetworkManager's surviving shared-mode
rules then govern forwarding; this guard is not a teardown-time isolation policy.

**Marks are physical-identity keyed.** The high byte `0xca` proves client-zone
provenance, the next 16 bits select the uplink, and the low byte is preserved.
The fixed 10000-bucket verdict map uses largest-remainder apportionment. Reorder,
add/remove, and reweight never change a surviving mark, so established flows keep
their original route while only new flows see the new weights.

Wi-Fi marks use the coherently sampled permanent address bound to the current
registry object, independently of its verified/limited classification key.
An unrelated unreadable witness therefore cannot turn a surviving station's
mark into a `limited:*` or `degraded:*` mark. A registered Wi-Fi radio without
current coherent physical evidence holds the plan pending, including after
an apply, preserving committed routes and flows until evidence returns.
An actual replacement with a newly proven address still retires the old
support. Missing/unregistered Wi-Fi and non-Wi-Fi coverage/deadline handling
retain their existing behavior. The production-graph cases live in
`wifi-steering-readiness.test.ts`.

**Startup readiness preserves recovered sharing.** The first OS netif snapshot
must exist before planning, including when it is empty. A snapshot with no
`wl*` interface needs no Wi-Fi discovery; otherwise a completed Wi-Fi device
refresh must classify every such interface. A device with no active connection
is classified; an active connection needs mode `ap` or `infrastructure`.
Names are candidates, not radio-type evidence: a fresh NM listing excludes
interfaces explicitly typed as non-Wi-Fi. Empty or unknown types still wait.
Each discovery clears these exclusions before reading NM, so a pending or failed
listing cannot reuse a previous non-Wi-Fi verdict.
Both radio classifications and non-Wi-Fi exclusions carry the OS parser's
presence epoch. Appearance, disappearance, ifindex changes and observed MAC
changes advance that epoch before publishing the snapshot. Ordinary polls retain
it. A type read captures the topology generation before calling NM; changed
topology discards a stale listing and schedules a fresh read. Per-device awaits
also check that generation before recording classification. Removed or replaced
names cannot inherit either type verdict, and exclusions are pruned on readiness.
Monitor-only placeholders have no parser identity yet. Their first OS metadata
advances the topology generation while adopting the monitor's lifetime, preserving
its covering bus read and rejecting type reads begun before that publication.
Discovery, the netif parser, readiness and uplink planning share
`isSupportedWifiIfname` in `wifi-interface-creation.ts` (re-exported from
`wifi-concurrent-interface.ts`). Virtual `clap-*` AP legs remain client zones
by name and do not require station classification; any present `wl*` parent,
or interface with the kernel's `phy80211` link, still does. The name rule is a
fast path; the cfg80211 link admits radios with vendor-specific names (and
makes such a second netdev a witness of its phy), while `clap-*` legs stay
excluded.
A failed nmcli listing, skipped device, per-device read error or `unknown` mode
leaves readiness pending. This check precedes the empty-client-zone branch.
Pending performs no apply, availability publication, retry, failure-backoff
update or pending-route cleanup, and returns immediately to the boot ladder.
One scheduled reconcile runs 15 seconds after the first pending result with an
OS snapshot. At that deadline the coordinator permanently bypasses zone
readiness, warning once if classification is still pending. If no client zone
is known then, recovered sharing is torn down. No bypass can apply before the
first OS snapshot.

**Publication precedes identity consumption.** New interface names wait up to
2 seconds for a committed USB scan covering the entire parsed interface set.
A completed read covers a name even when it has no USB descriptor. A superseded
scan is requested again within that bound; cadence scans join the in-flight
producer scan. Older OS refreshes cannot overwrite a newer snapshot.
`usbNetScanCovers(ifname)` and `identityDeadlineExpired(ifname)` in
`router-cellular-scan.ts` are the shared predicates for identity consumers.
The single identity deadline starts when a name first enters a published netif
snapshot and expires after 15 monotonic seconds (`getms`, backed by
`process.hrtime`), with one fallback warning per name. Wall-clock corrections
cannot expire it early or revoke an expired deadline.
Before the first apply, any eligible uncovered non-Wi-Fi uplink holds the whole
plan pending; after an apply, only uncovered candidates are omitted. A covering
scan commit requests reconciliation immediately, including serial-only or
physical-port changes, so the next plan uses the physical identity.
Shaping also leaves its current state intact while steering readiness is pending.

**The emitted nft syntax targets Debian bookworm's nftables 1.0.6.** A set
expression may read only one runtime mark when applying a bitwise OR, so save and
restore lift the known uplink value into a literal per-uplink statement; combining
`meta mark` and `ct mark` dynamically is forbidden even though newer nftables parses
it. Whole-table replacement is `add table` then `delete table`, never the newer
`destroy table`. Both rules are production compatibility constraints, not CI
workarounds; the packet low byte and conntrack high 24 bits remain byte-identical.

**A hard-down is three phases:** publish a transition ruleset excluding the mark
from new-flow selection while retaining its NAT/route support → delete conntrack
entries carrying exactly that mark → remove route support and publish the final
ruleset. The transient `uplink-flows-reset {iface,linkId}` follows successful
route removal and is never hydrated. `uplink-steering` is persistent and carries
the shared `@ceraui/rpc` typed availability/refusal state.

The coordinator is single-flight, re-reads the latest model before every apply,
skips byte-identical state, and retries a newly failing state at 100/500 ms.
After those retries fail, identical desired states leave the unavailable status
untouched and skip apply for 5 seconds. Each later failed apply doubles that delay
up to 60 seconds, with one apply per window. A different desired state or success
clears the backoff. On process restart,
`uplink-steering/route-manager.ts` inventories its priority-110 rules and
priority-100 managed-table source rules, including source-only crash remnants.
It publishes the latest model first, then flushes and removes stale support.
`uplink-steering/applier.ts` protects desired support by mark/table and retains
cleanup work separately for each source address and priority. Any overlap, mark
collision, foreign priority owner, missing route, nft failure, or rollback failure is fail-soft and surfaces
`steering_unavailable`; it never blocks the already-bound WS server.
After a failed reconciliation, an identical desired state is reapplied until a
full apply succeeds, rather than trusting the last completed-state cache.

Keep committed steering through stale-route cleanup failures: sharing, provisioned
support and the forwarding step stay intact. The applier retains pending
retirements and warns once per distinct failure; the coordinator alone retries
them after successful, unchanged, or backoff-skipped reconciles. Readiness-pending
reconciles do not retry cleanup. A pending
mark/table pair desired again by a successfully applied state is discarded without
a flush. The cleanup
snapshot advances only after forwarding succeeds and apply returns normally; a
failed activation cannot discard pending work. Before commit, a failed transition
restores removed support and reloads the previous ruleset before rolling new routes
back.

Existing CeraUI steering paths have kernel-netns coverage. The all-down chain
and partial-apply recovery are unit/model tested; an all-down netns case is
source-authored in `uplink-steering-netns.test.ts` but not yet executed, and
bookworm parsing remains a release gate. The image repository's source carries
`ceralive-share.service`, its teardown script, nftables/conntrack package entries
and the CeraUI unit ordering; that is source evidence only, not proof of a built or
installed image or of stop/restore behavior on a board. Full contract and
hardware gate: [`../../docs/UPLINK_STEERING.md`](../../../../docs/UPLINK_STEERING.md).


Runtime client selection uses this same owner; see [runtime policy](../../../../docs/UPLINK_STEERING.md#runtime-client-uplink-policy). Policy exclusion retires owned flows while retaining healthy route support. Priority changes retain flows. The default `single` selection (`uplink-steering/active-uplink.ts`) makes exactly one uplink selectable: immediate failover when health withdraws it, a held and flap-damped rejoin, and displaced uplinks kept listed at weight 0 so their flows drain ([single active client uplink](../../../../docs/UPLINK_STEERING.md#single-active-client-uplink)).
