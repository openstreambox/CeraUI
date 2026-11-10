# Cambiar la función de un puerto Ethernet y comprobar el resultado

Abre **Configurar** en el puerto por cable que quieras cambiar. En **Función del
puerto**, elige **Enlace de subida** o **Red compartida** y luego **Guardar**
para solicitar el cambio. Elegir una opción solo prepara la selección. Guardar
envía un cambio de función únicamente si la selección es distinta de la función
que se muestra; guardar la misma función no fuerza la reparación del perfil. No
cambies a la otra función solo para forzar un nuevo intento.

**Enlace de subida** permite que el puerto participe en el enlace SRTLA. **Red
compartida** lo retira de ese enlace y solicita a NetworkManager una
configuración IPv4 compartida para clientes locales. Si el puerto transporta
tráfico de la transmisión, cambiarlo puede quitar ese ancho de banda. Cualquiera
de los cambios puede interrumpir el acceso de administración por ese puerto.
Prevé esa interrupción antes de guardar; otra conexión no garantiza la
recuperación. Son opciones manuales. La falta de respuesta DHCP no demuestra que
el enlace sea solo para clientes y este flujo no ofrece un control de dirección
automática.

## Cuando el cambio queda sin confirmar

**El cambio de función no se completó** no demuestra que nada haya cambiado ni
que se haya conservado la función física anterior. Es posible que ya se haya
creado o modificado un perfil, o que una activación haya surtido efecto antes de
perderse la respuesta. No poder confirmar un perfil utilizable también puede
deberse a una lectura no disponible, una respuesta no compatible o una interfaz
que no coincide; no demuestra que no exista un perfil guardado.

Revisa la función y la **Dirección** que informa el equipo para el puerto
correcto antes de decidir si solicitas otro cambio. La función mostrada puede
reflejar la intención guardada que se restauró; no es una prueba independiente
de la configuración activa del perfil, de una conexión a internet útil ni de la
recuperación del acceso de administración. Cerrar o volver a abrir el diálogo no
cancela una solicitud anterior. Elegir Enlace de subida y guardar un cambio
nuevo es otra solicitud, no una reversión física de la anterior.

## Cómo se recupera una nueva solicitud de Red compartida

Si una solicitud explícita de Red compartida necesita un perfil nuevo, el
backend guarda primero un identificador único de perfil (UUID) para ese puerto y
después solicita su creación. Si la respuesta se pierde o queda incierta,
conserva esa reserva. Si no hay un perfil activo, una solicitud explícita
posterior comprueba el mismo identificador, su tipo Ethernet y la interfaz a la
que está vinculado. Reutiliza un perfil válido; solo puede agregar ese mismo
identificador si una lectura correcta confirma que no existe. Una lectura no
disponible o que no coincide no autoriza otra creación. No adopta perfiles
inactivos arbitrarios, no asigna otro identificador tras una creación incierta,
no borra el perfil incierto ni repite automáticamente la solicitud de creación.

Al arrancar, la recuperación puede reutilizar un perfil propio válido que ya
exista para una selección guardada de Red compartida. No crea un perfil que
falte. Por eso, un perfil ausente o que no se puede leer puede seguir sin
resolverse; reiniciar o guardar la misma función mostrada no garantiza
repararlo.

Las reglas de orden y recuperación de perfiles están cubiertas por pruebas
deterministas con dependencias simuladas. DHCP/DNS/NAT nativos, conflictos de
subred, continuidad de administración, dos puertos y recuperación de la
transmisión siguen pendientes de validación. La generación de catálogos, las
compilaciones completas, la publicación web, la presentación de las traducciones
y el comportamiento en el navegador requieren comprobaciones aparte; esta guía
no los acredita.
