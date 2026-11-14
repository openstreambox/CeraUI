# Bounded client pause owner

`apps/backend/src/modules/network/heat-client-pause.ts` is an internal nftables
primitive. It is deliberately not registered with the heat planner and exposes
no RPC. Without authenticated primary-path, client binding and capacity evidence,
the existing heat planner keeps all links and clients available.

A future trusted session owner must validate the current carrying epoch, heat
stage, quality override, explicit primary path, peer capacity, hotspot zone and
client/lease generation. Its synchronous reader is called again after nft
ownership reads and immediately before publication. It must return null on
unknown, stale or replaced evidence, phone/management identity or recovery.
Call `update(reader)` once per second only while all evidence remains current;
call `clear()` on recovery and `stop()` on shutdown. Stop is terminal and prevents
queued or subsequent updates from rearming the lease. Construct one owner per
backend and clear retained state before beginning a new session. Do not run
concurrent backend owners against one network namespace.

The initial primitive accepts one positively IPv4-only client, never a prefix or
whole interface. Phone, management and unknown/dual-stack selectors are refused.
It trusts its internal caller's identity classification; the primitive cannot
discover or authenticate a phone. No caller with that evidence is implemented
in this draft. IPv6 support needs exact trusted bindings before admission.

Only the marked `inet ceralive_heat_client` table is replaced, in one atomic
nft transaction. Inventory failure or a foreign table refuses mutation. The
forward hook matches ingress/source and egress/destination tuples. It has no
input/output hook; local DHCP, DNS and management stay outside the restriction.
All commands use the existing argv/stdin runner with a one-second deadline.
The table marker is a cooperative ownership convention, not a security boundary
against another privileged administrator modifying this reserved table.

A five-second kernel set-element timeout bounds restrictions if the process
crashes, is killed, stops renewing or fails cleanup. No userspace timer or
shutdown hook is required for that backstop. Recovery/restart clears recognized
retained elements before new admission. A failed atomic nft publication preserves
the old lease until its original expiry; it cannot create an unbounded drop.
An inert table/chain may remain after expiry. Thermal savings and installed
hotspot/bridge behavior need device qualification.

Tests cover selectors, ownership, revalidation, startup clearing, terminal stop,
publication failure, and private mount/network namespaces with veth-backed phone
and guest clients. The kernel fixture checks phone forwarding, guest pause,
local management, recovery, restart, killed-owner expiry and an unrelated table.
