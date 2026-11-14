# Sender address adoption

After a mobile network ends its data session and the link gets a new address,
the sender may keep using the old one. The backend checks the running sender,
retries HUP after ten seconds without adoption, then replaces the owned sender
once after another ten seconds and a cancellable 500 ms delay. Stop cancels the
check and prevents respawn. Duplicate publications share one recovery.

The standalone 4.1.0 sender does not publish an applied generation or source
address in its stats document. Its `bind_map_status: active` is not an adoption
receipt. On Linux the backend therefore reads UDP socket inodes owned by the
supervised PID and compares their bound source addresses with the publication.
A bound address that is no longer published means a changed link kept its old
source, so the reload did not take. A published address that is not bound yet
does not trigger recovery, because a restart could not bind it either.
Unreadable sockets are unknown, never success. This proves address adoption,
not receiver registration or successful delivery, and cannot independently prove
a mapping-only interface move with identical addresses. A future applied
receipt can replace this fallback without changing the recovery state machine.

After confirmed engine Stop, the sender remains alive for 250 ms to forward the
engine's real SRT shutdown. A peer rejection with reason 1000 is ambiguous: only
an identical destination and stream ID that succeeded recently is eligible for
retry, and only after confirmed idle cleanup. Retries relaunch the whole session,
use 1/2/4/8 second delays, at most five attempts and a 45-second total budget;
Stop cancels the existing start supervisor's wait. Changed credentials and first
starts receive no such exception. No shutdown packet is fabricated.

## Namespace regression

Run `netns.ts` as root inside the existing PID/mount/network test gate with
`CERALIVE_NETNS_ISOLATED=1` and `SRTLA_SEND_BIN` naming a real standalone sender.
The fixture uses only synthetic addresses in its private network namespace.
It changes an address on the same interface, rewrites the IP list, deliberately
withholds the first HUP while reporting delivery, then drives the production
adoption checker. It requires adoption by the same PID within 13 seconds,
exactly one retry and no restart or notice. Unit tests cover failed second
reload, one replacement, exhausted verification, duplicate work and cancellation.

## Operator guide (English)

The connection checks for a changed mobile address automatically. If it needs
to restart the connection, a notice says: “Restarted the connection to use the
new mobile address. You're still live.” A normal successful reload is quiet.

## Guía del operador (es-419)

La conexión comprueba automáticamente si cambió la dirección de la red móvil.
Si necesita reiniciar la conexión, aparece un aviso que indica que se reinició
para usar la nueva dirección y que sigues en vivo. Una recarga correcta no
muestra ningún aviso.
