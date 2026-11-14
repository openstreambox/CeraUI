# Engine-less SRT forwarding

An opt-in operator configuration terminates a phone's SRT connection at the box,
then sends the unchanged payload through the normal SRTLA sender to the selected
relay. No decoding, encoding, engine start or engine capability query is involved.

Create `/data/ceralive/srt-forward.json` (mode 0600) with the forwarding settings:

```json
{
  "host": "192.168.4.1",
  "port": 4000,
  "maxbw": 2500000
}
```

These files are operator-owned state, outside the package payload, and survive OTA.
Before package unpack, the installer privately saves old setup metadata only when
it contains forwarding settings. This best-effort snapshot never blocks a package
upgrade if storage or copying fails.
On first boot after upgrading, its legacy `setup.json.srt_forward` block is copied
here if no persistent config exists, preserving its generated credential from
`srt-forward.secret` beside setup.json. Persistent settings then take precedence;
the temporary setup backup is removed once persistent settings are available,
including backups left by an interrupted migration. If cleanup fails, a warning
is logged and valid persistent settings still load.
Edit persistent settings and restart the backend to change forwarding. Remove the legacy block
before removing persistent settings to disable forwarding. Invalid persistent
settings are refused rather than replaced with image defaults.
Generated credentials are written to a private sibling temp file, fsynced,
renamed atomically and followed by directory fsync. Empty or corrupt private
credential files, including legacy credentials during migration, regenerate
automatically with one warning after replacement
(no credential bytes are logged); unsafe paths and permissions are refused.
Both settings and secrets use the shared private-file publisher, enforcing 0600
before writing any bytes, independently of Bun creation-mode behavior.

`host` must be the box's LAN/hotspot IPv4 address (loopback is also accepted for
host tests); wildcard and public binds are refused. Keep the image's LAN-only
firewall policy. The phone is the SRT **caller**, the box the **listener**. Set the
phone's address, port and passphrase accordingly. When omitted, a random
32-character passphrase is generated and retained in
`/data/ceralive/srt-forward.secret` (mode 0600). Read it locally for phone
setup; it is never broadcast. User-chosen passphrases retain the 10–79 character
limit. The passphrase protects the phone hop; it is independent of the relay
credentials.
The optional `relay_passphrase` protects the outgoing SRT hop when the existing
receiver requires it. URLs and tool diagnostics are never logged by this path.
SRT tools receive credentials in argv; restrict local process inspection to trusted
users. Setup/config files remain private device state.

The existing relay selection (account key or manual stream ID), sender executable,
IP list, capability-gated bind-map arguments, control socket and per-link telemetry
are reused. Receiver settings are rechecked on admission and DNS is resolved for
that sender. A selection change while the listener is idle disconnects the caller
and retries with fresh outgoing URLs. An established session keeps its destination
until disconnect. RIST is refused. This listener replaces legacy SRT-to-engine
ingest. Keep image gateways off its address/port. Invalid forwarding configuration
disables this listener without preventing backend boot or opening legacy ingest.

The admission lease covers launch only, ending at relay acceptance or cleanup.
A separate live-forwarding interlock prevents encoder starts and modem mutations
while the forward sender owns the common bond/telemetry resources. Encoder stop
and engine-loss sweeps cannot stop its process or telemetry. Its stats and control
paths both use the independent forwarding port.

The listener supervisor retries faults with 250 ms exponential backoff capped at
8 seconds, reset to 250 ms after relay acceptance. Refusal, sender exit, unreadable
status and a 10-second outgoing
connection timeout shut down the listener, disconnecting the caller so its app
can retry. Cleanup completes before another listener starts. Known stopped
processes report false; unknown is reserved for unconfirmed live activity. The
central 120-second carrying hold still applies after confirmed disconnection.
Forwarding becomes confirmed only when srt-live-transmit reports the outgoing SRT
target connected (the relay handshake through SRTLA), not merely sender spawn.

Both SRT legs set `maxbw`, in bytes/second, default 2,500,000 (20 Mbit/s), configurable
from 125,000 to 12,500,000. This caps outgoing SRT bandwidth, including overhead;
it does not validate MPEG-TS or prevent a hostile LAN client from sending excess
UDP traffic. The stream ID from the phone is ignored: its passphrase is its
credential. The private-address allowlist does not prove a client-facing interface;
choose the LAN/hotspot address and retain the LAN-only firewall policy.

The additive status field `carrying: { state: "streaming" | "idle" | "unknown" }`
projects **client** evidence from `getCarryingLiveness()`, independently of encoder
state. The HUD renders that field without deriving thresholds or adding timers.

The optional native test is run only by the isolated host gate with
`SRT_FORWARD_LOOPBACK=1` and explicit `SRT_FORWARD_TRANSMIT`,
`SRT_FORWARD_RECEIVER`, `SRT_FORWARD_SENDER`, `SRT_FORWARD_SINK` tool paths.
Compile the sink with `cc apps/backend/src/tests/fixtures/srt-forward-sink.c -lsrt -o <sink>`. It uses two loopback
addresses, a local SRTLA receiver and SRT sink, checks unchanged payload receipt,
rejects a wrong phone passphrase, checks the exact outgoing SRT stream ID
(including escaped query characters), both links' counters and disconnect cleanup.
No external relay or hardware qualification is claimed.

## Español (Latinoamérica)

La opción `srt_forward` permite que el teléfono llame por SRT a la dirección LAN
de la caja. La caja termina esa conexión y envía los mismos datos, sin decodificar
ni codificar, al receptor SRTLA configurado. La contraseña del teléfono es
obligatoria e independiente de las credenciales del receptor. La caja escucha;
el teléfono debe usar modo caller. El emisor se detiene al desconectarse el
teléfono. El indicador de transporte usa la protección central de dos minutos;
el estado se confirma solo cuando el receptor acepta la conexión SRT saliente.
Un fallo o un rechazo cierra la conexión del teléfono y reintenta con una espera
exponencial de 250 ms a 8 s. Tras limpiar los procesos, el estado deja de ser
desconocido. El permiso de admisión se libera al confirmar el receptor; una
protección separada evita cambios de módem o inicios del codificador durante el
reenvío. Sin contraseña explícita, se genera una aleatoria de 32 caracteres y se
guarda en /data/ceralive/srt-forward.secret con permisos 0600. La configuración
se guarda en /data/ceralive/srt-forward.json, fuera del paquete, y sobrevive a
las actualizaciones. Se migra la opción antigua de setup.json y su contraseña
cuando no existe configuración persistente. Antes de reemplazar setup.json, el
instalador guarda una copia privada solo si contiene opciones de reenvío. Si falla
la copia, la actualización continúa. La copia se elimina cuando existe la
configuración persistente, incluso tras una migración interrumpida. Si no se puede
eliminar, se registra una advertencia y la configuración válida sigue cargando.
Ambos archivos
se crean con permisos 0600 explícitos antes de escribir datos. Los archivos de contraseña vacíos
o dañados, incluidos los heredados durante la migración, se regeneran y se registra
una advertencia sin mostrar la contraseña; la escritura usa un archivo temporal, fsync, cambio de
nombre atómico y fsync del directorio. La espera se restablece tras aceptar el
receptor. El límite maxbw predeterminado es
2.500.000 bytes/s. Una configuración inválida desactiva el reenvío sin impedir el
arranque. La selección del receptor se vuelve a comprobar en cada admisión y su
IP se resuelve antes de iniciar el emisor. Las pruebas son locales y no califican
el hardware ni una red móvil.
