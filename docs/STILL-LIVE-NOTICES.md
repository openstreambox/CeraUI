# Still-live input notices

A stopped camera input is distinct from a stopped stream. The existing capture
resilience path continues to own camera failover and standby; its notice now says
that the stream remains live and viewers see the standby screen. Its notification
also holds for five seconds, cancelling on recovery. The frame-health
path requires two consecutive stalled heartbeat observations before a persistent
camera notice, with HDMI, network-camera and generic connection guidance. The
heartbeat is 5 s ±10%; observations must be at least 4.5 s apart and no more than
6.5 s apart (5.5 s plus 1 s scheduler allowance). Audio callbacks and timers never
count as camera observations. Two consecutive healthy observations clear it, so
one recovered tick cannot flicker an existing warning. A selection change, stream
stop or explicit suppression clears it immediately. Camera onset and recovery
normally take 4.5–11 s from the physical event, plus engine status latency. One
late sample cannot raise a warning, even with continuous program audio.

The backend persistent notice is the single frame-loss explanation on every tab;
the cockpit no longer starts its own frame-loss timer or repeats that sentence.
The standby band retains its title and actions, with the persistent notice owning
the explanation. Network sources are not assumed to use Wi-Fi.
A stalled encoded frame counter is a delivery signal, not image-content analysis:
a camera sending new frames of the same frozen picture cannot be diagnosed here.

The always-on audio bridge, independent of any preview client, feeds the silence
detector. Only samples attributed to the engine's `streaming` owner qualify;
idle-sidecar, unavailable, zero-channel and unowned samples cannot prove outgoing
silence. The program meter is before encoding, not a decoder at the receiver.
Ten seconds of continuously observed digital silence raises a persistent notice.
The shared preview-meter silence/freshness primitives live in
`@ceraui/rpc/audio-meter-liveness`; the original preview import re-exports them.
Missing or frozen readings do not establish silence. A two-second observation gap
resets the hold. Sound returning clears the notice immediately.

Selection changes restart holds. Stream stop clears notices and timers; deadlines
re-read current streaming/selection state. The `No audio` selection suppresses only
the microphone warning, so it cannot hide a camera outage. Virtual sources and
capture standby suppress both detectors. The synthetic `standby` active-input id
also suppresses them when no capture block is present. Standby retains its own
camera notice rather than stacking another camera or mic warning. Current
runtime contracts expose no separate privacy/BRB flag or live master-mute state;
future owners of those controls must supply intentional suppression before they
can use this detector. It accepts suppression explicitly; the suppression contract
is tested once. No copy claims that standby takes the stream off air.

## Operator help (English)

Camera feed stopped while still live: check the HDMI cable or the camera's network
connection. If the box reports standby, viewers see the standby screen. Sound
missing for ten seconds: check the selected microphone and its connection. An
intentional No audio selection does not raise this warning.

## Ayuda para operadores (es-419)

Si la señal de la cámara se detuvo y sigues en vivo, revisa el cable HDMI o la
conexión de red de la cámara. Si el equipo indica espera, el público ve la pantalla
de espera. Si no hay sonido durante diez segundos, revisa el micrófono seleccionado
y su conexión. Elegir Sin audio de forma intencional no genera esta advertencia.

External English/es-419 user-documentation coordination remains a release gate.

## Independent landing and catalog union

This change can land independently of #96; it does not stack on that branch.
The catalogs include the union of `network.view.connectedIdle*` and
`notifications.stillLive*` in every locale, with the still-live keys in the
notification section rather than competing for the final catalog line. A merge
probe against #96 at `ace4ef21` is conflict-free. If its translations change before
landing, retain both families and its latest connected-idle translations, then
regenerate and run catalog parity. There is no runtime dependency between the
features.
