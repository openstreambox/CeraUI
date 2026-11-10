# Guía del operador: todos los enlaces caídos

<a id="all-down-operador"></a>

Úsala si un cliente pierde internet aunque siga conectado al equipo. Consulta los detalles en [`../UPLINK_STEERING.md`](../UPLINK_STEERING.md#all-down-operator). El comportamiento existe en el código, pero falta validarlo en equipos reales. Las etiquetas del catálogo español no demuestran cobertura completa de la interfaz es-419.

## Caída, reconexión y regreso

El teléfono puede seguir asociado y el portátil puede conservar su dirección durante una caída. Eso, o un estado Activo, no demuestra acceso a internet. Cuando se aplican reglas sin un enlace seleccionable, se bloquean las conexiones IPv4 nuevas descritas en Límites. Si vuelve un enlace usable y se aplican las reglas actualizadas, intenta una conexión nueva. Abre de nuevo el navegador, la aplicación o la llamada. Una sesión abierta puede necesitar esa reconexión si el enlace falló. No se añade continuidad de sesión, cambio sin corte ni combinación de enlaces.

Un enlace que ya aparece como Caído no vuelve a estar disponible para conexiones nuevas de clientes solo por indicios pasivos de degradación, aunque recupere su dirección. La recuperación mediante observaciones satisfactorias sigue exigiendo cinco rondas exitosas consecutivas y el período de espera existente de al menos 15 segundos desde la transición de su estado de salud. Ese mínimo no garantiza el tiempo de recuperación ni se mide desde que se reconecta un cable. Los indicios pasivos de degradación reinician el conteo de éxitos parciales. No cambian la degradación normal de un enlace Activo ni el tratamiento de los portales cautivos.

Una comprobación ordinaria de la puerta de enlace vuelve a comprobar las direcciones de los candidatos, qué enlaces son aptos y la lista de candidatos después de la preparación de rutas en cola, justo antes del primer intento de cambiar una ruta. Si detecta cambios, no usa el resultado anterior y el mantenimiento habitual puede evaluar de nuevo el estado; tampoco presenta una ruta sin cambios como un éxito actual a partir de un resultado obsoleto. Tras el primer intento de cambio, la operación de rutas y cualquier reversión pueden terminar: los cambios posteriores de candidatos no las cancelan. Son comprobaciones puntuales: no mantienen fijo el estado del enlace, no rastrean reconexiones físicas ni detectan un cambio que vuelva a los mismos valores observados. No garantizan acceso a internet ni un plazo de recuperación.

**Reconexión de la interfaz web.** Cuando la interfaz reemplaza su conexión de control, ignora las actualizaciones y los eventos de estado retrasados de la conexión anterior. Sigue mostrando las actualizaciones y los errores de la conexión actual. Cuando regrese la conexión de control, confirma el acceso a internet con una nueva solicitud desde un cliente del punto de acceso; es posible que las sesiones existentes tengan que volver a conectarse.

## Compartir internet

La tarjeta incluye la política temporal de enlaces descrita abajo; sus diagnósticos siguen siendo de solo lectura. Si Zonas de clientes sigue visible y todos los enlaces están Caído, puede aparecer **Ningún enlace en buen estado**: "Todos los enlaces están caídos, así que los equipos conectados no tienen salida. La emisión no se ve afectada." Esto describe la separación del enrutado de clientes; no confirma que la emisión llegue al receptor. Las filas dicen Caído y pueden añadir "El dispositivo perdió este enlace, así que los equipos conectados ya no lo usan." El punto de acceso se llama Hotspot y el puerto, Red compartida. "Ningún dispositivo conectado" solo indica que nadie se unió. **Peso de salud (antes de la política)** es un peso de sondeo, no el reparto aplicado. Abre Diagnóstico. La limitación conocida dice que las resoluciones de nombres siguen la ruta predeterminada de este dispositivo y pueden no usar el enlace por el que se envía su tráfico. No es un resultado de DNS, y "Nada que revisar" no ejecuta una prueba.

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

## Política temporal de enlaces para clientes

En Red → Compartir internet, abre **Enlaces de internet para clientes**. Elige
**Solo cable**, **Solo celular** o **Automático**. En automático gana el número
menor (0–100); los enlaces sanos con la misma prioridad comparten los flujos
nuevos según sus pesos de salud. Por defecto todas las prioridades son cero.
Wi-Fi participa en automático. `wl*` identifica Wi-Fi, `ww*`/`ppp*`/`usb*`
celular y `eth*`/`en*` cable, según las clases de interfaces ya admitidas.

Marca una interfaz en **Dar de baja para clientes compartidos** para retirarla
solo del tráfico de clientes. No desconecta la interfaz, la administración ni la
agregación. Desmarca para permitir su retorno, sujeto a salud y selección. Los
modos forzados no usan otros tipos como respaldo. Sin enlaces permitidos, se
mantiene el bloqueo de reenvío; DHCP, DNS y la interfaz local siguen accesibles.
El DNS hacia el proveedor sigue las rutas del equipo: esta política selecciona
el reenvío IPv4, no el transporte del resolutor DNS ni IPv6.

Las API autenticadas `network.getSharingPolicy` y `network.setSharingPolicy`
leen y reemplazan la política deseada completa. Ejemplo:

```json
{"mode":"automatic","priorities":{"wired":0,"cellular":10,"wifi":20},"administrativelyDown":[]}
```

El cambio solicita inmediatamente al coordinador de direccionamiento existente,
sin esperar una consulta de NetworkManager. Usa los plazos de comandos existentes
y reintentos de 100/500 ms. Si falla al aplicar, conserva la política deseada y
publica `steering_unavailable`; recibir la política no confirma la salida real.
Revisa el estado y prueba una solicitud nueva del cliente. **Recargar política
de clientes** lee cambios de otra sesión. Las escrituras se serializan; gana la
última. No se guarda en disco: al reiniciar el backend vuelve a automático, con
prioridades iguales y sin bajas administrativas. Revisa los nombres de interfaz
tras reconectar hardware; las marcas de flujo conservan la identidad física.

Las exclusiones forzadas y bajas administrativas retiran la selección de flujos
nuevos, eliminan las entradas conntrack de esa marca y emiten
`uplink-flows-reset`. Las apps deben reconectarse. Se conservan las rutas sanas,
incluidas las reglas de origen del equipo. No se modifica la ruta predeterminada
ni las rutas de administración. La pérdida física o de salud conserva su ciclo
existente. Cambiar solo prioridades mantiene las sesiones existentes: los flujos
nuevos cambian al mejor enlace al caer o volver; los establecidos en el respaldo
siguen allí hasta terminar o hasta una exclusión/pérdida. **Peso de salud (antes
de la política)** no indica el reparto aplicado. Las pruebas de namespaces con
dos enlaces y un cliente cubren selección celular, baja, retorno y bloqueo sin
enlaces; la validación en hardware queda pendiente.

### Publicación inicial del AP y preparación

La confirmación del AP y la publicación de su dirección pueden llegar en
cualquier orden. La zona de clientes se actualiza antes del estado Wi-Fi y en
cada instantánea de red, sin depender de un segundo cambio de conexión. Hasta
verificar las reglas nft, las reglas de política y la interfaz de la ruta
predeterminada, el hotspot conserva la transición de activación y muestra
«Enrutamiento pendiente». Start confirma el éxito después de la conciliación.
Un estado aplicado sin enlaces disponibles sigue protegiendo los clientes;
la preparación no garantiza acceso a Internet.

Si desaparece la ruta predeterminada de una tabla administrada, el plan conserva
la propiedad de la regla de origen con prioridad 100. Stop y Delete eliminan
solo la combinación exacta de origen, prioridad y tabla, sin aceptar selectores
adicionales ni tablas parecidas. La prueba aislada verifica el primer paquete
marcado, la retirada de la ruta y la limpieza, conservando una regla ajena.

La verificación también se ejecuta cuando el estado deseado no cambia. Si falta
soporte en el kernel, se retira la preparación y se reintenta la aplicación.
