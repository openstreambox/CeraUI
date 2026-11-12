# Automatic cellular profiles

## English

For an existing automatic profile on an admitted modem/firmware transport,
recognized subscription home MCC/MNC, SPN and GID select a stored APN and IPv4v6 request. The cellular
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
explicit activation only after preparation. An admitted self-registering
transport disarms its exact automatic profile before registration, including a
recognized but unqualified subscription; it changes neither APN/family nor radio
state and does not authorize activation. Manual saves release the original
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

The existing modem poll now joins a connected MM bearer, the exact active NM
profile's lease/DNS and healthy indexed kernel addresses. An automatic source is
excluded before discovery until its retained owner proves readiness. Serving
network identity never substitutes for unreadable subscription home identity.
Manual profiles retain their existing policy. IPv4 uses its native host path;
an IPv6-only grant uses finite DNS64 discovery followed by per-uplink CLAT.

The native host adapter now composes its private routes, output fence and durable
inverse. Cleanup denies traffic before waiting for fresh sender withdrawal, and
retired callbacks cannot change a successor. A disconnected kernel fixture also
checks complete link removal; it does not establish USB or modem qualification.

The native host can also own an internal-call adapter's exact IPv4 `/32` with
explicit physical USB/index authority. Its durable fence precedes the address
and private routes. Cleanup waits for consumer release, removes only that indexed
address and leaves NM-owned addresses alone. A pre-existing address is not
adopted; a replacement interface or changed address attributes retain the inverse.
Positive old-index absence can retire an old address without touching a reused
name. This host component does not activate an internal modem call.

Managed cellular paths require both sender capabilities, `bind_map_required`
and `bind_map_required_empty_reload`, plus an integer `bind_map_contract >= 1`,
and the opt-in `--require-bind-map` contract. The revision establishes assigned
canonical-unicast binding and joined, coherent withdrawal acknowledgement. A
missing, zero, noninteger or string revision cannot authorize managed links.
The required-binding resolver returns
both binding flags or a typed refusal; it never chooses source-only fallback.
Installed image and physical qualification remain required.
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
disconnected component proofs; installed process lifetime and physical
NM/RA/hotspot coexistence remain gates.

The translated host adapter now combines exact address/proxy effects, private
source routes, output and forwarding fences, scoped link settings and translator
supervision. A retained outer owner records a random TUN birth before creation
and records child submission before installation. Recovery can withdraw and
reverse a retained birth; it cannot resume installation. Unknown identities,
cross-boot replacements and remaining foreign references retain the inverse and
the slot lease. Removal checks references before stopping the translator,
removing its address or bringing the link down, since those operations can
implicitly remove routes. A changed grant immediately revokes setup writes;
the old owner retains permission to deny and clean up.

The disconnected packet fixture exercises this composition with private child
supervision, including a foreign route that must survive refused cleanup. It
does not qualify installed system-service supervision or production admission,
the installed startup lifetime or physical modem operation. Those
qualification gates remain open.

Bond publication now serializes launch, refresh and withdrawal writes. Captured
rows retain their original source observation; withdrawal or an identical-address
successor makes old callbacks ineligible. A change during a submitted file
operation receives one bounded restrictive republication before completion.
A superseded observation makes the last publication unavailable to the binding resolver.
Refresh publishes a valid empty bond when the final link withdraws, while launch
still refuses an empty bond. Production admission for managed cellular paths
remains gated.

New sender launches prefer strict binding when both capabilities are present,
including launches that may gain a cellular link later. A supervised legacy
sender cannot admit a managed cellular row. An unavailable required mapping or
capability returns the typed `sender_binding_unavailable` failure with localized
operator guidance. Existing stream admission and subprocess ownership remain
the only lifecycle authorities.

Withdrawal receipts belong to the exact withdrawn source observation and actual
supervised producer. Their evidence boundary follows restrictive publication,
drainage of earlier queued writes and a targeted reload. A fresh empty
`pending_apply` snapshot is never acknowledgement: reader/socket teardown must
finish before the producer publishes its applied disposition. The Network view
shows “Updating links” and “Link changes are still being applied. Waiting for
confirmation.” Old watchers, late
control acquisitions and old capability replies cannot populate a replacement
telemetry lifetime. Fresh absence of the old link from that strict producer, or
positive exit of the captured process, can acknowledge closed sockets. No owned
sender and no telemetry is still unknown without a positive qualified consumer
census. Runtime absence holds the existing lifecycle interlock through cleanup;
it never substitutes an idle stream flag for closed descriptors.
Startup replay now inventories native and translated host authority before modem
rollback. Unknown, misplaced and orphan auxiliary records keep the existing
recovery barrier raised. Every host JSON/configuration write participates in the
same journal revision; runtime verification remains read-only. Interrupted host
installation never resumes during replay.

Native plans are immutable and boot-bound. A matching resource on another boot
cannot be adopted for cleanup; only complete positive kernel absence can retire
its private cursor. A failed directory acknowledgement after unlink is retried
before releasing ownership. The routing namespace fixture reconstructs a native
host from its actual retained inventory, denies traffic while consumer release
is unknown, and retries cleanup with the same owner.

Consumer absence requires a stable, nondelegated service cgroup, with group
cleanup and forced termination enabled. Its members must be the backend main
process and positively qualified fixed-command NM observers from their actual
subprocess owner. Observer parent/start identity, argv and descriptor inventories
must remain stable; every socket must be positively AF_UNIX or NETLINK. Unknown
children, INET/raw sockets, TUN descriptors, subgroups, changed invocation or
failed reads refuse cleanup. Startup also holds the existing recovery barrier;
runtime holds the existing stream-admission interlock. The real NM fixture
checks the actual observer, but installed service and crash/reboot qualification
remain gates.

IPv6-only discovery now has its own finite host stage. It records a boot-bound
inverse before adding a DNS-only private table, source/device rules and an exact
IPv6 output fence. Only the grant's resolvers are queried, after a durable
budget reservation. Neighbour discovery remains available; arbitrary output
and DNS during withdrawal are denied. Aborting a probe is insufficient for
cleanup: its actual promise must settle before any route is removed.

The stage closes completely before a translator can acquire the same slot, and
the grant must be revalidated between stages. Their tables and protocols are
independent; neither adopts matching resources from the other. Startup can only
withdraw an interrupted discovery. An isolated DNS64 provider proves discovery
without a usable uplink main default, private-route loss without a LAN fallback,
and retained cleanup.

A runtime wrapper is retained before its first install effect. It completely
retires discovery before final host installation, including after an uncertain
reply. Grant changes cancel probes and deny traffic; an ignored cancellation
cannot authorize inverse cleanup until the real promise settles. Fresh DNS64
prefix changes invalidate translation without counting a carrier failure.
Per-pair probe reservations are capped at ten MiB daily. Short whole-USB absences
withdraw availability without resetting the modem or charging a carrier failure.
The existing poll owns retries; no second production controller is installed.
Native traffic recovery now reconnects only after the retained host inverse and
consumer withdrawal complete. The existing modem lease journals the exact
device/SIM/subscriber, admitted transport and home/profile digests before calls.
Fresh MM identity, NM active UUID or positive idle state, registration and
transport preparation are rechecked before each dispatch. USB loss or changed
SIM/profile/permission cannot authorize another call. Lost command replies need
positive readback; uncertain effects retain the existing mutation block and
cannot republish. Recovery never resets USB or rewrites carrier settings.

Startup may verify an already-active exact profile, or restore an interrupted
call only with fresh positive preparation. A cold-boot RM520 without that proof
remains blocked; automatic reboot restoration is still a physical qualification
gate. Failed transactions retain the existing operator-resolution semantics.
FM350 activation and installed image qualification remain incomplete.

CLAT allocation also accepts an exact kernel host `/128` when the current modem
grant positively delegates the matching `/64`. The retained birth plan records
that delegation and installation revalidates it. A host mask alone, a different
source/prefix or a foreign address, route or proxy cannot authorize allocation.
The isolated packet proof covers translation in both directions with that host
mask; it does not establish physical modem qualification.

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

El sondeo existente del módem combina la concesión MM conectada, las direcciones
y DNS del perfil NM activo exacto y las direcciones sanas del índice del kernel.
Un origen automático queda excluido antes del descubrimiento hasta que su
propietario retenido compruebe la disponibilidad. La red visitada no sustituye
la identidad de origen de la suscripción. Los perfiles manuales conservan su
política. IPv4 usa la ruta nativa; una concesión solo IPv6 usa una búsqueda DNS64
finita y después CLAT por enlace.

El adaptador nativo del host combina sus rutas privadas, su filtro de salida y
el registro para restauración. La limpieza bloquea el tráfico antes de esperar
una confirmación nueva de retirada del emisor. Los procesos antiguos no pueden
cambiar el enlace que los sustituye. Una prueba aislada del kernel también
comprueba la eliminación completa de la interfaz; no acredita el USB ni el módem.

El host nativo también puede administrar la dirección IPv4 `/32` exacta de una
llamada interna con identidad USB e índice físicos explícitos. Registra el filtro
antes de añadir la dirección y las rutas privadas. La limpieza espera a los
consumidores, elimina solo esa dirección por índice y conserva las direcciones
de NM. No adopta direcciones existentes; una interfaz de reemplazo o atributos
cambiados conservan el registro. La ausencia acreditada del índice antiguo
permite retirarlo sin tocar un nombre reutilizado. Este componente no activa la
llamada interna del módem.

Los enlaces celulares administrados requieren las dos capacidades del emisor,
`bind_map_required` y `bind_map_required_empty_reload`, además de un entero
`bind_map_contract >= 1`, y el modo opcional
`--require-bind-map`. El adaptador devuelve ambas
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

El adaptador traducido combina direcciones y vecinos proxy exactos, rutas
privadas, filtros de salida y reenvío, ajustes por interfaz y supervisión del
traductor. Un propietario retenido registra una identidad aleatoria antes de
crear la TUN y registra el intento de instalar el adaptador antes de iniciarlo.
La recuperación solo puede retirar y restaurar ese estado; no reanuda la
instalación. Las identidades desconocidas, las sustituciones tras reiniciar y
las referencias ajenas conservan el registro y la exclusión del enlace. Antes
de detener el traductor, quitar su dirección o bajar la interfaz, se comprueban
las referencias, porque esas operaciones pueden eliminar rutas implícitamente.
Un cambio de concesión revoca las escrituras de instalación de inmediato y
conserva el permiso para bloquear y limpiar el estado anterior.

La prueba aislada de paquetes usa esta composición con un proceso privado y
comprueba que una ruta ajena sobreviva a una limpieza rechazada. No acredita la
supervisión por el gestor de servicios instalado, la admisión de producción,
la confirmación del emisor, la vida del servicio instalado ni el módem físico. Esas
pruebas e integraciones siguen pendientes.

La publicación del conjunto de enlaces serializa las escrituras de inicio,
actualización y retirada. Cada fila conserva su observación original; una
retirada o una concesión nueva con la misma dirección invalida los procesos
antiguos. Si cambia durante una escritura ya enviada, se realiza como máximo
una publicación restrictiva adicional antes de finalizar. Una observación sustituida hace que el mapa anterior deje de estar disponible
para el adaptador de vinculación. La actualización publica un conjunto
vacío válido cuando se retira el último enlace; el inicio sigue rechazando un
conjunto vacío. La admisión de producción para los enlaces celulares
administrados sigue pendiente.

Los nuevos emisores prefieren la vinculación estricta cuando están presentes
ambas capacidades, incluso si el enlace celular se añade después. Un emisor
supervisado en modo anterior no puede admitir una fila celular administrada.
Un mapa o una capacidad requerida no disponible devuelve el error tipado
`sender_binding_unavailable`, con indicaciones localizadas. La admisión de
transmisión y el propietario de los procesos siguen controlando su ciclo de vida.

La confirmación de retirada pertenece a la observación retirada y al proceso
emisor exactos. Su prueba debe ser posterior a la publicación restrictiva,
la finalización de escrituras anteriores y la recarga dirigida. Una lectura
vacía nueva con `pending_apply` nunca confirma el cierre de sockets; el emisor
debe terminar la retirada y publicar el estado aplicado. La vista de red muestra
“Actualizando enlaces” y “Los cambios en los enlaces todavía se están aplicando.
Esperando confirmación.” Un observador,
una conexión de control o una respuesta de capacidades antiguos no pueden
actualizar la telemetría del emisor nuevo. La ausencia del enlace en una lectura
nueva de ese emisor estricto, o su salida confirmada, puede acreditar el cierre
de los sockets. La falta de un emisor supervisado o de telemetría sigue siendo
desconocida sin una comprobación positiva al iniciar.

La recuperación al iniciar ya comprueba el inventario de autoridad nativa y
traducida antes de restaurar el módem. Los registros desconocidos, mal ubicados
o auxiliares huérfanos mantienen la barrera existente. Todas las escrituras de
JSON y configuración del host comparten la misma revisión del registro; la
verificación durante el funcionamiento sigue siendo de solo lectura. La
recuperación nunca reanuda una instalación interrumpida.

Los planes nativos son inmutables y pertenecen a un arranque concreto. Un
recurso idéntico en otro arranque no permite adoptarlo ni eliminarlo; solo una
comprobación completa de ausencia permite retirar el registro privado. Si falla
la confirmación del directorio después de borrar el archivo, se reintenta antes
de liberar la exclusión. La prueba de rutas aislada reconstruye el host nativo
a partir de su inventario real, bloquea el tráfico mientras no se confirme la
retirada de consumidores y reintenta con el mismo propietario.

La ausencia de consumidores requiere un cgroup de servicio estable, sin
delegación, con limpieza del grupo y terminación forzada habilitadas. Solo admite
el proceso principal y observadores NM de comando fijo acreditados por su
propietario real. Se comprueban el padre, el inicio, los argumentos y los
descriptores; cada socket debe ser AF_UNIX o NETLINK. Un proceso desconocido,
un socket INET o sin identificar, una TUN, un subgrupo o una lectura fallida
bloquean la limpieza. Al iniciar se conserva la barrera de recuperación;
durante el funcionamiento se mantiene la exclusión de admisión de transmisión.
La prueba NM comprueba el observador real. La vida del servicio instalado y las
pruebas físicas de interrupción y reinicio siguen pendientes.

La búsqueda de NAT64 en una concesión solo IPv6 ya tiene una etapa finita del
host. Registra una restauración vinculada al arranque antes de añadir una tabla
privada exclusiva para DNS, reglas de origen y dispositivo, y un filtro IPv6
exacto. Consulta solo los resolutores de la concesión, después de reservar un
presupuesto duradero. Permite el descubrimiento de vecinos y bloquea otras
salidas, incluido DNS durante la retirada. Cancelar el sondeo no basta: su
promesa debe finalizar antes de quitar las rutas.

La etapa se cierra por completo antes de que el traductor adquiera el mismo
espacio, y se debe volver a comprobar la concesión entre etapas. Sus tablas y
protocolos son independientes; ninguna adopta recursos idénticos de la otra.
Al iniciar solo se puede retirar una búsqueda interrumpida. Un proveedor DNS64
sintético aislado comprueba la búsqueda sin una ruta predeterminada útil en el
enlace, la pérdida de la ruta privada sin recurrir a la LAN y la limpieza
retenida.

El propietario de ejecución se conserva antes del primer efecto. Retira por
completo la búsqueda antes de instalar el host final, incluso tras una respuesta
incierta. Un cambio de concesión cancela los sondeos y bloquea el tráfico; la
cancelación no permite limpiar hasta que termine la promesa real. Un prefijo
DNS64 nuevo invalida CLAT sin contarlo como fallo del operador. Las reservas por
pareja se limitan a diez MiB diarios. Una ausencia breve del USB retira la
disponibilidad sin reiniciar el módem ni contar un fallo del operador. El sondeo
existente controla los reintentos; no se instala otro controlador de producción.
La recuperación nativa reconecta solo después de terminar la retirada de
consumidores y la restauración del host. La exclusión existente registra la
identidad exacta del dispositivo, SIM y suscriptor, el transporte admitido y los
resúmenes del operador de origen y del perfil antes de actuar. Vuelve a comprobar
MM, el UUID activo de NM o su estado desconectado, el registro y la preparación
del transporte antes de cada llamada. Una pérdida USB o un cambio de SIM, perfil
o permiso no autorizan otra llamada. Una respuesta perdida necesita una lectura
positiva; un efecto incierto conserva el bloqueo existente e impide publicar.
La recuperación no reinicia USB ni reescribe ajustes del operador.

Al iniciar se puede verificar el perfil exacto ya activo, o restaurar una llamada
interrumpida solo con preparación nueva acreditada. Un RM520 recién arrancado
sin esa prueba sigue bloqueado; su restauración automática tras reiniciar sigue
pendiente de calificación física. Las transacciones fallidas conservan la
resolución por el operador existente. La activación FM350 y la calificación de
la imagen instalada siguen incompletas.

La asignación CLAT también admite una dirección exacta `/128` del kernel cuando
la concesión actual del módem acredita el `/64` correspondiente. El registro de
creación conserva esa delegación y se vuelve a comprobar antes de instalar. La
máscara del host por sí sola, otro origen o prefijo, o recursos ajenos no dan
permiso para asignar. La prueba aislada comprueba ambas direcciones de traducción
con esa máscara; no acredita el módem físico.

La implementación es parcial y solo tiene pruebas en el host y en entornos de
prueba. No acredita compatibilidad real con un operador o hardware. Verizon
sigue sin calificar.
