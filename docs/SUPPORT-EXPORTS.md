# Support log downloads

Settings → System Logs exports retained journal entries across boots, including
previous boots, for the last **7 days**, limited to the **newest 10,000 entries**
per download. The application download filters its service; the system download
does not. Each line shows a boot label, an ISO timestamp and its source. Boot
labels count back from the running boot: `[boot 0]` is this boot, `[boot -1]`
the one before it, and so on. If the running boot has no records in the
download, its newest boot is `[boot -1]`. Host names, raw boot ids and process
ids are not included.

## Limits

- Collection has a **15-second timeout** and a **10 MiB raw output ceiling**.
- If the history read times out, collection retries once for the current boot
  only, with the same limits. If the history exceeds 10 MiB, the single retry is
  the current boot's **newest 400 entries**, which always fit (the journal shows
  fields over 4096 bytes as empty, so one record stays near 25 KB). The file
  states this reduced scope. Two attempts share a 30-second timeout budget; the
  log RPCs allow 45 seconds for redaction and delivery. Other read failures do
  not retry.
- One download runs at a time. A second request while one is collecting gets a
  "already in progress" notice instead of a second journal read.
- Records over **8 KiB**, records the journal split at its line limit and the
  continuation that follows them are withheld before any content filter runs.
  `journalctl` prints a field over 4096 bytes as empty, which includes the
  first piece of such a split; the split is still recognised from its
  line-break marker, so the continuation is withheld too. Backend events over
  4 KiB (large stack traces, for example) are therefore withheld entirely.
- The redacted journal is clipped at 9 MiB with an explicit marker, leaving the
  complete file below 10 MiB. Partial raw output is never sent. Timeout, size,
  read and delivery failures have distinct fixed messages without exception
  text.

Only history still retained by the host journal is available. This does not
enable persistent journaling, restore vacuumed logs, or change disk retention.
A host with a volatile journal cannot supply previous boots.

## Carrier summary

The carrier summary uses existing observations, without running modem commands.
It discloses only the APN name and the IMEI's first eight digits (the type
allocation code, **TAC**, not a tracking area code), for at most 64 modems and
at most 100 characters per APN. Invalid or missing values are omitted; they
never imply a successful observation. Rows use export-local ordinals, not
subscriber, device or cell identities. The APN is a configured profile value,
not proof of the bearer actually used. The summary describes the current
snapshot, not the historical journal entries. If it fails, the journal still
downloads with an explicit summary-unavailable marker.

## What is included and what is withheld

The system download asks the journal only for the admitted sources, so the
10,000-entry budget is spent on candidate evidence: the CeraUI service,
ModemManager, NetworkManager, wpa_supplicant, hostapd, the kernel and systemd
itself (PID 1). A record is admitted only when both its unit and its command
name match, using fields journald sets from the sending process rather than
from the message. Other processes inside an admitted unit, such as the DHCP
server NetworkManager runs for the hotspot (it logs client host names), `pppd`,
`sudo` and audit records, are withheld. Runs of withheld records appear as one
counted marker, for example `[REDACTED 12 support log lines]`, and the file
header states how many records were shown and withheld. Downloading the log of
a unit outside this set yields only such markers.

ModemManager, NetworkManager, wpa_supplicant, hostapd and kernel lines pass an
**allowlist of line shapes**: state and registration changes, network
rejections, bearer and connection failure reasons, supplicant and hotspot
events, USB connect, disconnect, reset and over-current, undervoltage, OOM kills
and similar. The shapes are taken from the format strings the daemons log at
info level or above, for both generations devices run: Debian bookworm
(ModemManager 1.20, NetworkManager 1.42) and trixie (the CeraLive ModemManager
1.24 build, NetworkManager 1.52). The two differ, for example `<info>` against
`<inf>`/`<msg>` and `sys-iface-state:` against `managed-type:`. Debug-only lines
never reach the journal and have no shape. ModemManager 1.24 logs only its
msg, warning and error levels by default, so trixie journals hold no `<inf>`
lines. On trixie the export also reads the 1.24 lines that explain a failed
connection: the SIM lock, failed PIN, enable, registration and packet-service
attach, QMI call-end and verbose call-end reasons, `couldn't start IPv4/IPv6
network`, and critical SIM errors. NetworkManager runs the hotspot
through wpa_supplicant, so access-point events (`AP-ENABLED`,
`AP-STA-CONNECTED`) are read from wpa_supplicant as well as hostapd.

Within an admitted shape, addresses become `[address]`, network, connection
and operator names become `[name]`, connection UUIDs and operator codes `[id]`
and USB serial numbers `[serial]`; reason codes, kernel interface names and
numeric values are kept. Interface names must look like kernel or modem port
names (`wlan0`, `wwan0`, `enp1s0`, `cdc-wdm0`, `ttyUSB2`), so a device named
after a person is withheld. A modem error message after "couldn't …:" or
"failed to connect modem:" keeps only ModemManager's own fixed error phrases,
segment by segment (`Couldn't check unlock status: SIM PIN required`,
`Missing or unknown APN`, QMI protocol errors, ModemManager state names, and
libqmi call-end nicknames after `Call failed`); the first other segment and
everything after it become `[reason]`. The phrase list is generated from the
Debian ModemManager 1.20.4 and 1.24.2 source tarballs, whose SHA-256 sums are
recorded in the generated file
(`apps/backend/scripts/support-reason-vocabulary.ts`). A line that matches no
shape is withheld, so an unfamiliar line costs diagnosis, never privacy. Kernel
text must also match a kernel shape, because any root process can write to the
kernel log.

All admitted text then passes the content filters as a second layer:

- Withheld lines: credentials and keys written as `name=value` or as prose
  ("with password …", "stream id …", "login for …"), SRT access-control stream
  ids, command lines and environment assignments, subscriber/device/cell
  identities and serial numbers, PIN/PUK values, coordinates (named or as a
  decimal pair), NMEA sentences, separated hex dumps, long numeric identifiers
  and phone numbers in any common punctuation, and raw modem AT/QMI/MBIM traces
  and debug output.
- Kept with masking: IPv4 and IPv6 addresses (also with a port, trailing
  punctuation or an `addr:` prefix) and MACs (colon, dash, dotted or bare, DHCP
  client ids, MAC-derived interface names) become `[address]`; quoted SSIDs and
  connection names become `[name]`. Byte and packet counters are kept.
- Withheld as well: text echoing a command line or tool output (`Command
  failed:`, `Command timed out:`, `Command aborted:`, `Spawn timed out:`,
  `exited with code`, `SSID '…'`), e-mail and account addresses, and the host
  name after a failed lookup (`ENOTFOUND host`). Digits joined by any space
  character (including no-break spaces), commas, underscores or colons count
  as one long number. Command errors from the backend's process runner mask
  secret-looking argument values in their own message.
- Structured CeraUI events keep a message only if it is one this code writes.
  The list of message texts is generated from the backend's logger calls
  (`apps/backend/scripts/support-log-messages.ts`; a test fails until it is
  regenerated). Where the code interpolates a value, the export keeps a number,
  an interface name, a supervised process name or a known state or error code,
  and shows `[value]` otherwise. Text the logger appends after the message (an
  error's own message) is `[value]` too. Events also keep the timestamp,
  severity, a known module and a fixed set of metadata: error name and code;
  an error message only if it is an error text the code throws itself (also
  generated, with gaps bounded the same way), a fixed runtime text such as
  `fetch failed`, or a system-call error reduced to its call and code (`spawn
  /usr/bin/srtla_send ENOENT`, `connect ECONNREFUSED [value]`), otherwise
  `[value]`; a reason only if it is a known code or a value the code assigns
  to a `reason` field; exit code, signal, interface name (by the same rule as
  the line shapes), known states, bounded counts and timings, and for a stream
  start failure its class, phase,
  capture cause and retry state (state, attempt, next attempt, maximum
  attempts, delay, suppressed). RPC traces keep only procedure, latency and
  outcome. Unknown or nested fields, correlation ids and detached JSON fragments
  are withheld. Other plain text on the service's output (helper and encoder
  output shares it) is withheld. The generated file also lists the logger
  calls whose message is not literal text; their messages are always withheld.

The fixture corpora in `apps/backend/src/tests/support/` are journal records
with the trusted fields set, run through the same renderer as the download:
lines that must never appear, diagnostics that must survive, and a sample of
three incidents (a modem that does not connect, Wi-Fi that drops, a stream that
stops) for each daemon generation. The sample is assembled from the daemons'
format strings and the backend's own warn/error messages; it is not a device
capture. It checks that the evidence for those incidents survives (105 of 110
records on bookworm formats, 110 of 114 on trixie). It is not a measure of how
much of a real device journal is shown: a real journal holds many lines without
a shape, and those are withheld. Production writes backend events at warn level
and above, so info events do not appear in a download. Values encoded in ways a filter cannot
recognise (base64, for example) cannot be detected. No unredacted export mode is
offered. A private/custom APN name can itself reveal account context: review
exports before sharing. Existing authentication requirements still apply.

# Descargas de registros de soporte

En Configuración → Registros del sistema se exportan las entradas conservadas
de los **últimos 7 días**, incluidos los arranques anteriores, con un máximo de
**10 000 entradas recientes** por descarga. El registro de la aplicación filtra
su servicio; el del sistema no. Cada línea muestra una etiqueta de arranque, la
fecha ISO y su origen. Las etiquetas cuentan hacia atrás desde el arranque en
curso: `[boot 0]` es este arranque y `[boot -1]` el anterior. Si el arranque en
curso no tiene entradas en la descarga, el más reciente es `[boot -1]`. No se
incluyen el nombre del equipo, los identificadores de arranque ni los de
proceso.

## Límites

- La recopilación tiene un límite de **15 segundos** y **10 MiB de salida sin
  procesar**.
- Si el historial agota el tiempo, se intenta una sola vez con el arranque
  actual, con los mismos límites. Si el historial supera 10 MiB, ese único
  intento recoge las **400 entradas más recientes** del arranque actual, que
  siempre caben (el registro muestra vacíos los campos de más de 4096 bytes). El
  archivo indica este alcance reducido. Ambos intentos comparten 30 segundos; las
  llamadas RPC permiten 45 segundos para redactar y entregar. Otros errores de
  lectura no se reintentan.
- Solo se ejecuta una descarga a la vez; una segunda solicitud recibe un aviso
  de que ya hay una en curso.
- Las entradas de más de **8 KiB**, las que el registro partió por su límite de
  línea y su continuación se retiran antes de cualquier filtro.
- El texto redactado se recorta a 9 MiB con una marca explícita; el archivo
  completo queda por debajo de 10 MiB. Nunca se envía una salida parcial sin
  redactar. Los errores tienen mensajes distintos, sin el texto de la excepción.

Solo se incluye el historial que el equipo conserve. No se activa la persistencia
del registro ni se recuperan registros borrados. Un registro volátil no conserva
los arranques anteriores.

## Resumen del operador

Se agrega un resumen de las observaciones actuales de hasta 64 módems: únicamente
el nombre del APN configurado (hasta 100 caracteres) y los primeros ocho dígitos
del IMEI, el código de asignación de tipo (**TAC**). No es el código de área de
seguimiento. Los datos ausentes o inválidos se omiten. El APN configurado no
confirma cuál usó la conexión. El resumen no describe conexiones históricas. Si
falla, el registro se descarga igualmente con una marca de resumen no disponible.

## Qué se incluye y qué se retira

La descarga del sistema solo pide al registro los orígenes admitidos, de modo
que las 10 000 entradas son posibles pruebas: el servicio de CeraUI,
ModemManager, NetworkManager, wpa_supplicant, hostapd, el kernel y el propio
systemd (PID 1). Una entrada se admite solo si coinciden la unidad y el nombre
del proceso, campos que fija journald y que un mensaje no puede falsificar. Los
demás procesos de una unidad admitida, como el servidor DHCP del punto de acceso
(registra los nombres de los clientes), `pppd`, `sudo` y la auditoría, se
retiran. Las series retiradas aparecen como una sola marca con su número, y la
cabecera indica cuántas entradas se muestran y cuántas se retiran.

Las líneas de ModemManager, NetworkManager, wpa_supplicant, hostapd y el kernel
pasan por una **lista de formatos permitidos**: cambios de estado y de registro,
motivos de fallo, eventos del cliente Wi-Fi y del punto de acceso, eventos USB,
subtensión y OOM. Los formatos se toman de los mensajes que los servicios
registran a nivel info o superior en las dos generaciones que usan los equipos:
Debian bookworm (ModemManager 1.20, NetworkManager 1.42) y trixie (ModemManager
1.24 de CeraLive, NetworkManager 1.52). NetworkManager gestiona el punto de
acceso con wpa_supplicant, así que sus eventos se leen también de ahí.
ModemManager 1.24 solo registra por defecto los niveles msg, aviso y error, y en
trixie se leen también sus líneas sobre por qué falló una conexión (bloqueo de
la SIM, PIN, activación, registro, motivos de fin de llamada QMI). Dentro de
un formato, las direcciones pasan a `[address]`, los nombres de red, de conexión
y de operador a `[name]`, los UUID y códigos de operador a `[id]` y los números
de serie USB a `[serial]`; se conservan códigos de motivo, nombres de interfaz
del kernel y valores numéricos. El mensaje de error de un módem solo conserva
las frases fijas de ModemManager, generadas a partir de su código fuente; el
resto pasa a `[reason]`. Una línea sin formato conocido se retira: cuesta
diagnóstico, nunca privacidad. El texto del kernel también debe coincidir con un
formato.

Después, todo pasa por los filtros de contenido. Se retiran credenciales (como
`nombre=valor` o en prosa), identificadores de flujo SRT, líneas de órdenes,
identidades de suscriptor, dispositivo o celda, números de serie, PIN/PUK,
coordenadas, NMEA, volcados hexadecimales, números largos, teléfonos y trazas
AT/QMI/MBIM. Las direcciones IP y MAC (también con puerto, puntuación o en otras
notaciones) pasan a `[address]` y los SSID entre comillas a `[name]`. También se
retiran el texto que repite órdenes o su salida, las direcciones de correo y el
nombre de equipo de una búsqueda fallida. Un evento estructurado solo conserva un
mensaje que este código escribe (lista generada de las llamadas al registro);
donde el código inserta un valor queda un número, una interfaz, un proceso
supervisado o un código conocido, y si no `[value]`. Se conservan también fecha,
nivel, módulo y metadatos fijos: nombre, código y mensaje del error (hasta 300
caracteres, filtrado; nunca pilas), código de salida, señal, interfaz, estados,
contadores, tiempos y, en un fallo de inicio de emisión, su clase, fase, causa
de captura y estado de reintento. El mensaje de un error solo se conserva si es
un texto de error del propio código, un texto fijo del entorno de ejecución o un
error de sistema reducido a su llamada y código; si no, `[value]`. Un motivo
solo se conserva si es un código conocido o un valor que el código asigna. También
se retiran los textos que repiten órdenes (`Command failed:`, `Spawn timed
out:` y similares). Las trazas RPC conservan solo
procedimiento, latencia y resultado. El resto del texto sin estructura del
servicio se retira.

Los corpus de `apps/backend/src/tests/support/` son entradas del registro que
pasan por el mismo código que la descarga: lo que nunca debe aparecer, lo que
debe conservarse y una muestra de tres incidencias (un módem que no conecta, un
Wi-Fi que se cae, una emisión que se detiene) para cada generación, construida a
partir de los formatos de los servicios y de los avisos y errores del propio
backend (no es una captura de un equipo). Comprueba que esas pruebas se
conservan (105 de 110 entradas con bookworm, 110 de 114 con trixie); no mide
cuánto de un registro real se muestra, porque las líneas sin formato se
retiran. En producción el backend solo escribe avisos y errores. Los valores
codificados (por ejemplo en
base64) no se pueden detectar. No hay modo sin redactar. Un APN privado puede
revelar información de la cuenta: revisa el archivo antes de compartirlo. Se
mantiene la autenticación existente.
