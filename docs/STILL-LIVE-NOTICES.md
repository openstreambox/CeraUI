# Still-live input notices

A stopped camera input is distinct from a stopped stream. The existing capture
resilience path continues to own camera failover and standby; its notice now says
that the stream remains live and viewers see the standby screen. Its notification
also holds for five seconds, cancelling on recovery. The frame-health
path adds a five-second hold before a persistent camera notice, with HDMI,
network-camera and generic connection guidance. The cockpit's existing frame-loss
banner uses the same hold and copy. Network sources are not assumed to use Wi-Fi.
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
can use this detector. It accepts suppression explicitly and tests it for mute,
BRB and privacy. No copy claims that standby takes the stream off air.

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
