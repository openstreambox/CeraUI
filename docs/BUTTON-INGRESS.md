# Direct-path button ingress

## Design choice

| Option | Path evidence and address changes | Cost and limitations |
| --- | --- | --- |
| Per-address IPv4 listener | Binding an address alone does not bind the incoming device on Linux's weak-host model. A tiny SO_BINDTODEVICE helper can constrain both. Reconcile on netlink link/address events, close old connections before rebinding. | Pure Bun cannot set the required socket option. Multiple ports/listeners require discovery or an image front door. Hotspot/AP addresses work. IPv6 needs a separate policy. |
| nftables mark plus local check | An ingress-interface rule can mark a connection; source subnet or reverse route cannot substitute. Rules must track link changes and reserve mark bits against routing/VPN users. | Bun does not expose SO_MARK/conntrack identity for an accepted request. Requires a privileged helper and coordinated firewall lifecycle; tuple reuse and stale conntrack need care. More image coupling than a constrained listener. |
| Image helper forwarding to a private Unix listener (recommended) | SO_BINDTODEVICE plus an exact local IPv4 address on each eligible Ethernet/AP/Wi-Fi listener establishes the receiving link. The helper records accepted peer, interface and destination, closes connections on link/address changes, and forwards only eligible RPC upgrades to a private Unix endpoint. | Small image front-door helper plus CeraUI Unix endpoint; no firewall mark ownership, frontend discovery or new frontend origin. CeraUI independently rechecks the address at every button action. IPv6, VPN and relay requests keep password sign-in. |

Default: the third option, with device-bound sockets rather than merely binding
an IPv4 address. No fallback to inferred routes or subnet-only admission. An
AP/hotspot is eligible on the same basis as Ethernet. VPN packets addressed
inside the LAN subnet are refused by the helper's device binding. Relays retain
the sender-ID veto in the procedure. Forwarded, all X-Forwarded-* and Via
headers remain forbidden, including empty values.

No option can distinguish a headerless LAN application proxy from that LAN
application itself. This is a direct receiving-link policy plus explicit physical
confirmation, not proof that the browser has no intermediaries. Trusted LAN
peers can intentionally proxy traffic. Do not claim otherwise.

## CeraUI endpoint

The backend starts `/run/ceralive-button-ingress/rpc.sock` only when the image
has provisioned its root-owned mode-0700 directory and the backend runs as root.
The socket is mode 0600. Missing directory is inert; insecure provisioning or
bind failure logs unavailability while password sign-in continues. Existing
socket paths are never unlinked to steal an active owner's listener. The image
owns stale-path cleanup after verifying the old backend has stopped.

Only WebSocket upgrades on `/ws` are served. `X-Ceralive-Button-Path` contains
one JSON object:

```json
{"version":1,"peer":"192.168.2.4","interface":"eth0","local":"192.168.2.1"}
```

This is privileged IPC metadata, not a public forwarding header. Only the
private Unix endpoint reads it. The ordinary TCP server always sets
`buttonLocal: false`, regardless of any supplied metadata. There is no TCP
configuration switch to trust it. The private endpoint rejects missing or
malformed evidence and forwarding headers; then requires the exact current
interface/local address and on-link IPv4 peer. Every begin, poll and final
post-storage check reevaluates it. Once a check observes invalid evidence it
latches denial for that session even if the address returns. The helper must
close on every intervening link/address event, including an address removed
and restored between polls. An authenticated session's normal rights are
unchanged; revoked path evidence only denies the button action.

## Separate image follow-up contract

This is a specification for the image confirmation change; no image helper is
implemented or installed by this application change. Until that follow-up is
integrated, production button admission remains unavailable on older images.

1. Provision the private runtime directory before CeraUI, root:root 0700. Run
   both participants with the required privilege; do not relax the permissions
   for a general web/proxy user. Arrange stop ordering and stale-socket cleanup
   only after the owning process has exited. Keep the control socket separate.
2. Own the existing browser-facing origin/port, forwarding HTTP/static/preview
   and password-only RPC to the ordinary backend on a separate port. Prevent
   port conflicts by explicit service configuration. No public new port or
   cross-origin frontend URL is needed. Preview keeps its existing token rules.
   Keep ineligible address/interface listeners password-only too; IPv6 listeners
   must be V6ONLY. Do not mix an unrestricted wildcard or SO_REUSEPORT receiver
   into the eligible listener set. If safe listener reconciliation fails, retain
   password-only service and withhold privileged ingress.
3. For eligible wired/Wi-Fi/AP IPv4 addresses, open TCP sockets with BOTH
   SO_BINDTODEVICE (exact interface) and bind(address, port). Use authoritative
   link type/identity, not name alone, to exclude tunnels, bridges used as VPN
   ingress, loopback and unknown links. Fail closed on either bind failure.
   Main-interface routing cannot grant this privilege. IPv6 and all other
   paths use the ordinary backend without privileged metadata.
4. Subscribe to netlink before the initial dump; reconcile atomically and
   resync after overflow. On any link deletion, rename, identity/type change,
   address removal or mask change, close affected accepted connections before
   replacing listeners. Service restart closes all connections. Never reuse
   evidence from an old connection or queue across generations.
5. Inspect each upgrade, not just its TCP connection. Refuse privileged ingress
   for incoming Forwarded, X-Forwarded-*, Via or X-Ceralive-Button-Path headers.
   Preserve that denial by using the ordinary password-only path or rejecting
   the upgrade. Never strip a forwarding header then classify the request as
   direct. Do not offer CONNECT, arbitrary destinations or relay admission.
6. For eligible `/ws` upgrades, create a fresh private Unix connection, replace
   the reserved metadata with the kernel peer/interface/local address from
   that accepted socket, and tunnel WebSocket frames in both directions.
   Preserve host/origin and normal RPC authentication. Other paths cannot
   reach this endpoint. Bound handshake time, headers, queues, connection count
   and idle time; tear down both sides together.
7. Image tests must use network namespaces with direct Ethernet, AP client,
   overlapping-subnet VPN, LAN proxy with forwarding headers, relay, IPv6,
   address removal/readdition, helper restart, netlink overflow and hostile
   public metadata. Demonstrate that the actual SO_BINDTODEVICE listener
   refuses VPN ingress, not merely that a synthetic interface string is denied.

Host tests in this repository cover a real Unix WebSocket upgrade with synthetic
trusted evidence, proxy-header refusal, overlapping VPN metadata, hotspot client,
malformed evidence, address invalidation and procedure denial after confirmation.
They do not establish kernel/device binding or deploy this topology. Physical
input, LED feedback and English/Spanish release documentation remain separate
release prerequisites.
