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
zona térmica que marca exactamente 0, cuenta como no disponible; el parser del
supervisor usa el mismo rango. Una sola lectura fallida pausa el tiempo de
enfriamiento sin reiniciarlo; más de 5 s sin una lectura válida lo reinicia. Un
cambio que el motor no confirma se reporta sin afirmar que se aplicó; se
reintenta tras 5 s, duplicando hasta 60 s, y se registra una sola vez. Cualquier
envío confirmado del límite de la sesión, también el que sigue a tu propio
cambio de bitrate, quita ese aviso y la espera.

Si la transmisión sobrevivió a un reinicio del backend, el reinicio a tu máximo
se reintenta con la misma espera aunque la temperatura no esté disponible,
porque solo repite tu propio máximo. Mantener calidad, si lo activas mientras
otro cambio está en curso, se aplica en cuanto ese cambio responde.

Esta versión usa la lectura real del SoC y solo cambia el límite de bitrate.
El parser del supervisor OSB1 tiene pruebas con datos de ejemplo; todavía no hay
conexión con el supervisor. No cambia radios, ventiladores, alimentación ni
resolución. El ahorro térmico real aún necesita mediciones de hardware.

El parser acepta los nuevos campos del supervisor e ignora claves futuras
desconocidas. Si hay un campo CRC-16/CCITT-FALSE al final, verifica los bytes
exactos anteriores a ese campo. Las líneas antiguas sin CRC siguen siendo
compatibles; el futuro transporte deberá exigir un checksum verificado antes
de confiar en hardware recién conectado. Esta versión no instala ese transporte.

## Temperatura del módem y enlaces de reserva

Durante una transmisión, la temperatura del RM520N-GL se lee cada diez segundos
con AT+QTEMP (solo lectura) a través de mmcli. Valores fuera de −20…125 °C no
cuentan.

**Límite: ModemManager estándar no responde a `mmcli --command`.** Solo acepta
comandos AT si el servicio corre con `--debug`. Si no, el panel dice "La
temperatura del módem no está disponible en este equipo. Los ajustes por calor
usan la temperatura del SoC." y la lectura se vuelve a intentar cada diez
minutos.

Un módem que dio lecturas y deja de darlas impide la reversión; uno
desconectado no. Un valor imposible de un módem nunca pausa la protección por
calor del SoC.

Un módem de reserva puede quedar en reposo solo en memoria, después de que el
motor aplicó el límite de bitrate y si otros dos enlaces sanos tienen al menos
30% de capacidad libre conocida. Esta versión no tiene fuente de capacidad, así
que ningún enlace entra en reposo. El enlace vuelve en cuanto sus pares pierden
ese margen, aunque un cambio de bitrate esté fallando o la conexión de control
con el motor esté caída. El panel celular lo muestra como en reposo por calor,
no como apagado por ti.
