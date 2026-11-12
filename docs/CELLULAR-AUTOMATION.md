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

La implementación es parcial y solo tiene pruebas en el host y en entornos de
prueba. No acredita compatibilidad real con un operador o hardware. Verizon
sigue sin calificar.
