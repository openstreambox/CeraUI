# Support log downloads

Settings → System Logs exports retained journal entries across boots, including
previous boots, for the last **7 days**, limited to the **newest 10,000 entries**
per download. The application download filters its service; the system download
does not. Both use ISO timestamps and retain journal reboot separators.
Collection has a **15-second timeout** and a **10 MiB raw output ceiling**. If
collection exceeds either limit, the download fails with a retryable error;
partial raw output is never sent. The redacted journal text is clipped at 9 MiB
with an explicit marker, leaving the complete file below 10 MiB. A short carrier summary (at most 64 modems,
at most 100 characters per APN) is appended after redaction.

Only history still retained by the host journal is available. This does not
enable persistent journaling, restore vacuumed logs, or change disk retention.
A host with a volatile journal cannot supply previous boots.

The carrier summary uses existing observations, without running modem commands.
It discloses only the APN name and the IMEI's first eight digits (the type
allocation code, **TAC**, not a tracking area code). Invalid or missing values
are omitted; they never imply a successful observation. Rows use export-local
ordinals, not subscriber, device or cell identities. The APN is a configured
profile value, not proof of the bearer actually used. The summary describes the
current snapshot, not the historical journal entries.

Historical journal lines containing subscriber/device/cell identifiers,
credentials or long numeric identifiers are removed conservatively as whole
lines before either the RPC result or the pushed download is sent. Full IMEI,
ICCID, IMSI, phone numbers and cell identity are not part of the summary. Normal
logger and shadow-evidence redaction remain unchanged. No unredacted export mode
is offered. A private/custom APN name can itself reveal account context: review
exports before sharing. Existing authentication requirements still apply.

# Descargas de registros de soporte

En Configuración → Registros del sistema se exportan las entradas conservadas
de los **últimos 7 días**, incluidos los arranques anteriores, con un máximo de
**10 000 entradas recientes** por descarga. El registro de la aplicación filtra
su servicio; el del sistema no. La recopilación tiene un límite de **15 segundos**
y **10 MiB de salida sin procesar**. Si supera un límite, falla y permite
reintentar; nunca se envía una salida parcial sin redactar. El texto redactado se recorta a 9 MiB con una marca
explícita; el archivo completo queda por debajo de 10 MiB.

Solo se incluye el historial que el equipo conserve. No se activa la persistencia
del registro ni se recuperan registros borrados. Un registro volátil no conserva
los arranques anteriores.

Se agrega un resumen de las observaciones actuales de hasta 64 módems: únicamente
el nombre del APN configurado (hasta 100 caracteres) y los primeros ocho dígitos
del IMEI, el código de asignación de tipo (**TAC**). No es el código de área de
seguimiento. Los datos ausentes o inválidos se omiten. El APN configurado no
confirma cuál usó la conexión. El resumen no describe conexiones históricas.

Las líneas históricas con identificadores de suscriptor, dispositivo o celda,
credenciales o identificadores numéricos largos se eliminan por completo antes
de enviar el archivo. El resumen nunca incluye IMEI completo, ICCID, IMSI,
teléfono ni identidad de celda. La redacción habitual permanece activa, sin modo
sin redactar. Un APN privado puede revelar información de la cuenta: revisa el
archivo antes de compartirlo. Se mantiene la autenticación existente.
