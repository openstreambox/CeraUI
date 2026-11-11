# HDMI audio startup

When an HDMI receiver reports that audio is absent or has no sample rate,
starting with that audio input stops before capture and asks you to reconnect
it or choose another audio source. Check that the source sends HDMI PCM audio;
a video picture does not guarantee audio. Valid silent PCM is accepted.
Unsupported receiver controls retain the streaming engine's admission behavior.
Automatic PipeWire profile selection belongs to the device image.

# Inicio con audio HDMI

Si el receptor HDMI indica que no hay audio o no hay una frecuencia de muestreo,
el inicio con esa entrada se detiene antes de la captura y te pide volver a
conectarla o elegir otra fuente de audio. Comprueba que la fuente envíe audio
PCM por HDMI; tener imagen no garantiza que haya audio. Se acepta PCM válido
aunque esté en silencio. Si el receptor no admite esos controles, se mantiene
la validación del motor de transmisión. La imagen del dispositivo controla la
selección automática del perfil de PipeWire.
