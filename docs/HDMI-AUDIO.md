# HDMI startup

If the receiver reports no HDMI signal through its DV timings, start asks you
to check that the camera is on and the cable is connected, then retry. If the
audio card is missing, reconnect it or choose another audio input. Unsupported
or unreadable timing queries preserve the engine's own admission behavior.

With a valid video signal, a source without HDMI audio may stream silence.
Check the source's HDMI PCM audio setting or choose another audio input. Valid
silent PCM is accepted; audio level is never treated as proof of device loss.
The device image selects the HDMI receiver's PipeWire profile automatically.

# Inicio con HDMI

Si el receptor indica que no hay señal HDMI mediante sus tiempos de video, el
inicio te pide comprobar que la cámara esté encendida y el cable esté conectado,
y volver a intentarlo. Si falta la tarjeta de audio, vuelve a conectarla o elige
otra entrada. Si no se pueden consultar los tiempos, se mantiene la validación
del motor de transmisión.

Con una señal de video válida, una fuente sin audio HDMI puede transmitir
silencio. Comprueba que la fuente envíe audio PCM por HDMI o elige otra entrada.
Se acepta PCM válido aunque esté en silencio; el nivel de audio no indica que
se haya perdido el dispositivo. La imagen selecciona el perfil de PipeWire del
receptor HDMI automáticamente.

## Engine cleanup after a no-signal start

Reproduction on a receiver with its audio profile enabled:

1. Keep the HDMI capture device enumerated but remove the source signal.
2. Start HDMI capture with HDMI audio selected.
3. The engine reports `capture_source_unavailable` with cause `no_signal`.
4. Reconnect a valid source and Start again.

Observed: the next Start can return `start_cleanup_timeout` in the connect
phase; an acknowledged Stop does not always clear it. Engine restart can be
required. This is a separate engine cleanup defect. The application preflight
recognizes both ENOLINK and ENOLCK timing-query refusals and prevents entering
that failing start path. It does not claim to repair engine teardown.
