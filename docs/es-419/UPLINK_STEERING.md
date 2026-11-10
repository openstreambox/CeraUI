# Guía del operador: todos los enlaces caídos

<a id="all-down-operador"></a>

Úsala si un cliente pierde internet aunque siga conectado al equipo. Consulta los detalles en [`../UPLINK_STEERING.md`](../UPLINK_STEERING.md#all-down-operator). El comportamiento existe en el código, pero falta validarlo en equipos reales. Las etiquetas del catálogo español no demuestran cobertura completa de la interfaz es-419.

## Caída, reconexión y regreso

El teléfono puede seguir asociado y el portátil puede conservar su dirección durante una caída. Eso, o un estado Activo, no demuestra acceso a internet. Cuando se aplican reglas sin un enlace seleccionable, se bloquean las conexiones IPv4 nuevas descritas en Límites. Si vuelve un enlace usable y se aplican las reglas actualizadas, intenta una conexión nueva. Abre de nuevo el navegador, la aplicación o la llamada. Una sesión abierta puede necesitar esa reconexión si el enlace falló. No se añade continuidad de sesión, cambio sin corte ni combinación de enlaces.

Un enlace que ya aparece como Caído no vuelve a estar disponible para conexiones nuevas de clientes solo por indicios pasivos de degradación, aunque recupere su dirección. La recuperación mediante observaciones satisfactorias sigue exigiendo cinco rondas exitosas consecutivas y el período de espera existente de al menos 15 segundos desde la transición de su estado de salud. Ese mínimo no garantiza el tiempo de recuperación ni se mide desde que se reconecta un cable. Los indicios pasivos de degradación reinician el conteo de éxitos parciales. No cambian la degradación normal de un enlace Activo ni el tratamiento de los portales cautivos.

Una comprobación ordinaria de la puerta de enlace vuelve a comprobar las direcciones de los candidatos, qué enlaces son aptos y la lista de candidatos después de la preparación de rutas en cola, justo antes del primer intento de cambiar una ruta. Si detecta cambios, no usa el resultado anterior y el mantenimiento habitual puede evaluar de nuevo el estado; tampoco presenta una ruta sin cambios como un éxito actual a partir de un resultado obsoleto. Tras el primer intento de cambio, la operación de rutas y cualquier reversión pueden terminar: los cambios posteriores de candidatos no las cancelan. Son comprobaciones puntuales: no mantienen fijo el estado del enlace, no rastrean reconexiones físicas ni detectan un cambio que vuelva a los mismos valores observados. No garantizan acceso a internet ni un plazo de recuperación.

**Reconexión de la interfaz web.** Cuando la interfaz reemplaza su conexión de control, ignora las actualizaciones y los eventos de estado retrasados de la conexión anterior. Sigue mostrando las actualizaciones y los errores de la conexión actual. Cuando regrese la conexión de control, confirma el acceso a internet con una nueva solicitud desde un cliente del punto de acceso; es posible que las sesiones existentes tengan que volver a conectarse.

## Compartir internet

La tarjeta solo informa: no hay interruptor, botón ni reparación. Si Zonas de clientes sigue visible y todos los enlaces están Caído, puede aparecer **Ningún enlace en buen estado**: "Todos los enlaces están caídos, así que los equipos conectados no tienen salida. La emisión no se ve afectada." Esto describe la separación del enrutado de clientes; no confirma que la emisión llegue al receptor. Las filas dicen Caído y pueden añadir "El dispositivo perdió este enlace, así que los equipos conectados ya no lo usan." El punto de acceso se llama Hotspot y el puerto, Red compartida. "Ningún dispositivo conectado" solo indica que nadie se unió. **Reparto de enrutado**, si aparece, no es un enlace usable. Abre Diagnóstico. La limitación conocida dice que las resoluciones de nombres siguen la ruta predeterminada de este dispositivo y pueden no usar el enlace por el que se envía su tráfico. No es un resultado de DNS, y "Nada que revisar" no ejecuta una prueba.

**Compartir está desactivado** significa que no hay zona. Su frase — activa el punto de acceso o pon un puerto en LAN compartida — no es un control de esta tarjeta. La zona existente se llama Red compartida. **Reparto entre enlaces no disponible** indica que los equipos usan la ruta predeterminada; lee Motivo. **Compartir está activo** cuenta enlaces que pueden llevar tráfico de clientes.

## Límites

- Actúa solo cuando sus reglas ya se aplicaron. Una demora, un rechazo o un fallo puede dejar el estado anterior. Tras un fallo parcial, el mismo regreso se vuelve a aplicar. La recuperación en un equipo no está cualificada.
- Descarta flujos IPv4 nuevos y reenviados, de una zona y prefijo registrados, si ningún enlace tiene cuota positiva seleccionable. No aísla todo el tráfico ni trata IPv6.
- El punto de acceso o la LAN compartida pueden seguir sin internet de subida. DHCP, DNS y la interfaz local quedan fuera de esta regla de reenvío; eso no prueba que funcionen.
- También bloquea flujos nuevos hacia pares en otras interfaces o zonas. Los pares del mismo enlace van aparte. El puente no está cualificado.
- La emisión que origina el dispositivo queda fuera. SRTLA y Moblink local siguen independientes: sin reescritura genérica de túnel o ruta, y sin cualificación de extremo a extremo.
- Detener el transporte del reparto quita esta protección. Las reglas restantes de NetworkManager gobiernan el reenvío. Detener o reiniciar no es una recuperación verificada.
- La cobertura de paquetes preparada no se ejecutó. Los ecos UDP 53 y 67 son de alcance, no DNS ni DHCP. Un flujo establecido retenido no simula perder todos los enlaces. Clientes reales, paquete e imagen siguen abiertos.

## Asignación inicial de la tabla de rutas

Linux informa una FIB IPv4 aún no asignada con código de salida 2 y “FIB table
does not exist”. Solo ese diagnóstico se interpreta como tabla vacía al preparar
una tabla propia. Se instala la ruta predeterminada de la interfaz antes de las
reglas por origen y marca. Otros errores conservan el rechazo y la reversión.
Esto se aplica a Ethernet, Wi-Fi y celular sin esperar una ronda de salud.
Si aún no aparece la ruta de la interfaz, el coordinador conserva sus reintentos
limitados de 100/500 ms y las notificaciones posteriores de red y salud.
El bloqueo cuando todos los enlaces están caídos y el alcance exclusivo al
tráfico reenviado de clientes no cambian. La prueba de paquetes en un espacio
de red aislado crea tablas ausentes con el planificador y gestor de producción.
