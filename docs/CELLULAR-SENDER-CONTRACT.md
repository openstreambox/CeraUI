# Cellular sender binding and withdrawal

## English

Managed cellular links require both literal boolean capabilities
`bind_map_required=true` and `bind_map_required_empty_reload=true`, plus an
integer `bind_map_contract >= 1`. An absent, zero, noninteger or string revision
is unverified. Future positive integer revisions preserve the revision-one
contract. The sender receives `--require-bind-map` together with `--bind-map`;
required links never fall back to a source-only socket.

Revision one establishes a checked bind to an assigned canonical unicast source
on the selected device. During reload, `pending_apply` means reader/socket
teardown has not joined. Even a fresh empty connection list cannot acknowledge
withdrawal in that state. Only subsequent applied evidence or positive process
exit can release the owned host resources.

The Network view shows “Updating links” and “Link changes are still being
applied. Waiting for confirmation.” It does not claim that every link has
stopped. The frozen producer fixture is checked byte-for-byte through telemetry
and RPC; its pending state is rejected by the withdrawal proof.

## Español (Latinoamérica)

Los enlaces celulares administrados requieren las dos capacidades booleanas
literales `bind_map_required=true` y `bind_map_required_empty_reload=true`, además
de un entero `bind_map_contract >= 1`. Una revisión ausente, cero, no entera o de
texto no está verificada. Las revisiones enteras positivas futuras conservan el
contrato de la primera revisión. El emisor recibe `--require-bind-map` junto con
`--bind-map`; los enlaces requeridos nunca usan solo la dirección de origen.

La primera revisión comprueba la vinculación a una dirección unicast canónica
asignada al dispositivo seleccionado. Durante una recarga, `pending_apply`
significa que todavía no ha terminado la retirada de lectores y sockets. Una
lista de conexiones vacía y nueva no confirma la retirada en ese estado. Solo
una lectura posterior del estado aplicado o la salida confirmada del proceso
pueden liberar los recursos del host.

La vista de red muestra “Actualizando enlaces” y “Los cambios en los enlaces
todavía se están aplicando. Esperando confirmación.” No afirma que todos los
enlaces se hayan detenido. La muestra fija del emisor se comprueba byte por byte
a través de la telemetría y RPC; su estado pendiente no confirma la retirada.
