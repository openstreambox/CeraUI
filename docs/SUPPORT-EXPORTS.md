# Support log downloads

Settings → System Logs exports retained journal entries across boots, including
previous boots, for the last **7 days**, limited to the **newest 10,000 entries**
per download. The application download filters its service; the system download
does not. Each line shows a boot ordinal (`[boot 1]`, `[boot 2]`, …), an ISO
timestamp and its source; host names, raw boot ids and process ids are not
included.

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
**allowlist of line shapes**: state and registration changes, bearer and
connection failure reasons, supplicant and hotspot events, USB connect,
disconnect, reset and over-current, undervoltage, OOM kills and similar. Within
an admitted shape, addresses become `[address]`, network and connection names
(SSIDs, profile names) become `[name]`, connection UUIDs `[id]` and USB serial
numbers `[serial]`; reason codes, interface names and numeric values are kept.
A line that matches no shape is withheld, so an unfamiliar line costs diagnosis,
never privacy. Kernel text must also match a kernel shape, because any root
process can write to the kernel log.

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
- Structured CeraUI events keep the message, timestamp, severity, a known module
  and a fixed set of metadata: error name, code and message (at most 300
  characters, through the same filters; never stacks or causes), exit code,
  signal, interface name, known states, bounded counts and timings, and failure
  reasons. RPC traces keep only procedure, latency and outcome. Unknown or nested
  fields and detached JSON fragments are withheld. Other plain text on the
  service's output (helper and encoder output shares it) is withheld, except the
  stream loop's exit line.

The fixture corpora in `apps/backend/src/tests/support/` are journal records
with the trusted fields set, run through the same renderer as the download:
lines that must never appear, diagnostics that must survive, and a realistic
sample assembled from upstream daemon log formats (not a device capture), of
which 117 of 139 records survive. Values encoded in ways a filter cannot
recognise (base64, for example) cannot be detected. No unredacted export mode is
offered. A private/custom APN name can itself reveal account context: review
exports before sharing. Existing authentication requirements still apply.

# Descargas de registros de soporte

En Configuración → Registros del sistema se exportan las entradas conservadas
de los **últimos 7 días**, incluidos los arranques anteriores, con un máximo de
**10 000 entradas recientes** por descarga. El registro de la aplicación filtra
su servicio; el del sistema no. Cada línea muestra un número de arranque
(`[boot 1]`, `[boot 2]`, …), la fecha ISO y su origen; no se incluyen el nombre
del equipo, los identificadores de arranque ni los de proceso.

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
subtensión y OOM. Dentro de un formato, las direcciones pasan a `[address]`, los
nombres de red y de conexión a `[name]`, los UUID a `[id]` y los números de serie
USB a `[serial]`; se conservan códigos de motivo, interfaces y valores
numéricos. Una línea sin formato conocido se retira: cuesta diagnóstico, nunca
privacidad. El texto del kernel también debe coincidir con un formato.

Después, todo pasa por los filtros de contenido. Se retiran credenciales (como
`nombre=valor` o en prosa), identificadores de flujo SRT, líneas de órdenes,
identidades de suscriptor, dispositivo o celda, números de serie, PIN/PUK,
coordenadas, NMEA, volcados hexadecimales, números largos, teléfonos y trazas
AT/QMI/MBIM. Las direcciones IP y MAC (también con puerto, puntuación o en otras
notaciones) pasan a `[address]` y los SSID entre comillas a `[name]`. Los eventos
estructurados conservan mensaje, fecha, nivel, módulo y metadatos fijos: nombre,
código y mensaje del error (hasta 300 caracteres, filtrado; nunca pilas), código
de salida, señal, interfaz, estados, contadores, tiempos y motivos. Las trazas RPC
conservan solo procedimiento, latencia y resultado. El resto del texto sin
estructura del servicio se retira, salvo la línea de salida del bucle de envío.

Los corpus de `apps/backend/src/tests/support/` son entradas del registro que
pasan por el mismo código que la descarga: lo que nunca debe aparecer, lo que
debe conservarse y una muestra realista construida a partir de los formatos de
los servicios (no es una captura de un equipo), de la que se conservan 117 de
139 entradas. Los valores codificados (por ejemplo en
base64) no se pueden detectar. No hay modo sin redactar. Un APN privado puede
revelar información de la cuenta: revisa el archivo antes de compartirlo. Se
mantiene la autenticación existente.
