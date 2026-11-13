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

Sources are admitted by the journal's own trusted fields, which a message cannot
forge: the CeraUI service, ModemManager, NetworkManager, wpa_supplicant,
hostapd, the kernel and systemd's own unit start/stop/exit/OOM lines. Every
other unit, `sudo` and audit records are withheld, even when they run inside an
admitted service. Runs of withheld records appear as one counted marker, for
example `[REDACTED 12 support log lines]`. Downloading the log of a unit outside
this set yields only such markers.

Admitted records still pass content filters:

- Withheld lines: credentials and keys written as `name=value` or as a phrase
  (stream key, relay account, Wi-Fi key), SRT access-control stream ids, command
  lines and environment assignments, subscriber/device/cell identities and
  serial numbers, PIN/PUK values, coordinates (named or as a decimal pair), NMEA
  sentences, separated hex dumps, long numeric identifiers and phone numbers in
  any common punctuation, and raw modem AT/QMI/MBIM traces and debug output.
- Kept: status and failure text such as "SIM PIN required",
  "missing-or-unknown-apn", "Serial command timed out", registration and state
  changes, NetworkManager failure reasons, USB and power events, process exit
  codes and signals, byte and packet counters. IP and MAC addresses inside such
  lines are replaced with `[address]` rather than removing the line.
- Structured CeraUI events keep the message, timestamp, severity, a known module
  and a fixed set of metadata: error name, code and message (at most 300
  characters, through the same filters; never stacks or causes), exit code,
  signal, interface name, known states, bounded counts and timings, and failure
  reasons. RPC traces keep only procedure, latency and outcome. Unknown or nested
  fields and detached JSON fragments are withheld.

The fixture corpora in `apps/backend/src/tests/support/` hold both sides: lines
that must never appear and diagnostics that must survive, so a fix to one cannot
silently regress the other. Values encoded in ways a filter cannot recognise
(base64, for example) cannot be detected. No unredacted export mode is offered.
A private/custom APN name can itself reveal account context: review exports
before sharing. Existing authentication requirements still apply.

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

Los orígenes se admiten según campos del propio registro que un mensaje no puede
falsificar: el servicio de CeraUI, ModemManager, NetworkManager, wpa_supplicant,
hostapd, el kernel y las líneas de inicio, parada, salida y OOM de systemd. Las
demás unidades, `sudo` y la auditoría se retiran, aunque se ejecuten dentro de un
servicio admitido. Las series retiradas aparecen como una sola marca con su
número, por ejemplo `[REDACTED 12 support log lines]`.

Las entradas admitidas pasan además por filtros de contenido. Se retiran
credenciales y claves (como `nombre=valor` o como frase), identificadores de
flujo SRT, líneas de órdenes y variables de entorno, identidades de suscriptor,
dispositivo o celda, números de serie, PIN/PUK, coordenadas, sentencias NMEA,
volcados hexadecimales, números largos y teléfonos, y trazas AT/QMI/MBIM. Se
conservan los textos de estado y fallo («SIM PIN required»,
«missing-or-unknown-apn», tiempos de espera, cambios de registro, motivos de
NetworkManager, eventos USB y de alimentación, códigos de salida, señales y
contadores); las direcciones IP y MAC se sustituyen por `[address]`. Los eventos
estructurados conservan mensaje, fecha, nivel, módulo y metadatos fijos: nombre,
código y mensaje del error (hasta 300 caracteres, filtrado; nunca pilas), código
de salida, señal, interfaz, estados, contadores, tiempos y motivos. Las trazas RPC
conservan solo procedimiento, latencia y resultado.

Los corpus de `apps/backend/src/tests/support/` contienen lo que nunca debe
aparecer y lo que debe conservarse. Los valores codificados (por ejemplo en
base64) no se pueden detectar. No hay modo sin redactar. Un APN privado puede
revelar información de la cuenta: revisa el archivo antes de compartirlo. Se
mantiene la autenticación existente.
