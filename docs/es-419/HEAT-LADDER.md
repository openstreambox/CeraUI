# Ajustes por calor durante una transmisión

Si el equipo está tibio, pide ventilación. El calor sostenido del SoC puede limitar
el bitrate en vivo al 75% y luego al 50% de tu máximo. El mínimo es 2 Mbit/s,
sin aumentar nunca el bitrate que elegiste. El bitrate adaptativo sigue funcionando
por debajo del límite. Abre la bolsa o busca sombra.

**Mantener calidad** quita este límite hasta que termine la transmisión. Los avisos
de calor permanecen. No anula la protección térmica del kernel ni la protección
de energía independiente. El bitrate guardado no cambia. Detener la transmisión o
reiniciar el backend borra esta política de sesión. Una pérdida breve de la
conexión de control con el motor no la borra: el límite, Mantener calidad y el
historial siguen con la misma transmisión.

Algunas fuentes no pueden bajar su bitrate (passthrough o una fuente de tasa
fija). Entonces el panel lo dice en vez de anunciar un límite.

El panel muestra un historial limitado de cambios confirmados. Si la temperatura
no está disponible, los ajustes automáticos y su reversión quedan en pausa.
Esto no indica que el equipo esté frío. Una lectura fuera de −20…125 °C, o una
zona térmica que marca exactamente 0, cuenta como no disponible. Un cambio que
el motor no confirma se reporta sin afirmar que se aplicó; se reintenta tras
5 s, duplicando hasta 60 s, y se registra una sola vez.

Esta versión usa la lectura real del SoC y solo cambia el límite de bitrate.
El parser del supervisor OSB1 tiene pruebas con datos de ejemplo; todavía no hay
conexión con el supervisor. No cambia radios, ventiladores, alimentación ni
resolución. El ahorro térmico real aún necesita mediciones de hardware.

El parser acepta los nuevos campos del supervisor e ignora claves futuras
desconocidas. Si hay un campo CRC-16/CCITT-FALSE al final, verifica los bytes
exactos anteriores a ese campo. Las líneas antiguas sin CRC siguen siendo
compatibles; el futuro transporte deberá exigir un checksum verificado antes
de confiar en hardware recién conectado. Esta versión no instala ese transporte.
