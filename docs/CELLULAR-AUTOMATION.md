# Automatic cellular profiles

## English

For an existing automatic profile on an admitted modem/firmware transport,
recognized subscription evidence selects a stored APN and IPv4v6 request. The cellular
poll owner applies it under the modem lifecycle lease and a durable inverse
journal. It verifies the settings after the write. Manual profiles, unknown
subscriptions, unqualified carriers and unknown transport firmware are preserved.
The profile must match both device and SIM; an operator-only match is insufficient.

Automatic intent is stored privately for the exact profile, device and SIM,
separately from NetworkManager's `gsm.auto-config` switch. NetworkManager must
turn that switch off to use the selected APN. A manual save explicitly retires
automatic intent, even when it keeps the same APN. An out-of-band custom APN
that conflicts with the last applied automatic APN is preserved. Unreadable
intent defers reconciliation. Carrier selection always uses fresh subscription
evidence; the saved APN is only a conflict check.

Automatic intent and modem preparation decisions use the persistent data store.
Before default access can treat a record as absent, it checks and migrates the
older OS-slot record. The original remains intact; a durable migration receipt
prevents later updates or deletion from reviving that old baseline. Conflicting,
changed or unreadable authority defers work. A spent EPS attempt remains spent.
Startup inventories all retained pairs, including absent SIMs. Damaged state
keeps the existing recovery wait active until a complete check succeeds.

This changes stored settings for the next activation. It does not disconnect an
active bearer or initiate another call. IPv6 contributes no main default route
or automatic DNS. A failed write is restored and verified; an inverse that cannot
be verified leaves the existing mutation block in place. Recovery checks the
current physical identity and SIM before touching the saved profile.

New profiles are created under the lifecycle lease with a preallocated identity,
a durable inverse and autoconnect off. Discovery itself does not create profiles
or copy settings from another SIM's operator code. An interrupted creation may
remove only its exact, inactive, disarmed profile. Unknown subscriptions on a
new owned profile can use NetworkManager's automatic provider lookup when that
capability has been verified; existing unknown/manual policy is preserved.

For admitted RM520 firmware, preparation records and reads back QMAP settings
per physical unit and USB generation. It records the original initial-EPS
settings and spends at most one alignment attempt per equipment/SIM pair before
sending a setter, including a setter that fails. A fresh generation must verify
the result. Failure retains a blocked state and private baseline. Raw-IP setup
requires withdrawn global addresses and precedes the host call. An expected USB
return has a bounded wait; it does not launch repeated resets. Serial endpoints
are rediscovered by USB interface. The inhibition session is revoked if the
service owner changes or its bus connection is lost.

Owned automatic profiles stay disarmed in NetworkManager: CeraUI admits their
explicit activation only after preparation. Manual saves release the original
autoconnect choice (or enable a newly created manual profile). Interrupted
firmware preparation is held for explicit recovery rather than claiming an
unverified restoration. This has host/fixture evidence only.

The retained internal-call adapter distinguishes registration from address grants
and preserves the full understood PDP-context baseline. Its reversible host
handoff suppresses RA defaults and transfers the physical network device from
NetworkManager before modem inhibition. Link-up follows stable registration and
precedes the internal call. The real NetworkManager fixture verifies its managed
flag and RA/link restoration. Failed cleanup retains ownership. Production
activation and startup recovery integration remain incomplete; this adapter does
not enable RNDIS by itself.

Per-uplink data-plane helpers keep source/device identity, readiness, bounded
DNS/HTTPS checks and cleanup separate from registration. Namespace checks cover
routing withdrawal, duplicate native addresses and both HTTPS bindings. Production
host composition, translator supervision and startup recovery remain incomplete;
these helpers do not enable CLAT or traffic health by themselves.

The native host adapter now composes its private routes, output fence and durable
inverse. Cleanup denies traffic before waiting for fresh sender withdrawal, and
retired callbacks cannot change a successor. A disconnected kernel fixture also
checks complete link removal; it does not establish USB or modem qualification.

Managed cellular paths require the sender's `bind_map_required` capability and
the opt-in `--require-bind-map` contract. The required-binding resolver returns
both binding flags or a typed refusal; it never chooses source-only fallback.
Production activation remains held until this path is composed and qualified.
The producer's empty `required_binding_refused` snapshot is understood by the
telemetry/RPC consumers. The Network view displays “Waiting for link mapping”
and “No links are sending yet. Check that the network devices are connected.
Sending can start once the link mapping is valid.”

The translated route fixture now crosses an independent NAT64 provider in a
second network namespace and receives the UDP reply. Packet captures verify the
pinned translator's computed-zero UDP correction in both IPv6 and IPv4 output.
Reverse-path filtering remains enabled. A translated source lookup covers that
validation without an output-device selector; its ready output fence still
permits only the owned kernel device and denies every other egress. A deliberate
duplicate source on the simulated LAN cannot bypass that fence. Withdrawal and
route removal preserve the LAN default and packet counters. The minimum-MTU
case keeps the IPv6 TUN at 1280 and its IPv4 route at 1260.

CLAT admission requires readable per-link `force_forwarding` on both ingress
interfaces. Global forwarding alone grants no admission, and this component
never writes global/default forwarding. The fixture checks both ingress
directions with global forwarding unchanged. Missing capability, stale identity
and contradictory reads stay refused. Address/proxy effects use kernel indices,
exact inventories and dispatch permits; existing proxy entries are refused
before add because Linux may acknowledge duplicate proxy adds. These are
disconnected component proofs; production translated-host composition,
process/startup recovery and physical NM/RA/hotspot coexistence remain gates.

This is a partial implementation with host/fixture evidence. It does not
establish carrier/hardware qualification. Existing or synthetic test results
do not establish those capabilities. Verizon remains unqualified.

## Español (Latinoamérica)

Un perfil automático existente puede recibir un APN y solicitar IPv4v6 cuando la suscripción se
reconoce y el transporte del módem y su firmware están admitidos. El proceso
celular actualiza los ajustes guardados con exclusión de mutaciones y un registro
persistente para restaurarlos. Después verifica los valores escritos. Conserva
los perfiles manuales, las suscripciones desconocidas, los operadores sin
calificar y el firmware no admitido. El perfil debe coincidir con el dispositivo
y con la SIM; coincidir solo con el operador no basta.

El modo automático se guarda de forma privada para el perfil, el dispositivo y
la SIM, por separado de `gsm.auto-config` de NetworkManager. Ese ajuste debe
desactivarse para usar el APN seleccionado. Guardar un perfil manual retira el
modo automático incluso si mantiene el mismo APN. Un APN personalizado cambiado
por otra herramienta se conserva si difiere del último APN automático aplicado.
Si el registro privado no se puede leer, la actualización se aplaza. El APN
guardado nunca identifica al operador; se usan datos actuales de la suscripción.

El modo automático y las decisiones de preparación del módem se guardan en el
almacenamiento persistente de datos. Antes de considerar ausente un registro, el
acceso predeterminado comprueba y migra el registro de la partición anterior del
sistema. Conserva el original y registra la migración de forma duradera para que
un cambio o una eliminación posterior no reactive los ajustes antiguos. Un
conflicto, cambio o error de lectura aplaza el trabajo. Un intento EPS ya usado
no se vuelve a habilitar.
Al iniciar se revisan todos los pares guardados, incluso las SIM ausentes. Un
registro dañado mantiene la espera de recuperación hasta completar la revisión.

El cambio se aplica en la siguiente activación. No desconecta una conexión activa
ni inicia otra llamada de datos. IPv6 no agrega una ruta predeterminada ni DNS
automático al sistema. Si una escritura falla, se restauran y verifican los
ajustes anteriores. Si la restauración no se puede verificar, el dispositivo
permanece bloqueado para nuevas mutaciones. La recuperación comprueba la identidad
física y la SIM antes de cambiar el perfil guardado.

Los perfiles nuevos se crean con exclusión de mutaciones, identidad preasignada,
registro persistente para restauración y conexión automática desactivada. El
descubrimiento solo lee datos; no copia ajustes de otra SIM por el código del
operador. La recuperación solo elimina el perfil exacto, inactivo y desarmado
que creó. Una suscripción desconocida puede usar la búsqueda automática de
proveedores de NetworkManager en un perfil nuevo propio si esa capacidad está
comprobada. Se conservan las políticas existentes desconocidas o manuales.

En el firmware RM520 admitido, se guardan y verifican los ajustes QMAP por unidad
y generación USB. Se conservan los ajustes iniciales EPS y se permite un solo
intento de alineación por equipo y SIM, registrado antes de enviar el cambio,
aunque este falle. Una generación nueva debe verificar el resultado. Un fallo
conserva el bloqueo y los ajustes originales privados. Raw-IP exige retirar las
direcciones globales antes de la llamada de datos. La espera de retorno USB es
limitada y no provoca reinicios repetidos. El puerto serie se resuelve por la
interfaz USB; perder el servicio o la conexión de control revoca la sesión.

Los perfiles automáticos propios mantienen desactivada la conexión automática
de NetworkManager. CeraUI solo inicia la conexión después de preparar el módem.
Guardar un perfil manual restaura la elección anterior de conexión automática,
o la activa para un perfil manual nuevo. Una preparación de firmware interrumpida
requiere recuperación explícita; no se supone que se haya restaurado. Estos
cambios solo tienen pruebas en el host y en entornos de prueba.

El adaptador de llamada interna distingue el registro de las direcciones
asignadas y conserva el contexto PDP entendido completo. La transferencia
reversible del host suprime las rutas predeterminadas de RA y retira el control
del dispositivo físico de NetworkManager antes de inhibir el módem. Después del
registro estable, activa la interfaz antes de la llamada interna. Una prueba con
NetworkManager real verifica su control y la restauración de RA y de la interfaz.
Una limpieza fallida conserva la propiedad. La activación y la recuperación al
iniciar siguen incompletas; este adaptador no activa RNDIS por sí solo.

Las herramientas de tráfico por enlace separan la identidad de origen y del
dispositivo, la disponibilidad, las pruebas DNS/HTTPS limitadas y la limpieza del
registro. Las pruebas aisladas cubren la retirada de rutas, las direcciones nativas
duplicadas y ambas vinculaciones HTTPS. La composición del host, la supervisión
del traductor y la recuperación al iniciar siguen incompletas; estas herramientas
no activan CLAT ni las comprobaciones de tráfico por sí solas.

El adaptador nativo del host combina sus rutas privadas, su filtro de salida y
el registro para restauración. La limpieza bloquea el tráfico antes de esperar
una confirmación nueva de retirada del emisor. Los procesos antiguos no pueden
cambiar el enlace que los sustituye. Una prueba aislada del kernel también
comprueba la eliminación completa de la interfaz; no acredita el USB ni el módem.

Los enlaces celulares administrados requieren la capacidad `bind_map_required`
del emisor y el modo opcional `--require-bind-map`. El adaptador devuelve ambas
opciones de vinculación o una negativa tipada, sin usar solo la dirección de
origen como alternativa. La activación de producción sigue pendiente de
composición y pruebas. Los lectores de telemetría y RPC reconocen el estado
vacío `required_binding_refused` del emisor. La vista de red muestra
“Esperando el mapeo de enlaces” y “Todavía no se están enviando datos por ningún
enlace. Comprueba que los dispositivos de red estén conectados. El envío podrá
empezar cuando el mapeo de enlaces sea válido.”

La prueba de rutas traducidas ya cruza un proveedor NAT64 en otro espacio de
nombres de red y recibe la respuesta UDP. Las capturas comprueban la corrección
de sumas UDP calculadas como cero en ambas salidas, IPv6 e IPv4, con el traductor
fijado. La validación de ruta inversa sigue activa. La regla del origen traducido
cubre esa validación sin seleccionar una interfaz de salida; el filtro de salida
solo permite la interfaz propia. Ni un origen duplicado en la LAN simulada puede
evitarlo. La retirada y la eliminación de rutas conservan la ruta predeterminada
y los contadores de la LAN. Con la MTU mínima, la interfaz IPv6 conserva 1280
y su ruta IPv4 usa 1260.

La admisión de CLAT requiere `force_forwarding` legible en las dos interfaces
de entrada. El reenvío global por sí solo no permite la admisión, y este
componente nunca modifica el reenvío global ni sus valores predeterminados.
La prueba comprueba ambas direcciones sin cambiar ese valor global. La ausencia
de la capacidad, una identidad antigua o lecturas contradictorias bloquean la
admisión. Las operaciones de direcciones y vecinos proxy usan índices del kernel
e inventarios exactos; rechazan entradas proxy existentes antes de añadirlas.
Estas pruebas aisladas no acreditan la composición de producción, la recuperación
al iniciar ni la convivencia física con NM, RA y el punto de acceso.

La implementación es parcial y solo tiene pruebas en el host y en entornos de
prueba. No acredita compatibilidad real con un operador o hardware. Verizon
sigue sin calificar.
