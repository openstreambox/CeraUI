# Shared-client uplink steering

**Status:** `[PARTIAL]` — the CeraUI backend and kernel-namespace regression gate
exist. The image repository's source tree carries `ceralive-share.service`, its
teardown script, the CeraUI unit-ordering drop-in and the nftables/conntrack package
entries; that is source and static-contract evidence only. A built image, an
installed unit and real-board validation remain hardware-gated.

## Scope

This subsystem steers only traffic that entered through a registered client zone:
a concurrent hotspot AP interface or an Ethernet port in `shared-lan` mode. It does
not steer locally originated traffic, does not alter SRTLA's device-bound sockets,
and owns no foreign nftables table.

The implementation lives in
`apps/backend/src/modules/network/uplink-steering/`. Its carrier effects live in
`apps/backend/src/modules/network/uplink-sharing.ts`.

## Operator: every uplink down

<a id="all-down-operator"></a>

Spanish: [es-419/UPLINK_STEERING.md](es-419/UPLINK_STEERING.md#all-down-operador).

A hotspot or shared-LAN client can lose internet access while remaining connected to the box. The behaviour below is implemented in source; real-device qualification is still pending. Labels are quoted from the current catalogs, which do not establish complete es-419 interface coverage.

**Outage, reconnect, return.** A phone may stay associated and a laptop may keep its Shared LAN address during an outage. Those facts, and an Up status, do not prove usable internet. Once a ruleset with no selectable uplink is applied, it blocks the new client IPv4 flows described under Limits. When a usable uplink returns and the updated rules are applied, try a new connection. Reopen the browser, app, or call in the ordinary way. An open session can need that reconnect after the uplink actually failed. Session continuity, break-free failover, and uplink combining are not included.

Degraded passive evidence alone does not make a path already marked Down selectable again for new client flows, even if its address returns. Recovery through successful observations still requires five consecutive successful rounds and the existing hold-down of at least 15 seconds from the health-state transition. This minimum is neither a guaranteed recovery time nor a delay measured from reconnecting a cable. Degraded passive evidence resets partial success counts. Ordinary degradation of an Up path and captive-portal handling are unchanged.

An ordinary gateway check samples candidate addresses, eligibility and the candidate list again after queued route preparation, just before its first attempt to change a route. If they changed, it withholds the old result so later maintenance can reassess; even an unchanged route is not reported as current success from a stale result. Once a change is attempted, the transaction and any rollback are allowed to finish; later candidate changes do not cancel them. These point-in-time checks do not hold link state fixed, track physical reconnections or detect a change that returns to the same observed values. They do not guarantee usable internet or a recovery time.

**Web interface reconnect.** When the interface replaces its control connection, it ignores delayed updates and connection-status events from the previous connection. Updates and errors from the current connection still appear. After the control connection returns, confirm internet access with a new request from a hotspot client; existing client sessions may need to reconnect.

**Internet Sharing** includes the runtime client-uplink policy below; its diagnostics remain read-only. If Client zones still shows the zone and every uplink is Down, you may see **No healthy uplink**: "Every uplink is down, so connected devices have no way out. The stream itself is unaffected." This means client steering does not change the device's streaming routes; it does not prove that a stream reaches its receiver. Rows say Down, and may add "The device lost this link, so connected devices no longer use it." Zones remain **Hotspot** or **Shared LAN**. "No devices connected" only means nobody has joined. **Health weight (before policy)** is a probe weight, not the applied traffic share. Open **Diagnostics**. Its known limitation says name lookups from connected devices follow this device's default route, so they may not use the uplink their traffic is sent over. That note is not a DNS result, and "Nothing to review" does not run a test.

**Sharing is off** means no client zone. Its sentence — turn on the hotspot, or set a wired port to Shared LAN — is not a control on this card. **Client steering unavailable** means clients use the default route; read Reason. **Sharing is active** counts uplinks that can carry client traffic.

**Limits**

- The guard acts only after its rules are applied. A delay, a refusal, or a failed apply can leave the earlier behaviour. After a failed partial apply, the same return is applied again. Device recovery is not qualified.
- It drops new forwarded IPv4 flows from a registered zone and prefix when no uplink has a positive selectable share. It does not isolate all traffic, and it does not handle IPv6.
- The hotspot or shared LAN can stay present while upstream internet is unavailable. Local DHCP, DNS, and UI traffic is outside this forward rule. That is not proof those services work.
- New routed client flows to peers on other interfaces or zones are also blocked. Ordinary on-link peers are a separate path. Bridge handling is not qualified.
- Streaming started on the device stays outside client steering. SRTLA and local Moblink stay independent. There is no generic tunnel or route rewrite, and no end-to-end qualification from this source.
- Stopping the sharing carrier removes this guard. The remaining NetworkManager sharing rules then govern forwarding. Stop or restart is not a verified recovery recipe.
- Prepared packet coverage is unexecuted. UDP 53 and 67 echoes are reachability, not DNS resolution or a DHCP lease. A retained-uplink established flow does not simulate physical loss of every uplink. Real-client, package, and image qualification remain open.

## Ownership

- nftables table: `inet ceralive_share`
- desired-state file: `/run/ceralive/share.nft`
- carrier: `ceralive-share.service`
- fwmark rule priority: `110`, after steering-owned source rules at priority `100`
- fixed weighted-selection modulus: `10000`, apportioned by largest remainder
- foreign image table: `inet ceralive_ingest_fw`, input hook priority `-10`

The module publishes a complete nft batch and asks systemd to start/reload the
carrier. Ordinary reweights use `reload`; they never restart or stop the unit.
Sharing-off uses `stop`, whose image-owned `ExecStop` is the crash/shutdown
backstop. A temporary file is fsynced, checked with `nft --check`, then atomically
renamed before systemd sees it. A failed reload restores the prior file and reloads
that prior state.

The packaged `ceralive.service` declares `/run/ceralive` as a root-owned runtime
directory with mode `0700`, created before the backend starts. It preserves the
directory across stops and restarts because the sharing carrier and update
helpers use it too; `/run` still expires at reboot. This declaration does not
start the sharing carrier or apply a ruleset. Packaging and device qualification
must confirm that the installed unit carries these settings.

## Flow identity and NAT

The mark layout is `0xca | stable 16-bit uplink slot | preserved low byte`:

- `0xff000000` proves client-zone conntrack provenance;
- `0xffffff00` selects the uplink route;
- `0x000000ff` remains available to another mark consumer.

The stable slot is derived from physical uplink identity, never array position, so
adding, removing, reordering, or reweighting links does not move established flows.
Only a new conntrack flow entering a positive client-zone `iifname` match runs the
weighted verdict map. Established client-direction packets restore their route mark
from conntrack. Reply packets entering from a WAN interface do not, preventing WAN
recirculation.

The generated syntax targets the device's Debian bookworm nftables 1.0.6, not a
developer host's newer parser. Conntrack save and restore are expanded per
route-supported uplink so each bitwise OR combines one runtime mark with one literal
mark; no set-statement expression reads both `meta mark` and `ct mark`. Full-table
replacement uses idempotent `add table` then `delete table`, because bookworm also
predates `destroy table`. These expansions preserve the packet mark's low byte and
the conntrack mark's high 24-bit uplink identity exactly.

Masquerade requires all three facts: the client-zone ingress interface, the
client-zone source prefix, and the namespaced conntrack mark for the selected
uplink. A host-originated packet therefore cannot enter this NAT path even if it
uses an address inside a client prefix.

## All-down forwarding

Once an all-down ruleset has been applied, it drops only new forwarded IPv4
flows from each registered zone and source prefix when no uplink has a positive
selectable weight. Invalid, untracked, out-of-prefix and IPv6 traffic are outside
this match. Detection latency, refusal or a failed apply can leave an earlier
ruleset active; this is not an unconditional packet-level isolation guarantee.
The guard also ends when the sharing carrier is stopped or its owned table is
removed, including stop during rollback or shutdown. The surviving NetworkManager
shared-mode rules then govern forwarding; no all-down isolation is promised
after teardown.

The drop belongs to a forward hook, never prerouting: requests addressed to the
box's DHCP, DNS and local UI services retain their input path. There is no output
hook, so locally originated traffic remains outside this rule. New client flows
to non-local addresses on other interfaces or client zones are forwarded and
dropped while all-down; no destination exemption is added. Ordinary on-link peer
traffic does not traverse this IP forwarding path, but bridge-netfilter behavior
still needs device qualification.

Sharing and client zones stay active while uplinks are unavailable. Once a
selectable uplink returns, the next full-state ruleset removes the drop and
restores weighted new-flow selection. After a failed reconciliation, even a
byte-identical desired state is reapplied until an apply succeeds, because a
partial apply may have left the live ruleset different from the last completed
state. Existing-flow retirement is unchanged.
This rule covers forwarded IPv4 only; it does not withdraw an upstream resolver,
change local DNS service, or establish real-client recovery qualification.

## Route support

Existing usable foreign source-routing tables are reused without claiming them.
Every supported uplink class (`wl*`, `usb*`, `eth*`, `en*`/`enx*`, `ww*`, and
`ppp*`) without a source rule gets a private, identity-derived table. A table
matching that identity remains steering-owned on re-plan for every interface
class, so teardown removes its owned support. A priority-100 source rule is added
only when the source address is unique; duplicate-address links use their own
fwmark tables without an ambiguous source rule.

For `ip -4 route show default dev <ifname>`, iproute2 omits the `dev` clause.
The planner supplies that query's interface when absent and rejects a conflicting
`dev`; unfiltered table output must explicitly name the matching interface.

Image-building-pipeline PR #115 removed the dispatcher source rules. The stale
policy-route self-check, its netif field, mock provider, and warning band are
retired. Its pure parsers now live in `uplink-steering/route-parsers.ts`.
The unused `network.collision.policyRouteTitle/Body` translations and frozen
rendered fixtures remain unchanged. The steering refusal reason
`policy_route_missing` remains valid for actual route preparation failures.

An occupied foreign rule at priority 110, a route table with no usable default,
overlapping client/uplink prefixes, a client zone that remains a bond candidate,
or a stable-mark collision produces a typed `steering_unavailable` state rather
than a guessed route. Preparation still succeeds or fails as a whole.

On backend restart, the module inventories its namespaced priority-110 rules. It
publishes the latest ruleset first, then flushes conntrack and removes stale rules
and private tables. Desired mark/table support is retained even when the old route
temporarily lacks an interface name.

## Hard-down drain

A hard-down uplink is retired in three phases:

1. reload a transition ruleset that excludes its mark from new-flow selection but
   keeps route/NAT support for existing flows;
2. delete only conntrack entries carrying that uplink mark;
3. remove the fwmark rule, any module-owned source rule/private table, and then
   publish the final ruleset.

Conntrack's numeric exit 1 is successful only when stdout is whitespace-only and
stderr contains solely its versioned `0 flow entries have been deleted.` summary.
An empty mark is already drained. Other exits or diagnostics retain the original
failure and prevent retiring route support.

After successful route removal the backend emits transient
`uplink-flows-reset { iface, linkId }`. It is never post-login hydrated. Persistent
state uses `uplink-steering`: either `{state:"available"}` or
`{state:"steering_unavailable", reason, detail?}`. Both shapes are defined in
`@ceraui/rpc`.

The coordinator is single-flight, recomputes the latest desired model before each
apply, skips byte-identical models, and retries twice at bounded delays. Failure is
fail-soft: the WebSocket server is already bound, boot continues through
`guardNonCritical`, and the typed unavailable state remains visible.
The byte-identical fast path is disabled after any failed reconciliation until
the next successful apply restores a known complete state.

## Verification

- Ruleset snapshots cover 0, 1, 2, 3, and 6 uplinks and every client-zone shape.
- Unit tests pin mark stability, fixed-modulus apportionment, route ownership,
  atomic publication/rollback, bounded retries, restart recovery, and hard-down
  ordering.
- `uplink-steering-netns.test.ts` loads every golden shape with real nftables and
  proves weighted first-flow selection, established-flow stickiness, reweighting,
  drain-window exclusion, mark-scoped conntrack deletion, reply routing, local-flow
  NAT isolation, and foreign-table survival.
- The all-down forward-chain and partial-apply return cases have unit/model
  coverage. `uplink-steering-netns.test.ts` also contains a source-authored
  all-down/return case (retained-uplink established flow, blocked new client flow,
  box-local UDP 53/67 echo and HTTP reachability, host-originated output, a routed
  peer on another zone, foreign-table survival, selectable return), but it has not
  been executed in a kernel namespace. UDP 53/67 are port-reachability probes, not
  DNS resolution or DHCP lease proof, and the case does not model physical loss of
  every uplink. Bookworm nftables 1.0.6 parsing, bridge-netfilter behavior and
  real-client recovery remain release gates; the earlier netns coverage does not
  qualify these cases.
- This test measures a REAL weighted packet distribution through a real netns +
  nftables setup, so its statistical bound (`ratio < 5.5` against a 4:1 weight
  target) only holds with CPU headroom — bundled inside the ~5400-test backend
  suite it is load-sensitive (observed at 5.667 locally under parallel load and
  5.897 in CI's bundled run). It gates on `CERALIVE_NETNS_ISOLATED=1` via
  `describe.skipIf`, so it skips inside the bundled `Unit tests (bun)` step and
  runs instead in its own dedicated `netns-semantics` CI step
  (`.github/workflows/build-check.yml`, `test-be` job) after the main suite. Run
  it locally with
  `CERALIVE_NETNS_ISOLATED=1 bun test apps/backend/src/tests/uplink-steering-netns.test.ts`.

The outstanding board drill needs two real uplinks and a hotspot client. It must
inspect nftables/conntrack marks while confirming SRTLA link distribution remains
undisturbed.

## Initial route-table allocation

Linux reports an unallocated IPv4 FIB with exit code 2 and “FIB table does not
exist”. During managed-table provisioning this exact diagnostic means the table
is empty: install the planned interface default before adding source/fwmark
rules. Other read failures retain the existing refusal and rollback behavior.
This applies to Ethernet, Wi-Fi and cellular alike and does not wait for an
uplink-health round. A not-yet-published interface default remains unavailable;
the coordinator retries using its existing bounded 100/500 ms schedule and
subsequent network/health notifications. All-down and forwarded-client-only
rules are unchanged. The namespace packet gate provisions real absent tables
through the production planner/manager before testing forwarding and recovery.

## Runtime client-uplink policy

Open **Client internet uplinks** in Network → Internet sharing. Choose
**Wired only**, **Cellular only**, or **Automatic**. Automatic priorities use the
lowest numeric tier with positive health weight; equal priorities share new
flows using the existing health weights. Defaults are zero for every kind,
preserving weighted automatic selection. Priorities range from 0 to 100.
Wi-Fi remains available in automatic mode. Kernel names beginning `wl` are
Wi-Fi, `ww`/`ppp`/`usb` are cellular, and `eth`/`en` are wired, matching steering's
existing supported interface classes. USB Ethernet named `en*` is wired.

Check a kernel interface name under **Administratively down for client sharing**
to withdraw that uplink from client traffic without disconnecting it. This is
independent of `network.configure` (bonding enablement). Clear the checkbox to
admit the link again, subject to health and selection policy. Forced modes have
no fallback outside their kind. If every permitted link is down or excluded,
the existing all-down forward guard stays active; local DHCP, DNS and UI remain
reachable. Upstream DNS remains locally originated and follows host routing;
this setting selects forwarded IPv4 egress, not DNS-resolver transport or IPv6.

The authenticated `network.getSharingPolicy` and `network.setSharingPolicy`
procedures read and replace the whole desired runtime policy:

```json
{"mode":"automatic","priorities":{"wired":0,"cellular":10,"wifi":20},"administrativelyDown":[]}
```

A mutation immediately requests the existing single-flight steering coordinator;
it does not wait for a NetworkManager poll or health transition. The setter
awaits its bounded reconciliation/retries (100/500 ms retry delays plus existing
bounded command budgets). Unit tests require a successful fake-effects apply
within one second. This is not a device recovery-time guarantee. On apply failure,
the desired policy remains set for reconciliation, and `uplink-steering` reports
unavailable; the returned policy alone is not proof of applied egress. Check that
status and verify a fresh client request. Reload client policy to read changes
made through another session. Concurrent writes serialize; the last write wins.

The policy is deliberately **runtime-only**: backend restart returns to automatic,
equal priorities and no administrative exclusions. Kernel interface names in the
administrative list refer to this runtime, not durable hardware identities;
recheck names after hotplug. Physical-identity conntrack marks remain unchanged.

**Flow policy:** forced kind exclusion and administrative down first remove the
mark from new-flow selection, then flush exactly its owned conntrack entries,
then remove it from the sharing ruleset and emit `uplink-flows-reset`. Apps must
reconnect. Healthy route support is retained during policy changes, including
existing host source rules; there is no interface-down operation, NM mutation,
management-route change or host default-route write. Ordinary physical/health
loss still uses the existing hard-down route lifecycle. Priority-only changes
retain conntracks and route support: new flows fail over/back to the best tier,
while established backup flows remain on the backup until completion or a later
exclusion/loss. This is reconnect failover, not session migration. The UI labels
probe weights as **Health weight (before policy)**, not an applied traffic share.

Tests cover the live state builder with injected NM/interface snapshots and the
existing coordinator/applier with fake kernel effects. The isolated kernel drill
runs policy-generated states on two uplinks and an AP-side client namespace,
proving cellular-only, preferred wired, administrative-down fallback, and return
for new flows, plus existing sticky-flow, all-down, local-path and foreign-rule
checks. Run it with
`CERALIVE_NETNS_ISOLATED=1 bun test apps/backend/src/tests/uplink-steering-netns.test.ts`;
it uses `unshare -rn` where permitted. Hardware qualification remains separate.

### Initial AP publication and readiness

AP connection confirmation and IP publication can arrive in either order.
Client-zone classification is refreshed before Wi-Fi broadcasts and on every
network snapshot, independently of the Wi-Fi connection-change predicate. Until
installed state is read back, the hotspot remains in its activating transition
and displays “Steering pending”. Terminal Start success waits for reconciliation.
Readback checks the owned nft ingress, exact source/fwmark rules and default
route device. Failed readback invalidates readiness and retains retry semantics.

When a managed table loses its default, re-planning retains priority-100 source
ownership. Cleanup matches the complete source/priority/table tuple and refuses
foreign rules with extra selectors. Isolated lifecycle tests exercise a first
marked packet, route withdrawal, Stop and idempotent Delete with no owned
support left, while preserving a foreign source rule.

Readback also runs when desired state is unchanged. Missing kernel support
withdraws readiness and triggers the existing bounded apply retry.
