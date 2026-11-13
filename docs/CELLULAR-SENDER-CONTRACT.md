# Cellular sender binding and withdrawal

## English

Managed cellular links require both literal boolean capabilities
`bind_map_required=true` and `bind_map_required_empty_reload=true`, plus an
integer `bind_map_contract >= 2`. An absent, zero, noninteger or string revision
is unverified. Future integer revisions at least two preserve the revision-two
contract. The sender receives `--require-bind-map` together with `--bind-map`;
required links never fall back to a source-only socket.

Revision two preserves a checked bind to an assigned canonical unicast source
on the selected device and fences overlapping reloads through final publication.
The receipt requires `bind_map_applied` generation and `ips_file_sha256` to match
the latest committed publication exactly, including at startup. Digests cover raw
UTF-8 IP-list bytes, with LF separators and no trailing LF; empty is zero bytes.
A pending identity is intent only. Producer wall timestamps never establish
causal acknowledgement. During reload, `pending_apply` means reader/socket
teardown has not joined. Even a fresh empty connection list cannot acknowledge
withdrawal in that state. Only subsequent applied evidence or positive process
exit without a replacement sender can release the owned host resources.
Strict launches use unique per-producer telemetry and control endpoints; an old
file cannot acknowledge a new process. Cleanup removes only that producer’s
endpoints after its positive exit. Successful no-op publications retain generation
and digest; changed or uncertain publications require a new identity and reload.

The Network view shows “Updating links” and “Link changes are still being
applied. Waiting for confirmation.” It does not claim that every link has
stopped. The frozen producer fixture is checked byte-for-byte through telemetry
and RPC; its pending state is rejected by the withdrawal proof.

## Español (Latinoamérica)

Los enlaces celulares administrados requieren las dos capacidades booleanas
literales `bind_map_required=true` y `bind_map_required_empty_reload=true`, además
de un entero `bind_map_contract >= 2`. Una revisión ausente, cero, no entera o de
texto no está verificada. Las revisiones enteras positivas futuras conservan el
contrato de la segunda revisión. El emisor recibe `--require-bind-map` junto con
`--bind-map`; los enlaces requeridos nunca usan solo la dirección de origen.

La segunda revisión comprueba la vinculación a una dirección unicast canónica
asignada al dispositivo seleccionado y protege la aplicación frente a recargas
solapadas. La confirmación exige que la generación y `ips_file_sha256` de
`bind_map_applied` coincidan exactamente con la publicación actual, también al
arrancar. El hash cubre los bytes UTF-8 originales separados por LF, sin LF final;
un archivo vacío tiene cero bytes. Una identidad pendiente solo expresa intención.
La hora del emisor no acredita la aplicación. Cada proceso estricto usa archivos
y sockets de telemetría exclusivos, eliminados después de su salida confirmada.
Una publicación idéntica conserva su generación; una modificación o un resultado
incierto exige una identidad nueva y recarga. Durante una recarga, `pending_apply`
significa que todavía no ha terminado la retirada de lectores y sockets. Una
lista de conexiones vacía y nueva no confirma la retirada en ese estado. Solo
una lectura posterior del estado aplicado o la salida confirmada del proceso
pueden liberar los recursos del host.

La vista de red muestra “Actualizando enlaces” y “Los cambios en los enlaces
todavía se están aplicando. Esperando confirmación.” No afirma que todos los
enlaces se hayan detenido. La muestra fija del emisor se comprueba byte por byte
a través de la telemetría y RPC; su estado pendiente no confirma la retirada.
