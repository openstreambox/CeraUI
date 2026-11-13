# Engine-less SRT forwarding

An opt-in image configuration terminates a phone's SRT connection at the box,
then sends the unchanged payload through the normal SRTLA sender to the selected
relay. No decoding, encoding, engine start or engine capability query is involved.

Set `srt_forward` in the private device `setup.json`:

```json
{
  "srt_forward": {
    "host": "192.168.4.1",
    "port": 4000,
    "passphrase": "replace-with-a-private-phrase"
  }
}
```

`host` must be the box's LAN/hotspot IPv4 address (loopback is also accepted for
host tests); wildcard and public binds are refused. Keep the image's LAN-only
firewall policy. The phone is the SRT **caller**, the box the **listener**. Set the
phone's address, port and passphrase accordingly. The required 10–79 character
passphrase protects the phone hop; it is independent of the relay credentials.
The optional `relay_passphrase` protects the outgoing SRT hop when the existing
receiver requires it. URLs and tool diagnostics are never logged by this path.
SRT tools receive credentials in argv; restrict local process inspection to trusted
users. Setup/config files remain private device state.

The existing relay selection (account key or manual stream ID), sender executable,
IP list, capability-gated bind-map arguments, control socket and per-link telemetry
are reused. Receiver settings are snapshotted at listener startup: restart the
backend while idle to change them. RIST is refused. This listener replaces the
legacy SRT-to-engine ingest, so there is only one owner of port 4000. Keep any
image-baked gateway off that address/port. Encoder use remains available when the
forwarder is disconnected; an active forwarder holds the common lifecycle lease
and common bond/telemetry ownership exclusively. The forwarder uses a separate
loopback sender port (normal sender port + 1), so a refused phone cannot feed an
encoder sender that is already running. Recovery and update admission run before each
sender launch; a refused launch remains unknown and requires the phone to reconnect.

The sender starts after authenticated phone acceptance and stops immediately on
disconnect. There is no warm-sender grace: common bond ownership becomes available
for a normal stream. Network changes publish through the normal bond writer and
reload only the owned sender PID. Process failures are observed, never respawned
in-process; service supervision remains the restart authority.

`carryingTracker` owns all hysteresis. `srt-forward` first registers unknown;
active requires publisher connected AND owned sender alive. Disconnect/intentional
stop reports false immediately; a process/status fault reports unknown. The central
120-second hold remains active after disconnect/fault; a fault never ages into idle.
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
si una fuente falla, su estado queda desconocido y no autoriza cambios que corten
el tráfico. Las pruebas son locales y no califican el hardware ni una red móvil.
